// FLITO Logística — escaneo y validación de la LT (HU #14108, ADR-0030 §11). Ver cabecera del service.
//
// HU #14348 (ADR-0039 §8): el escaneo decide ANTES de escribir. `resolverEscaneo`, sin escrituras, es la decisión única
// de `escanearLt` y `validarLt`. Las dos consultas iniciales corren siempre: la LT por número, global porque no se debe
// duplicar una LT física ajena, y los trámites de la placa, con el alcance y «gestionable» EN EL WHERE. Lo que no se
// puede gestionar responde siempre lo mismo (`noEncontrado`): HTTP 200, sin escribir, y el motivo real solo a auditoría.

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { EstadoDocumentoLogistica, MENSAJE_LT_NO_ENCONTRADA, parseLicenciaTransito } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaDocumentos, flitoTramites, organismosTransitoConfig, vehicles } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { LT, LogisticaError, aprobadoSql, bloquearCompania, insertarEvento, log, normPlaca, transicionar, type DbOrTx, type LogisticaCtx } from './flito-logistica.base.js';
import { condicionDocumentosLogistica, condicionTramitesLogistica } from './flito-logistica.alcance.js';

// ── Escaneo de la LT (mensajero en el organismo) ─────────────────────────────
// HU #14142 (ADR-0030 §17.2): la LT pertenece al VEHÍCULO; el trámite se identifica al escanear. Se buscan
// los trámites aprobados del vehículo SIN LT (candidatos): 0 → rechazo; 1 → se usa; varios → `elegir_tramite`
// (no crea nada) y el mensajero reenvía con `tramiteId` o `dejarPendiente`. `duplicado` = el trámite ya tiene
// LT o el mismo `numeroLicencia` ya está registrado; la regla «una LT viva por vehículo» NO existe.

export interface CandidatoTramite { tramiteId: string; idFlit: string; companiaNombre: string | null; organismoCodigo: string | null }

/** Por qué no se encontró. Solo para `audit().detail`: nunca viaja en la respuesta. */
export type MotivoNoEncontrado = 'inexistente' | 'fuera_de_alcance' | 'no_gestionada' | 'lt_ajena';

export interface OpcionesEscaneo {
  tramiteId?: string; dejarPendiente?: boolean; organismoCodigo?: string;
  /** Entrega el motivo real a quien audita, sin ponerlo en la respuesta. */
  alNoEncontrar?: (motivo: MotivoNoEncontrado) => void;
}

export interface ResultadoEscaneo {
  resultado: 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'elegir_tramite';
  documentoId?: string;
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
  candidatos?: CandidatoTramite[];
  pendienteTramite?: boolean;
  /** HU #14147 (ADR-0030 §17): organismo y compañía del trámite resuelto; pendiente de trámite → organismo con que se creó y compañía null. */
  organismoCodigo?: string | null; companiaNombre?: string | null;
}

const SIN_PENDIENTE = 'El vehículo no tiene un trámite aprobado pendiente de LT.';

/** Ingreso manual de la LT (sin código de barras): placa + n.º de licencia (frente) + n.º de sustrato «LT…» (reverso). */
export interface EntradaManual { placa: string; numeroLicencia: string; numeroLt: string }

/** Lectura común a ambos modos (PDF417 o manual): lo único que cambia es de dónde sale. VIN null = no se compara. */
export interface Lectura {
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

/** Único constructor de «no encontrado» (§8.3): solo lo que el usuario envió o lo que trae el código que tiene en la mano. */
const noEncontrado = (l: Lectura) => ({
  resultado: 'sin_match' as const, motivo: MENSAJE_LT_NO_ENCONTRADA,
  placa: l.placa, vin: l.vin ?? '', numeroLicencia: l.numeroLicencia, propietarioNombre: l.propietarioNombre,
});

type FilaTramite = {
  tramiteId: string; idFlit: string; organismoCodigo: string | null; companiaId: number | null; companiaNit: string | null;
  companiaNombre: string | null; vehiculoId: number; vin: string | null; docId: string | null;
  organismoNombre: string | null; marca: string | null; linea: string | null; modelo: number | null;
};

const dePlaca = (placa: string): SQL => sql`upper(replace(${vehicles.plate}, '-', '')) = ${placa}`;

/**
 * Trámites APROBADOS y GESTIONABLES del vehículo (por placa), dentro del alcance, con el id de su LT si ya la tienen.
 * Un trámite sin compañía sigue en la lista: Operaciones recibe su mensaje específico (§8.4).
 */
async function tramitesDelVehiculo(placa: string, alcance: AlcanceResuelto): Promise<FilaTramite[]> {
  return db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit, companiaNombre: clients.name,
    vehiculoId: flitoTramites.vehiculoId, vin: vehicles.vin,
    docId: flitoLogisticaDocumentos.id,
    organismoNombre: organismosTransitoConfig.alias, marca: vehicles.brand, linea: vehicles.model, modelo: vehicles.year,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, LT)))
    .where(and(aprobadoSql, dePlaca(placa), sql`NOT coalesce(${clients.logisticaAutogestionable}, false)`, condicionTramitesLogistica(alcance)));
}

/** Solo para el motivo de auditoría: ¿hay trámites aprobados de la placa, aunque no se puedan gestionar? */
async function hayTramitesAprobados(placa: string): Promise<boolean> {
  const [f] = await db.select({ id: flitoTramites.id }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id)).where(and(aprobadoSql, dePlaca(placa))).limit(1);
  return !!f;
}

const datosTramite = (f: FilaTramite) => ({ organismoCodigo: f.organismoCodigo, companiaNombre: f.companiaNombre });

const aCandidato = (f: FilaTramite): CandidatoTramite => ({
  tramiteId: f.tramiteId, idFlit: f.idFlit, companiaNombre: f.companiaNombre, organismoCodigo: f.organismoCodigo,
});

/** La LT con ese número, de cualquier compañía: `propia` dice si está en el alcance. Solo lectura. */
async function ltConNumeroLicencia(exec: DbOrTx, numeroLicencia: string, alcance: AlcanceResuelto) {
  const cond = condicionDocumentosLogistica(alcance);
  const [d] = await exec.select({
    id: flitoLogisticaDocumentos.id, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo, companiaNombre: clients.name,
    propia: cond ? sql<boolean>`(${cond})` : sql<boolean>`true`,
  }).from(flitoLogisticaDocumentos).leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
    .where(and(eq(flitoLogisticaDocumentos.tipo, LT), eq(flitoLogisticaDocumentos.numeroLicencia, numeroLicencia))).limit(1);
  return d;
}

type LtPrevia = NonNullable<Awaited<ReturnType<typeof ltConNumeroLicencia>>>;
type Campos = Omit<ResultadoEscaneo, 'placa' | 'vin' | 'numeroLicencia' | 'propietarioNombre'>;

type Resolucion =
  | { kind: 'no_encontrado'; motivo: MotivoNoEncontrado }
  | { kind: 'previa'; previa: LtPrevia }
  | { kind: 'fin'; r: Campos }
  | { kind: 'tramite'; t: FilaTramite }
  | { kind: 'pendiente'; candidatos: FilaTramite[] };

/** Qué trámite corresponde entre los que este usuario puede gestionar. */
function decidir(filas: FilaTramite[], opc: OpcionesEscaneo, alcance: AlcanceResuelto): Resolucion {
  const elegir = (t: FilaTramite): Resolucion => {
    if (!t.companiaId) return { kind: 'fin', r: { resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' } };
    if (!t.organismoCodigo) return { kind: 'fin', r: { resultado: 'sin_match', idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' } };
    return { kind: 'tramite', t };
  };
  if (opc.tramiteId) {
    const t = filas.find((f) => f.tramiteId === opc.tramiteId);
    if (!t) return { kind: 'no_encontrado', motivo: 'inexistente' };
    if (t.docId) return { kind: 'fin', r: { resultado: 'duplicado', documentoId: t.docId, idFlit: t.idFlit, ...datosTramite(t), motivo: 'Este trámite ya tiene su LT registrada.' } };
    return elegir(t);
  }
  const cand = filas.filter((f) => !f.docId);
  if (!cand.length) return { kind: 'fin', r: { resultado: 'sin_match', motivo: SIN_PENDIENTE } };
  if (cand.length === 1) return elegir(cand[0]);
  // Pendientes, solo Operaciones (R20): la ruta ya exigió la función.
  if (opc.dejarPendiente && alcance.enlace === 'ninguno') return { kind: 'pendiente', candidatos: cand };
  return { kind: 'fin', r: { resultado: 'elegir_tramite', candidatos: cand.map(aCandidato), motivo: 'El vehículo tiene varios trámites aprobados sin LT: elige a cuál corresponde.' } };
}

/**
 * La decisión del escaneo, sin escrituras (§8.2). La comparten `escanearLt` y `validarLt`. El número de LT se completa
 * después, y solo si la LT resulta ser del alcance.
 */
export async function resolverEscaneo(l: Lectura, opc: OpcionesEscaneo, alcance: AlcanceResuelto): Promise<Resolucion> {
  const previa = await ltConNumeroLicencia(db, l.numeroLicencia, alcance);
  const filas = await tramitesDelVehiculo(l.placa, alcance);
  if (previa) return previa.propia ? { kind: 'previa', previa } : { kind: 'no_encontrado', motivo: 'lt_ajena' };
  if (filas.length) return decidir(filas, opc, alcance);
  if (!await hayTramitesAprobados(l.placa)) return { kind: 'no_encontrado', motivo: 'inexistente' };
  return { kind: 'no_encontrado', motivo: alcance.enlace === 'ninguno' ? 'no_gestionada' : 'fuera_de_alcance' };
}

const esUnica23505 = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === '23505' || x?.cause?.code === '23505';
};

/**
 * Registra la recogida de una LT desde su código PDF417. Empareja por PLACA (la llave) contra los trámites
 * aprobados del vehículo sin LT; el VIN valida el resto. Coincide → 'recogido' + auto clasificación (CA-03).
 * VIN distinto → 'novedad' (RN-04). Sin trámite gestionable → 'sin_match', sin escribir. Idempotente: el mismo
 * `numeroLicencia` o un trámite que ya tiene LT → 'duplicado'. El n.º de LT llega por `numeroLt`.
 */
export async function escanearLt(entrada: string | EntradaManual, numeroLt: string | null, evidencia: { lat?: string | null; lng?: string | null }, ctx: LogisticaCtx, opc: OpcionesEscaneo = {}): Promise<ResultadoEscaneo> {
  const p = leer(entrada, numeroLt);
  const placa = p.placa;
  let vin = p.vin ?? '';
  const base = () => ({ placa, vin, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre });
  const ltDuplicada = (previa: LtPrevia): ResultadoEscaneo => ({ ...base(), resultado: 'duplicado', documentoId: previa.id, organismoCodigo: previa.organismoCodigo, companiaNombre: previa.companiaNombre, motivo: 'Esta LT ya fue registrada.' });
  const sinEncontrar = (motivo: MotivoNoEncontrado): ResultadoEscaneo => { opc.alNoEncontrar?.(motivo); return noEncontrado(p); };

  const d = await resolverEscaneo(p, opc, ctx.alcance);
  if (d.kind === 'no_encontrado') return sinEncontrar(d.motivo);
  // Reescaneo de la misma LT física: no crea ni ofrece otro trámite. Ya decidido, se completa el número.
  if (d.kind === 'previa') {
    await completarNumeroLt(d.previa.id, p.numeroLt);
    return ltDuplicada(d.previa);
  }
  if (d.kind === 'fin') {
    if (d.r.resultado === 'duplicado' && d.r.documentoId) await completarNumeroLt(d.r.documentoId, p.numeroLt);
    return { ...base(), ...d.r };
  }
  const pendiente = d.kind === 'pendiente';
  const t: FilaTramite | null = d.kind === 'tramite' ? d.t : null;
  const candidatosPend: FilaTramite[] = d.kind === 'pendiente' ? d.candidatos : [];
  const fila0: FilaTramite = t ?? candidatosPend[0];
  const vinVehiculo = fila0.vin;
  if (!p.vin) vin = (vinVehiculo ?? '').toUpperCase(); // modo manual: el VIN es el del vehículo (no hay código que comparar)

  let organismoCodigo: string | null;
  if (t) {
    organismoCodigo = t.organismoCodigo;
  } else {
    const comunes = new Set(candidatosPend.map((c) => c.organismoCodigo));
    organismoCodigo = opc.organismoCodigo ?? (comunes.size === 1 ? [...comunes][0] : null);
    if (!organismoCodigo) throw new LogisticaError('Indica el organismo de tránsito para dejar la LT pendiente de trámite.');
  }

  const vinCoincide = p.manual || vin === (vinVehiculo ?? '').toUpperCase();
  const estado = vinCoincide ? EstadoDocumentoLogistica.RECOGIDO : EstadoDocumentoLogistica.NOVEDAD;
  const motivo = vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del ${pendiente ? 'vehículo' : 'trámite'} (${vinVehiculo ?? '—'}).`;

  let salida: { documentoId?: string; duplicado: boolean; previa?: LtPrevia };
  try {
    salida = await db.transaction(async (tx) => {
      // HU #14348 (AC7, §8.6): dos escaneos del mismo número se turnan y el segundo ve al primero. Sin índice único, a
      // propósito: datos viejos con números repetidos convertirían la migración en una parada de rollout.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`flito-lt-${p.numeroLicencia}`}))`);
      const previa = await ltConNumeroLicencia(tx, p.numeroLicencia, ctx.alcance);
      if (previa) {
        if (previa.propia && p.numeroLt?.trim()) {
          await tx.update(flitoLogisticaDocumentos).set({ numeroLt: p.numeroLt.trim(), updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, previa.id));
        }
        return { duplicado: true, previa };
      }
      // HU #14346 (AC1 y AC2): el dueño se lee aquí, con el cliente `FOR SHARE`; la pendiente queda sin dueño.
      const proveedorLogisticaId = t ? await bloquearCompania(tx, t.companiaId!) : null;
      const [creado] = await tx.insert(flitoLogisticaDocumentos).values({
        tramiteId: t?.tramiteId ?? null, tipo: LT, estado,
        organismoCodigo: organismoCodigo!, companiaId: t?.companiaId ?? null, companiaNit: t?.companiaNit ?? null,
        vehiculoId: fila0.vehiculoId, identificador: placa,
        numeroLicencia: p.numeroLicencia, numeroLt: p.numeroLt,
        propietarioNombre: p.propietarioNombre, propietarioDocumento: p.propietarioDocumento,
        combustible: p.combustible, motivo, flitRaw: p.flitRaw, proveedorLogisticaId,
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

      const payloadRecogida: Record<string, unknown> | null = pendiente && p.manual
        ? { pendienteTramite: true, origen: 'manual' }
        : pendiente ? { pendienteTramite: true }
        : p.manual ? { origen: 'manual' }
        : null;
      await insertarEvento(tx, { id: creado.id, estado: null }, estado, ctx, {
        lat: evidencia.lat ?? null, lng: evidencia.lng ?? null, motivo, origen: 'usuario',
        tipo: 'recogida', payload: payloadRecogida,
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

  if (salida.previa) return salida.previa.propia ? ltDuplicada(salida.previa) : sinEncontrar('lt_ajena');

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
  resultado: 'relacionada' | 'novedad' | 'sin_match' | 'ya_registrada' | 'elegir_tramite';
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
  candidatos?: CandidatoTramite[];
  organismoCodigo?: string | null; companiaNombre?: string | null; // HU #14147
}

/**
 * Valida una LT contra los trámites aprobados SIN cambiar ningún estado (el mensajero escanea en lote y
 * nada se registra hasta «Confirmar recogida»). Misma decisión que `escanearLt`: 'relacionada', 'novedad',
 * 'sin_match', 'ya_registrada' (solo para lo propio) o 'elegir_tramite' (varios candidatos).
 */
export async function validarLt(entrada: string | EntradaManual, alcance: AlcanceResuelto): Promise<ResultadoValidacion> {
  const p = leer(entrada, null);
  const placa = p.placa;
  let vin = p.vin ?? '';
  const base = () => ({ placa, vin, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre });

  const d = await resolverEscaneo(p, {}, alcance);
  if (d.kind === 'no_encontrado') return noEncontrado(p);
  if (d.kind === 'previa') return { ...base(), resultado: 'ya_registrada', organismoCodigo: d.previa.organismoCodigo, companiaNombre: d.previa.companiaNombre, motivo: 'Esta LT ya fue registrada.' };
  if (d.kind === 'fin') {
    const { resultado, ...resto } = d.r;
    return { ...base(), ...resto, resultado: resultado === 'duplicado' ? 'ya_registrada' : (resultado as ResultadoValidacion['resultado']) };
  }
  // Sin `dejarPendiente` no hay rama de pendiente: varios candidatos ya salieron como `elegir_tramite`.
  const t = (d as { t: FilaTramite }).t;
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
 * Trámites APROBADOS y gestionables del vehículo (por placa) que todavía no tienen LT, para que el mensajero que
 * ingresa la LT a mano confirme a cuál corresponde. Mismo universo que el escaneo. Sin resultado, por el motivo que
 * sea → `{encontrado:false}` (no 404), y la web pinta `MENSAJE_LT_NO_ENCONTRADA`. La placa llega por body y no se registra.
 */
export async function consultarVehiculo(placaCruda: string, alcance: AlcanceResuelto): Promise<ResultadoConsulta> {
  const cand = (await tramitesDelVehiculo(normPlaca(placaCruda), alcance)).filter((f) => !f.docId);
  if (!cand.length) return { encontrado: false };
  return {
    encontrado: true,
    candidatos: cand.map((f) => ({ ...aCandidato(f), vin: f.vin, organismoNombre: f.organismoNombre, vehiculo: { marca: f.marca, linea: f.linea, modelo: f.modelo } })),
  };
}
