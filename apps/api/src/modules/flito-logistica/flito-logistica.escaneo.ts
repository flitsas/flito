// FLITO Logística — escaneo y validación de la LT (HU #14108, ADR-0030 §11). Ver cabecera del service.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { EstadoDocumentoLogistica, parseLicenciaTransito } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaDocumentos, flitoLogisticaEventos, flitoTramites, organismosTransitoConfig, vehicles } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { LT, LogisticaError, aprobadoSql, log, normPlaca, transicionar, type LogisticaCtx } from './flito-logistica.base.js';

// ── Escaneo de la LT (mensajero en el organismo) ─────────────────────────────
// HU #14142 (ADR-0030 §17.2): la LT pertenece al VEHÍCULO; el trámite se identifica al escanear. Se buscan
// los trámites aprobados del vehículo SIN LT (candidatos): 0 → rechazo; 1 → se usa; varios → `elegir_tramite`
// (no crea nada) y el mensajero reenvía con `tramiteId` o `dejarPendiente`. `duplicado` = el trámite ya tiene
// LT o el mismo `numeroLicencia` ya está registrado; la regla «una LT viva por vehículo» NO existe.

export interface CandidatoTramite { tramiteId: string; idFlit: string; companiaNombre: string | null; organismoCodigo: string | null; gestionable: boolean }

export interface OpcionesEscaneo { tramiteId?: string; dejarPendiente?: boolean; organismoCodigo?: string }

export interface ResultadoEscaneo {
  resultado: 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'no_gestionable' | 'elegir_tramite';
  documentoId?: string;
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
  candidatos?: CandidatoTramite[];
  pendienteTramite?: boolean;
  /** HU #14147 (ADR-0030 §17): organismo y compañía del trámite resuelto; pendiente de trámite → organismo con que se creó y compañía null. */
  organismoCodigo?: string | null; companiaNombre?: string | null;
}

const SIN_PENDIENTE = 'El vehículo no tiene un trámite aprobado pendiente de LT.';
const SIN_TRAMITE = 'No hay ningún trámite aprobado con esta placa.';
const AUTOGESTION = 'La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona.';

/** Ingreso manual de la LT (sin código de barras): placa + n.º de licencia (frente) + n.º de sustrato «LT…» (reverso). */
export interface EntradaManual { placa: string; numeroLicencia: string; numeroLt: string }

/** Lectura común a ambos modos (PDF417 o manual): lo único que cambia es de dónde sale. VIN null = no se compara. */
interface Lectura {
  placa: string; vin: string | null; numeroLicencia: string; numeroLt: string | null; manual: boolean;
  propietarioNombre: string | null; propietarioDocumento: string | null; combustible: string | null; fotoBase64: string | null; flitRaw: unknown;
}

function leer(entrada: string | EntradaManual, numeroLt: string | null): Lectura {
  if (typeof entrada !== 'string') {
    const lt = entrada.numeroLt.trim().toUpperCase();
    if (!/^LT/.test(lt) || lt.length < 3) throw new LogisticaError('El número de sustrato del reverso debe empezar por «LT».', 422, { code: 'NUMERO_LT_SIN_PREFIJO' });
    const nl = entrada.numeroLicencia.trim();
    if (!nl) throw new LogisticaError('Falta el número de licencia.', 422, { code: 'NUMERO_LICENCIA_REQUERIDO' });
    return { placa: normPlaca(entrada.placa), vin: null, numeroLicencia: nl, numeroLt: lt, manual: true, propietarioNombre: null, propietarioDocumento: null, combustible: null, fotoBase64: null, flitRaw: { manual: true } };
  }
  const p = parseLicenciaTransito(entrada);
  if (!p) throw new LogisticaError('No se pudo leer el código de la licencia. Reintenta el escaneo.');
  return {
    placa: normPlaca(p.placa), vin: p.vin.toUpperCase(), numeroLicencia: p.numeroLicencia, numeroLt: numeroLt?.trim() || null, manual: false,
    propietarioNombre: p.propietarioNombre, propietarioDocumento: p.propietarioDocumento, combustible: p.combustible, fotoBase64: p.fotoBase64 ?? null,
    flitRaw: { raw: entrada, parsed: { ...p, fotoBase64: p.fotoBase64 ? '<jpeg>' : null } },
  };
}

type FilaTramite = {
  tramiteId: string; idFlit: string; organismoCodigo: string | null; companiaId: number | null; companiaNit: string | null;
  companiaNombre: string | null; vehiculoId: number; vin: string | null; autogestionable: boolean | null; docId: string | null;
  organismoNombre: string | null; marca: string | null; linea: string | null; modelo: number | null;
};

/** Trámites APROBADOS del vehículo (por placa) con el id de su LT si ya la tienen. El alcance es el de la ruta (`soloSinEnlace`). */
async function tramitesDelVehiculo(placa: string): Promise<FilaTramite[]> {
  return db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit, companiaNombre: clients.name,
    vehiculoId: flitoTramites.vehiculoId, vin: vehicles.vin, autogestionable: clients.logisticaAutogestionable,
    docId: flitoLogisticaDocumentos.id,
    organismoNombre: organismosTransitoConfig.alias, marca: vehicles.brand, linea: vehicles.model, modelo: vehicles.year,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, LT)))
    .where(and(aprobadoSql, sql`upper(replace(${vehicles.plate}, '-', '')) = ${placa}`));
}

const datosTramite = (f: FilaTramite) => ({ organismoCodigo: f.organismoCodigo, companiaNombre: f.companiaNombre });

const aCandidato = (f: FilaTramite): CandidatoTramite => ({
  tramiteId: f.tramiteId, idFlit: f.idFlit, companiaNombre: f.companiaNombre, organismoCodigo: f.organismoCodigo, gestionable: !f.autogestionable,
});

async function ltConNumeroLicencia(numeroLicencia: string) {
  const [d] = await db.select({ id: flitoLogisticaDocumentos.id, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo, companiaNombre: clients.name })
    .from(flitoLogisticaDocumentos).leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
    .where(and(eq(flitoLogisticaDocumentos.tipo, LT), eq(flitoLogisticaDocumentos.numeroLicencia, numeroLicencia))).limit(1);
  return d;
}

type Decision = { kind: 'fin'; r: Omit<ResultadoEscaneo, 'placa' | 'vin'> } | { kind: 'tramite'; t: FilaTramite } | { kind: 'pendiente'; candidatos: FilaTramite[] };

/** Resuelve qué trámite corresponde (o por qué no), sin escribir. Compartida por escaneo y validación. */
function decidir(filas: FilaTramite[], opc: OpcionesEscaneo): Decision {
  if (!filas.length) return { kind: 'fin', r: { resultado: 'sin_match', motivo: SIN_TRAMITE } };
  if (opc.tramiteId) {
    const t = filas.find((f) => f.tramiteId === opc.tramiteId);
    if (!t) return { kind: 'fin', r: { resultado: 'sin_match', motivo: SIN_TRAMITE } };
    if (t.docId) return { kind: 'fin', r: { resultado: 'duplicado', documentoId: t.docId, idFlit: t.idFlit, ...datosTramite(t), motivo: 'Este trámite ya tiene su LT registrada.' } };
    return { kind: 'tramite', t };
  }
  const cand = filas.filter((f) => !f.docId);
  if (!cand.length) return { kind: 'fin', r: { resultado: 'sin_match', motivo: SIN_PENDIENTE } };
  if (cand.length === 1) return { kind: 'tramite', t: cand[0] };
  if (opc.dejarPendiente) return { kind: 'pendiente', candidatos: cand };
  return { kind: 'fin', r: { resultado: 'elegir_tramite', candidatos: cand.map(aCandidato), motivo: 'El vehículo tiene varios trámites aprobados sin LT: elige a cuál corresponde.' } };
}

const esUnica23505 = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === '23505' || x?.cause?.code === '23505';
};

/**
 * Registra la recogida de una LT desde su código PDF417. Empareja por PLACA (la llave) contra los trámites
 * aprobados del vehículo sin LT; el VIN valida el resto. Coincide → 'recogido' + auto clasificación (CA-03).
 * VIN distinto → 'novedad' (RN-04). Sin trámite → 'sin_match' (no persiste). Idempotente: el mismo
 * `numeroLicencia` o un trámite que ya tiene LT → 'duplicado'. El n.º de LT llega por `numeroLt`.
 */
export async function escanearLt(entrada: string | EntradaManual, numeroLt: string | null, evidencia: { lat?: string | null; lng?: string | null }, ctx: LogisticaCtx, opc: OpcionesEscaneo = {}): Promise<ResultadoEscaneo> {
  const p = leer(entrada, numeroLt);
  const placa = p.placa;
  let vin = p.vin ?? '';
  const base = () => ({ placa, vin, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre });

  // Reescaneo de la misma LT física: no crea ni ofrece otro trámite.
  const previa = await ltConNumeroLicencia(p.numeroLicencia);
  if (previa) {
    await completarNumeroLt(previa.id, p.numeroLt);
    return { ...base(), resultado: 'duplicado', documentoId: previa.id, organismoCodigo: previa.organismoCodigo, companiaNombre: previa.companiaNombre, motivo: 'Esta LT ya fue registrada.' };
  }

  const d = decidir(await tramitesDelVehiculo(placa), opc);
  if (d.kind === 'fin') {
    if (d.r.resultado === 'duplicado' && d.r.documentoId) await completarNumeroLt(d.r.documentoId, p.numeroLt);
    return { placa, vin, ...d.r };
  }
  const pendiente = d.kind === 'pendiente';
  const t: FilaTramite | null = d.kind === 'tramite' ? d.t : null;
  const candidatosPend: FilaTramite[] = d.kind === 'pendiente' ? d.candidatos : [];
  const fila0: FilaTramite = t ?? candidatosPend[0];
  const vinVehiculo = fila0.vin;
  if (!p.vin) vin = (vinVehiculo ?? '').toUpperCase(); // modo manual: el VIN es el del vehículo (no hay código que comparar)

  let organismoCodigo: string | null;
  if (t) {
    // Parametrización por compañía (RN-05): si la compañía autogestiona su logística, FLITO no la gestiona.
    if (t.autogestionable) return { ...base(), resultado: 'no_gestionable', idFlit: t.idFlit, ...datosTramite(t), motivo: AUTOGESTION };
    if (!t.companiaId) return { ...base(), resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' };
    if (!t.organismoCodigo) return { ...base(), resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' };
    organismoCodigo = t.organismoCodigo;
  } else {
    const comunes = new Set(candidatosPend.map((c) => c.organismoCodigo));
    organismoCodigo = opc.organismoCodigo ?? (comunes.size === 1 ? [...comunes][0] : null);
    if (!organismoCodigo) throw new LogisticaError('Indica el organismo de tránsito para dejar la LT pendiente de trámite.');
  }

  const vinCoincide = p.manual || vin === (vinVehiculo ?? '').toUpperCase();
  const estado = vinCoincide ? EstadoDocumentoLogistica.RECOGIDO : EstadoDocumentoLogistica.NOVEDAD;
  const motivo = vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del ${pendiente ? 'vehículo' : 'trámite'} (${vinVehiculo ?? '—'}).`;

  let salida: { documentoId?: string; duplicado: boolean };
  try {
    salida = await db.transaction(async (tx) => {
      const [creado] = await tx.insert(flitoLogisticaDocumentos).values({
        tramiteId: t?.tramiteId ?? null, tipo: LT, estado,
        organismoCodigo: organismoCodigo!, companiaId: t?.companiaId ?? null, companiaNit: t?.companiaNit ?? null,
        vehiculoId: fila0.vehiculoId, identificador: placa,
        numeroLicencia: p.numeroLicencia, numeroLt: p.numeroLt,
        propietarioNombre: p.propietarioNombre, propietarioDocumento: p.propietarioDocumento,
        combustible: p.combustible, motivo, flitRaw: p.flitRaw,
      }).onConflictDoNothing({ target: [flitoLogisticaDocumentos.tramiteId, flitoLogisticaDocumentos.tipo] })
        .returning({ id: flitoLogisticaDocumentos.id });

      if (!creado) {
        // Carrera: el trámite recibió su LT entre la lectura y el insert → duplicado idempotente.
        const [existente] = await tx.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
          .where(and(eq(flitoLogisticaDocumentos.tramiteId, t!.tramiteId), eq(flitoLogisticaDocumentos.tipo, LT))).limit(1);
        if (p.numeroLt && existente) {
          await tx.update(flitoLogisticaDocumentos).set({ numeroLt: p.numeroLt, updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, existente.id));
        }
        return { documentoId: existente?.id, duplicado: true };
      }

      await tx.insert(flitoLogisticaEventos).values({
        documentoId: creado.id, estadoAnterior: null, estadoNuevo: estado, actorId: ctx.userId,
        lat: evidencia.lat ?? null, lng: evidencia.lng ?? null, motivo, origen: 'usuario',
        ...(pendiente || p.manual ? { tipo: 'recogida_organismo', payload: { ...(pendiente ? { pendienteTramite: true } : {}), ...(p.manual ? { origen: 'manual' } : {}) } } : {}),
      });
      // Clasificación automática: la empresa destino ya vive en el trámite (CA-03), si el VIN cuadra. Un pendiente no la tiene.
      if (vinCoincide && t) {
        await transicionar(tx, { id: creado.id, estado }, EstadoDocumentoLogistica.CLASIFICADO, ctx, { origen: 'api' });
      }
      return { documentoId: creado.id, duplicado: false };
    });
  } catch (e) {
    // Doble pendiente del mismo vehículo (uq_flito_log_doc_vehiculo_pendiente) → respuesta controlada, no 500.
    if (pendiente && esUnica23505(e)) {
      const [ya] = await db.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
        .where(and(eq(flitoLogisticaDocumentos.vehiculoId, fila0.vehiculoId), eq(flitoLogisticaDocumentos.tipo, LT), isNull(flitoLogisticaDocumentos.tramiteId))).limit(1);
      return { ...base(), resultado: 'duplicado', documentoId: ya?.id, pendienteTramite: true, organismoCodigo, companiaNombre: null, motivo: 'Este vehículo ya tiene una LT pendiente de trámite.' };
    }
    throw e;
  }

  // Foto del propietario embebida en el código (best-effort, fuera de la transacción).
  if (salida.documentoId && !salida.duplicado && p.fotoBase64) {
    try {
      const key = await uploadEntityDocument('flito-logistica-lt-fotos', salida.documentoId, 'foto.jpg', Buffer.from(p.fotoBase64, 'base64'), 'image/jpeg');
      await db.update(flitoLogisticaDocumentos).set({ fotoStorageKey: key }).where(eq(flitoLogisticaDocumentos.id, salida.documentoId));
    } catch (e) { log.warn({ err: (e as Error).message }, 'no se pudo guardar la foto de la LT'); }
  }

  const resultado: ResultadoEscaneo['resultado'] = salida.duplicado ? 'duplicado' : (vinCoincide ? 'recogido' : 'novedad');
  return { ...base(), resultado, documentoId: salida.documentoId, idFlit: t?.idFlit, organismoCodigo, companiaNombre: t?.companiaNombre ?? null, motivo, ...(pendiente ? { pendienteTramite: true } : {}) };
}

async function completarNumeroLt(documentoId: string, numeroLt: string | null) {
  if (!numeroLt?.trim()) return;
  await db.update(flitoLogisticaDocumentos).set({ numeroLt: numeroLt.trim(), updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, documentoId));
}

// ── Validación de una LT (sin persistir) ─────────────────────────────────────

export interface ResultadoValidacion {
  resultado: 'relacionada' | 'novedad' | 'sin_match' | 'no_gestionable' | 'ya_registrada' | 'elegir_tramite';
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
  candidatos?: CandidatoTramite[];
  organismoCodigo?: string | null; companiaNombre?: string | null; // HU #14147
}

/**
 * Valida una LT contra los trámites aprobados SIN cambiar ningún estado (el mensajero escanea en lote y
 * nada se registra hasta «Confirmar recogida»). Espejo de solo lectura de escanearLt: 'relacionada',
 * 'novedad', 'sin_match', 'no_gestionable', 'ya_registrada' o 'elegir_tramite' (varios candidatos).
 */
export async function validarLt(entrada: string | EntradaManual): Promise<ResultadoValidacion> {
  const p = leer(entrada, null);
  const placa = p.placa;
  let vin = p.vin ?? '';
  const base = () => ({ placa, vin, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre });

  const previa = await ltConNumeroLicencia(p.numeroLicencia);
  if (previa) return { ...base(), resultado: 'ya_registrada', organismoCodigo: previa.organismoCodigo, companiaNombre: previa.companiaNombre, motivo: 'Esta LT ya fue registrada.' };

  const d = decidir(await tramitesDelVehiculo(placa), {});
  if (d.kind === 'fin') {
    const { resultado, ...resto } = d.r;
    return { ...base(), ...resto, resultado: resultado === 'duplicado' ? 'ya_registrada' : (resultado as ResultadoValidacion['resultado']) };
  }
  const t = (d as { t: FilaTramite }).t;
  if (t.autogestionable) return { ...base(), resultado: 'no_gestionable', idFlit: t.idFlit, ...datosTramite(t), motivo: AUTOGESTION };
  if (!t.companiaId) return { ...base(), resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' };
  if (!t.organismoCodigo) return { ...base(), resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' };

  if (!p.vin) vin = (t.vin ?? '').toUpperCase();
  const vinCoincide = p.manual || vin === (t.vin ?? '').toUpperCase();
  return {
    ...base(), resultado: vinCoincide ? 'relacionada' : 'novedad', idFlit: t.idFlit, ...datosTramite(t),
    motivo: vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del trámite (${t.vin ?? '—'}).`,
  };
}

// ── Consulta por placa (ingreso manual de la LT) ─────────────────────────────

export interface CandidatoConsulta extends CandidatoTramite {
  vin: string | null; organismoNombre: string | null;
  vehiculo: { marca: string | null; linea: string | null; modelo: number | null };
}
export type ResultadoConsulta = { encontrado: false } | { encontrado: true; candidatos: CandidatoConsulta[] };

/**
 * Trámites APROBADOS del vehículo (por placa) que todavía no tienen LT, para que el mensajero que ingresa la LT
 * a mano confirme a cuál corresponde. Mismo universo que el escaneo (aprobadoSql). Sin trámite pendiente →
 * `{encontrado:false}` (no 404). La placa llega por body y no se registra.
 */
export async function consultarVehiculo(placaCruda: string): Promise<ResultadoConsulta> {
  const cand = (await tramitesDelVehiculo(normPlaca(placaCruda))).filter((f) => !f.docId);
  if (!cand.length) return { encontrado: false };
  return {
    encontrado: true,
    candidatos: cand.map((f) => ({ ...aCandidato(f), vin: f.vin, organismoNombre: f.organismoNombre, vehiculo: { marca: f.marca, linea: f.linea, modelo: f.modelo } })),
  };
}
