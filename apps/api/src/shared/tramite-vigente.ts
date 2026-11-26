// Épica #14707 (ADR-0049 §1 y §4) — Un trámite FLITO anulado, abortado o revocado NO EXISTE.
// Transversal: este archivo NO importa de ningún módulo (solo `db`, el esquema y shared-types), como
// `clients/cliente-operable.ts`, para que lo usen todos los módulos sin abrir ciclos.
//
//   · Predicado ÚNICO: muerto ⇔ `flito_tramites.estado = 'anulado'`; vivo ⇔ `IS DISTINCT FROM 'anulado'` (un NULL —
//     borrador, preparado— es vivo). FLIT 1 mapea Abortado/Revocado a `anulado` (0318 + `estadoEnumDesdeFlit`); la
//     sub-vigencia sale de `flit_estado` (`vigenciaTramite` de shared-types). `rechazado` NO es muerte (D1).
//   · Guard de AVANCE (D4): `exigirTramiteVivo(tx, id)` lee la fila con `FOR SHARE` dentro de la transacción de la
//     acción; choca con el UPDATE del sync (FOR UPDATE implícito), así que no hay ventana. Muerto → 409
//     `TramiteNoVigenteError` (`code: TRAMITE_NO_VIGENTE`). Las acciones de SALIDA no lo llaman.
//   · SOAT/impuesto: su vigencia es su ESTADO (`descartado`), no un trámite (un SOAT compartido sobrevive a uno de
//     sus trámites, D3b). `exigirRegistroVigente` + el trigger FL409 de la 0318.
//   · `errorHandler` mapea el error y el FL409 de la base de forma global (un router que lo olvide no da 500).
//   · El mensaje lleva el radicado FLIT (no es PII): nunca placa, VIN ni datos del titular.
import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flitoImpuestos, flitoLogisticaDocumentos, flitoTramites } from '../db/schema.js';
import { CODIGO_TRAMITE_NO_VIGENTE, vigenciaTramite, type MotivoDescarte } from '@operaciones/shared-types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type EjecutorTramite = typeof db | Tx;

/** Muerto. Función y no constante: cada consulta recibe su propio nodo SQL. */
export const TRAMITE_MUERTO = (): SQL => sql`${flitoTramites.estado} = 'anulado'`;
/** Vivo (un NULL cuenta como vivo). */
export const TRAMITE_VIVO = (): SQL => sql`${flitoTramites.estado} IS DISTINCT FROM 'anulado'`;
/** Mismo predicado para SQL crudo con alias (`alias.estado`), p. ej. en subconsultas de lote. */
export const tramiteVivoEn = (columnaEstado: SQL): SQL => sql`${columnaEstado} IS DISTINCT FROM 'anulado'`;

/**
 * Finanzas (decisión cerrada 6 del ADR-0049): en los totales el REVOCADO suma (y se marca con su `vigenciaTramite`);
 * anulado y abortado no. Mismo criterio que `vigenciaTramite` (shared-types): muerto ⇔ `estado = 'anulado'`, y la
 * sub-vigencia sale de `flit_estado` sin espacios ni mayúsculas.
 */
export const TRAMITE_SUMA_EN_FINANZAS = (): SQL =>
  sql`(${flitoTramites.estado} IS DISTINCT FROM 'anulado' OR lower(trim(COALESCE(${flitoTramites.flitEstado}, ''))) = 'revocado')`;

/** Lo mismo con alias crudo (`alias.estado`, `alias.flit_estado`), para subconsultas. */
export const sumaEnFinanzasEn = (alias: string): SQL => {
  const a = sql.identifier(alias);
  return sql`(${a}.estado IS DISTINCT FROM 'anulado' OR lower(trim(COALESCE(${a}.flit_estado, ''))) = 'revocado')`;
};

/** Para una fuente que cuelga de un trámite por `tramite_id` (derecho, servicio adicional): sin trámite, suma. */
export const sumaEnFinanzasPorTramite = (tramiteId: SQL | AnyColumn): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM flito_tramites ft_fin WHERE ft_fin.id = ${tramiteId} AND NOT ${sumaEnFinanzasEn('ft_fin')})`;

const QUE_DE: Record<'tramite' | 'soat' | 'impuesto', string> = { tramite: 'El trámite', soat: 'Este SOAT', impuesto: 'Este impuesto' };

/** 409: acción de avance sobre un trámite (o su SOAT/impuesto) que ya no existe en FLITO. */
export class TramiteNoVigenteError extends Error {
  readonly status = 409;
  readonly code = CODIGO_TRAMITE_NO_VIGENTE;
  constructor(readonly vigencia: MotivoDescarte | null, message: string) {
    super(message);
    this.name = 'TramiteNoVigenteError';
  }
  /** Cuerpo HTTP canónico (diseño §3.1). */
  cuerpo(): { error: string; code: typeof CODIGO_TRAMITE_NO_VIGENTE; vigencia?: MotivoDescarte } {
    return { error: this.message, code: this.code, ...(this.vigencia ? { vigencia: this.vigencia } : {}) };
  }
}

/** Mensaje del 409 de un trámite muerto (con el radicado, que no es PII). */
export function mensajeTramiteNoVigente(idFlit: string | null, vigencia: MotivoDescarte): string {
  const radicado = idFlit ? ` ${idFlit}` : '';
  return `El trámite${radicado} fue ${vigencia} en FLIT: en FLITO ya no admite acciones.`;
}

/** Mensaje del 409 de un SOAT o impuesto `descartado`. */
export const mensajeDescartado = (concepto: 'soat' | 'impuesto'): string =>
  `${QUE_DE[concepto]} se descartó porque su trámite ya no existe en FLITO.`;

/** Guard puro sobre una fila del trámite ya leída (y bloqueada) por quien llama: muerto → 409. Sin `estado`: vivo. */
export function exigirFilaTramiteViva(t: { estado?: string | null; flitEstado?: string | null; idFlit?: string | null }): void {
  const vigencia = vigenciaTramite(t.estado, t.flitEstado);
  if (vigencia !== 'vigente') throw new TramiteNoVigenteError(vigencia, mensajeTramiteNoVigente(t.idFlit ?? null, vigencia));
}

/**
 * Guard de avance: lee el trámite con `FOR SHARE` y lanza 409 si está muerto. No valida existencia (de eso se
 * ocupa la acción con su propio 404): un id inexistente pasa.
 */
export async function exigirTramiteVivo(ex: EjecutorTramite, tramiteId: string): Promise<void> {
  const [t] = await ex.select({ estado: flitoTramites.estado, flitEstado: flitoTramites.flitEstado, idFlit: flitoTramites.idFlit })
    .from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).for('share');
  if (!t) return;
  const vigencia = vigenciaTramite(t.estado, t.flitEstado);
  if (vigencia !== 'vigente') throw new TramiteNoVigenteError(vigencia, mensajeTramiteNoVigente(t.idFlit, vigencia));
}

/**
 * Logística (crear o avanzar traslado, actas): columnas del trámite de cada documento (LT), para añadir al SELECT
 * que la acción YA hace de sus documentos —sin una lectura más— y `exigirDocumentosVivos` sobre lo leído. Un LT sin
 * trámite pasa. Sin `FOR SHARE` del trámite: logística no tiene descarte (D8), solo se impide la acción nueva.
 */
export const COLUMNAS_TRAMITE_DE_DOCUMENTO = {
  tramiteEstado: sql<string | null>`(SELECT t.estado::text FROM flito_tramites t WHERE t.id = ${flitoLogisticaDocumentos.tramiteId})`,
  tramiteFlitEstado: sql<string | null>`(SELECT t.flit_estado FROM flito_tramites t WHERE t.id = ${flitoLogisticaDocumentos.tramiteId})`,
  tramiteIdFlit: sql<string | null>`(SELECT t.id_flit FROM flito_tramites t WHERE t.id = ${flitoLogisticaDocumentos.tramiteId})`,
};

/** 409 si algún documento leído con `COLUMNAS_TRAMITE_DE_DOCUMENTO` es de un trámite muerto. */
export function exigirDocumentosVivos(docs: ReadonlyArray<{ tramiteEstado?: string | null; tramiteFlitEstado?: string | null; tramiteIdFlit?: string | null }>): void {
  for (const d of docs) exigirFilaTramiteViva({ estado: d.tramiteEstado, flitEstado: d.tramiteFlitEstado, idFlit: d.tramiteIdFlit });
}

/** Guard de avance sobre un SOAT o impuesto ya leído: `descartado` → 409. */
export function exigirRegistroVigente(concepto: 'soat' | 'impuesto', registro: { estado: string; motivoDescarte?: MotivoDescarte | null }): void {
  if (registro.estado === 'descartado') {
    throw new TramiteNoVigenteError(registro.motivoDescarte ?? null, mensajeDescartado(concepto));
  }
}

/** Lee el estado del impuesto y aplica `exigirImpuestoVigente` (id inexistente: pasa; la acción da su 404). */
export async function exigirImpuestoVigentePorId(impuestoId: string, ex: EjecutorTramite = db): Promise<void> {
  const [imp] = await ex.select({ estado: flitoImpuestos.estado, motivoDescarte: flitoImpuestos.motivoDescarte })
    .from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  if (imp) exigirImpuestoVigente(imp);
}

/** Atajo para el impuesto (mecanismo I de la §6). */
export const exigirImpuestoVigente = (impuesto: { estado: string; motivoDescarte?: MotivoDescarte | null }): void =>
  exigirRegistroVigente('impuesto', impuesto);

/** ERRCODE del trigger `flito_descartado_terminal` (0318). Drizzle envuelve el error de postgres-js en `cause`. */
export const ERRCODE_DESCARTADO = 'FL409';
export function esErrorDescartado(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === ERRCODE_DESCARTADO || e?.cause?.code === ERRCODE_DESCARTADO;
}
