// FLITO — SOAT, canal Cliente: REINTENTO manual de la consulta al RUNT de una solicitud incompleta.
// Feature #12841, HU #12998. Diseño: docs/diseno-feature-12841-solicitud-incompleta-runt.md §4 y §11;
// ADR-0019 (opción A, Aceptado).
//
// ── Los tres desenlaces (una sola unión, `ResultadoReintentoRunt`) ───────────────────────────────
//
//   · `completada`       — el RUNT responde y no bloquea (incluida la renovación anticipada de la
//     HU #12842): nace el SOAT con `id = soat_id_reservado` por el MISMO camino del alta normal
//     (`insertarSolicitudDespachada`), con el destino de la compañía leído AHORA (Q5). «Solicitado
//     por» y su fecha son del radicador; «enviado por» y el historial, de quien reintentó.
//   · `descartada`       — SOAT vigente que bloquea, toda la familia 422 (Q4) o el VIN ya ocupado por
//     un SOAT (Q3, `solicitud_existente`). La fila guarda quién, cuándo y por qué; nunca se borra.
//   · `sigue_incompleta` — el RUNT sigue caído: `intentos + 1` y la causa de la caída si se conoce.
//
// ── Concurrencia (AC6) ───────────────────────────────────────────────────────────────────────────
//
// La consulta al RUNT va FUERA de toda transacción (son segundos de red). Después, cada desenlace
// abre su transacción con `SELECT … FOR UPDATE` de la incompleta y RE-COMPRUEBA el estado: si otro
// reintento la resolvió mientras tanto, `409 incompleta_ya_resuelta { estado }` sin tocar la fila.
// El VIN ocupado se detecta dos veces, como en el alta: una lectura previa de `flito_soat` (mensaje
// barato) y el 23505 del INSERT (la base cierra la carrera); en el segundo caso la transacción del
// SOAT se revierte entera y una SEGUNDA transacción descarta la incompleta.
//
// ── Logs ────────────────────────────────────────────────────────────────────────────────────────
//
// Solo el uuid de la incompleta, la compañía y el desenlace. Ni VIN, ni placa, ni documento, ni el
// mensaje de ningún error (la causa de la caída es el vocabulario cerrado de `causaDeCaida`).

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoSoat, flitoSoatIncompletas } from '../../db/schema.js';
import {
  CodigoErrorSolicitudSoat, EstadoSoat, EstadoSolicitudIncompletaSoat,
  type MotivoDescarteSoat, type ResultadoReintentoRunt, type SoatActivoRunt,
} from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import type { SoatCtx } from './flito-soat.service.js';
import { consultarYClasificar, type CausaCaidaRunt } from './flito-soat-cliente-runt.js';
import {
  insertarSolicitudDespachada, proyectarSoatActivo, SolicitudSoatError, upsertVehiculoRunt,
  type DestinoCanalCliente, type PropietarioSolicitud,
} from './flito-soat-cliente.service.js';
import { condicionAlcance } from './flito-soat-incompletas.service.js';

const log = loggerFor('flito-soat-incompletas');

const UNIQUE_VIOLATION = '23505';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * `409 incompleta_ya_resuelta { estado }` (AC6/AC7). `runtConsultado` le dice a la ruta si el 409
 * salió DESPUÉS de consultar el RUNT (la carrera): entonces la consulta al registro nacional sí
 * ocurrió y tiene que quedar en `pii_access_log`.
 */
export class IncompletaYaResueltaError extends SolicitudSoatError {
  constructor(readonly estado: string, readonly runtConsultado: boolean, readonly vin: string) {
    super(409, CodigoErrorSolicitudSoat.INCOMPLETA_YA_RESUELTA,
      'Esta solicitud ya había cambiado de estado.', { estado });
    this.name = 'IncompletaYaResueltaError';
  }
}

/** Lo que la ruta necesita además del cuerpo del 200: el rastro de PII y la auditoría. */
export interface ReintentoHecho {
  respuesta: ResultadoReintentoRunt;
  vin: string;
  /** La placa que devolvió el RUNT (solo `completada`): el HMAC del registro del artículo 17. */
  placa: string | null;
  /** Solo `completada`: a dónde se despachó, para `audit_logs` (no viaja en el 200). */
  destino: DestinoCanalCliente | null;
}

/**
 * `POST /cliente/incompletas/:id/reintentar`. `null` = no existe o fuera del alcance del enlace
 * (la ruta responde 404, no 403, para no confirmar que el id existe).
 */
export async function reintentarIncompleta(id: string, ctx: SoatCtx): Promise<ReintentoHecho | null> {
  const alcance = condicionAlcance(ctx);
  if (alcance === null) return null;

  const [inc] = await db.select({
    id: flitoSoatIncompletas.id,
    estado: flitoSoatIncompletas.estado,
    vin: flitoSoatIncompletas.vin,
    companiaId: flitoSoatIncompletas.companiaId,
  }).from(flitoSoatIncompletas)
    .where(and(eq(flitoSoatIncompletas.id, id), alcance))
    .limit(1);
  if (!inc) return null;
  // Ya resuelta ANTES de consultar: no se gasta una consulta al RUNT (AC7).
  if (inc.estado !== EstadoSolicitudIncompletaSoat.INCOMPLETA) {
    throw new IncompletaYaResueltaError(inc.estado, false, inc.vin);
  }

  const desenlace = await consultarYClasificar(inc.vin);
  const consultadoEn = new Date();
  const base = { vin: inc.vin, placa: null, destino: null };

  switch (desenlace.clase) {
    case 'caido': {
      const causa: CausaCaidaRunt | null = desenlace.causa ?? null;
      const intentos = await cerrarIntento(inc, { ultimaCausaCaida: causa }, consultadoEn, ctx);
      log.info({ incompletaId: id, companiaId: inc.companiaId, desenlace: 'sigue_incompleta', causa },
        'Reintento RUNT de solicitud SOAT incompleta: el RUNT sigue sin responder');
      return {
        ...base,
        respuesta: { resultado: 'sigue_incompleta', intentos, ultimoIntentoRuntEn: consultadoEn.toISOString() },
      };
    }
    case 'revise':
      return { ...base, respuesta: await descartar(inc, desenlace.codigo, null, consultadoEn, ctx) };
    case 'vigente':
      return {
        ...base,
        respuesta: await descartar(inc, 'soat_vigente', proyectarSoatActivo(desenlace.soatActivo), consultadoEn, ctx),
      };
    case 'ok':
    case 'renovacion_anticipada': {
      const vigenciaProxima = desenlace.clase === 'renovacion_anticipada'
        ? { venceEl: desenlace.venceEl, ...proyectarSoatActivo(desenlace.soatActivo) }
        : null;
      const vin = desenlace.vinEfectivo;
      // RN-01 barata: el VIN ya tiene SOAT (otra solicitud se radicó mientras esta esperaba, Q3).
      const [ocupado] = await db.select({ id: flitoSoat.id }).from(flitoSoat).where(eq(flitoSoat.vin, vin)).limit(1);
      if (ocupado) return { ...base, respuesta: await descartar(inc, 'solicitud_existente', null, consultadoEn, ctx) };

      try {
        const r = await completar(inc, {
          vin, datos: desenlace.datos, organismoCodigo: desenlace.organismoCodigo, vigenciaProxima,
        }, consultadoEn, ctx);
        log.info({ incompletaId: id, companiaId: inc.companiaId, desenlace: 'completada' },
          'Reintento RUNT de solicitud SOAT incompleta: completada y despachada');
        return {
          vin: inc.vin, placa: desenlace.datos.placa, destino: r.destino,
          respuesta: { resultado: 'completada', soatId: r.soatId, estado: EstadoSoat.SOLICITADO, vigenciaProxima },
        };
      } catch (e) {
        if (!esVinOcupado(e)) throw e;
        // La transacción del SOAT ya se revirtió entera; esta es la SEGUNDA (AC4).
        return { ...base, respuesta: await descartar(inc, 'solicitud_existente', null, consultadoEn, ctx) };
      }
    }
  }
}

/**
 * El VIN (o la ficha del vehículo) ya tiene dueño: el 23505 del INSERT de `flito_soat`, o el 409
 * `vin_ya_tiene_soat` que `upsertVehiculoRunt` lanza cuando la ficha es de otra compañía. Los dos
 * significan «este vehículo ya está en FLITO» y descartan con `solicitud_existente`.
 */
function esVinOcupado(e: unknown): boolean {
  if ((e as { code?: string })?.code === UNIQUE_VIOLATION) return true;
  return e instanceof SolicitudSoatError && e.codigo === CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT;
}

interface IncompletaLeida { id: string; vin: string; companiaId: number }

/**
 * Relee la incompleta con `FOR UPDATE` DENTRO de la transacción y exige que siga `incompleta`. Es
 * el re-chequeo que cierra la carrera de dos reintentos (AC6): el segundo espera el bloqueo, relee
 * el estado nuevo y sale con 409 sin escribir nada.
 */
async function bloquearAbierta(tx: Tx, inc: IncompletaLeida) {
  const [fila] = await tx.select({
    estado: flitoSoatIncompletas.estado,
    intentos: flitoSoatIncompletas.intentos,
    soatIdReservado: flitoSoatIncompletas.soatIdReservado,
    solicitadoPorId: flitoSoatIncompletas.solicitadoPorId,
    solicitadoPorNombre: flitoSoatIncompletas.solicitadoPorNombre,
    solicitadoEn: flitoSoatIncompletas.solicitadoEn,
    facturaStorageKey: flitoSoatIncompletas.facturaStorageKey,
    facturaHash: flitoSoatIncompletas.facturaHash,
    facturaNombreArchivo: flitoSoatIncompletas.facturaNombreArchivo,
    facturaContentType: flitoSoatIncompletas.facturaContentType,
    facturaTamanoBytes: flitoSoatIncompletas.facturaTamanoBytes,
  }).from(flitoSoatIncompletas).where(eq(flitoSoatIncompletas.id, inc.id)).for('update').limit(1);
  // La fila nunca se borra; si faltara, es el mismo «ya no está por validar».
  if (!fila || fila.estado !== EstadoSolicitudIncompletaSoat.INCOMPLETA) {
    throw new IncompletaYaResueltaError(fila?.estado ?? EstadoSolicitudIncompletaSoat.DESCARTADA, true, inc.vin);
  }
  return fila;
}

/** RUNT caído otra vez: `intentos + 1` bajo el bloqueo. Devuelve el nuevo número de intentos. */
async function cerrarIntento(
  inc: IncompletaLeida, cambios: { ultimaCausaCaida: CausaCaidaRunt | null }, en: Date, ctx: SoatCtx,
): Promise<number> {
  return db.transaction(async (tx) => {
    const fila = await bloquearAbierta(tx, inc);
    const intentos = fila.intentos + 1;
    await tx.update(flitoSoatIncompletas).set({
      ...cambios, intentos, ultimoIntentoEn: en, ultimoIntentoPorId: ctx.userId, updatedAt: new Date(),
    }).where(eq(flitoSoatIncompletas.id, inc.id));
    return intentos;
  });
}

/** Descarte (AC3/AC4): quién, cuándo y por qué, bajo el bloqueo. La fila no se borra. */
async function descartar(
  inc: IncompletaLeida, motivo: MotivoDescarteSoat, soatActivo: SoatActivoRunt | null, en: Date, ctx: SoatCtx,
): Promise<ResultadoReintentoRunt> {
  await db.transaction(async (tx) => {
    const fila = await bloquearAbierta(tx, inc);
    await tx.update(flitoSoatIncompletas).set({
      estado: EstadoSolicitudIncompletaSoat.DESCARTADA,
      motivoDescarte: motivo,
      resueltaPorId: ctx.userId,
      resueltaPorNombre: ctx.username,
      resueltaEn: en,
      intentos: fila.intentos + 1,
      ultimoIntentoEn: en,
      ultimoIntentoPorId: ctx.userId,
      updatedAt: new Date(),
    }).where(eq(flitoSoatIncompletas.id, inc.id));
  });
  log.info({ incompletaId: inc.id, companiaId: inc.companiaId, desenlace: 'descartada', motivo },
    'Reintento RUNT de solicitud SOAT incompleta: descartada');
  return { resultado: 'descartada', motivo, soatActivo };
}

/**
 * Completa (AC1): vehículo con los datos del RUNT, el despacho del alta normal con `id =
 * soat_id_reservado`, el propietario re-apuntado al SOAT (conserva `soat_incompleta_id`; el
 * `padre_chk` lo admite) y la incompleta `completada`. Todo o nada.
 */
async function completar(
  inc: IncompletaLeida,
  runt: {
    vin: string;
    datos: Parameters<typeof upsertVehiculoRunt>[2];
    organismoCodigo: string | null;
    vigenciaProxima: Parameters<typeof insertarSolicitudDespachada>[1]['vigenciaProxima'];
  },
  consultadoEn: Date, ctx: SoatCtx,
): Promise<{ soatId: string; destino: DestinoCanalCliente }> {
  const ahora = new Date();
  return db.transaction(async (tx) => {
    const fila = await bloquearAbierta(tx, inc);
    const soatId = fila.soatIdReservado;

    const [p] = await tx.select({
      tipoDocumento: flitoCompradores.tipoDocumento,
      numeroDocumento: flitoCompradores.numeroDocumento,
      nombres: flitoCompradores.nombres,
      apellidos: flitoCompradores.apellidos,
      razonSocial: flitoCompradores.razonSocial,
      correo: flitoCompradores.correo,
      celular: flitoCompradores.celular,
      direccion: flitoCompradores.direccion,
      municipio: flitoCompradores.municipio,
      departamento: flitoCompradores.departamento,
    }).from(flitoCompradores).where(eq(flitoCompradores.soatIncompletaId, inc.id))
      .orderBy(flitoCompradores.orden).limit(1);
    if (!p) throw new Error(`Incompleta ${inc.id} sin propietario`);
    const propietario = p as PropietarioSolicitud;

    const vehiculoId = await upsertVehiculoRunt(
      tx, { vin: runt.vin }, runt.datos, propietario, inc.companiaId, ctx, soatId,
    );
    const destino = await insertarSolicitudDespachada(tx, {
      soatId, vin: runt.vin, vehiculoId, companiaId: inc.companiaId,
      organismoCodigo: runt.organismoCodigo, vigenciaProxima: runt.vigenciaProxima,
      consultadoEn, ahora,
      factura: {
        nombreArchivo: fila.facturaNombreArchivo, contentType: fila.facturaContentType,
        storageKey: fila.facturaStorageKey, hash: fila.facturaHash, tamanoBytes: fila.facturaTamanoBytes,
      },
      solicitante: { id: fila.solicitadoPorId, nombre: fila.solicitadoPorNombre, en: fila.solicitadoEn },
    }, ctx);

    await tx.update(flitoCompradores).set({ soatId })
      .where(eq(flitoCompradores.soatIncompletaId, inc.id));

    await tx.update(flitoSoatIncompletas).set({
      estado: EstadoSolicitudIncompletaSoat.COMPLETADA,
      soatId,
      resueltaPorId: ctx.userId,
      resueltaPorNombre: ctx.username,
      resueltaEn: ahora,
      intentos: fila.intentos + 1,
      ultimoIntentoEn: consultadoEn,
      ultimoIntentoPorId: ctx.userId,
      updatedAt: ahora,
    }).where(eq(flitoSoatIncompletas.id, inc.id));

    return { soatId, destino };
  });
}
