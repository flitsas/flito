// FLITO Logística — base compartida (HU #14108, ADR-0030 §11): contexto, error de dominio, tipos de
// transacción, constantes y helpers que usan los demás archivos del módulo. Sin dependencias de ellos.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type EstadoDocumentoLogistica as TEstadoDoc } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoLogisticaDocumentos, flitoLogisticaEventos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

export const log = loggerFor('flito-logistica');

/**
 * HU #13425: `operaAjenas` = el usuario tiene `logistica.actas.operar_ajenas` (lo calcula la ruta con
 * `tieneFuncion`; el servicio no consulta permisos). Sin ella, solo opera SUS actas (CA-11). Ninguna
 * regla de este servicio lee el nombre del rol: `role` viaja solo como dato de auditoría.
 */
export interface LogisticaCtx { userId: number; username: string; role: string; operaAjenas: boolean }

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

export const LT = 'licencia_transito' as const;

// HU #14127: definidos en `flito-logistica.aprobado.ts` (los comparte el registro masivo de viajes); se reexportan
// aquí para que el resto del módulo siga importándolos de la base.
export { normPlaca, aprobadoSql } from './flito-logistica.aprobado.js';

/** Error de negocio con estado HTTP sugerido (lo traduce la ruta). */
export class LogisticaError extends Error {
  constructor(message: string, readonly status = 400, readonly extra?: unknown, readonly codigo?: string) { super(message); }
}

// ── Transición genérica (deja evento; sostiene CA-07/RN-04/RN-07) ────────────

export interface DocMin { id: string; estado: string }
export interface TransOpts {
  motivo?: string | null; lat?: string | null; lng?: string | null; origen?: 'api' | 'usuario';
  /** HU #14114: evento tipificado (ADR-0030). Payload solo ids/códigos, nunca PII. */
  tipo?: string | null; trasladoId?: string | null; actaId?: string | null; destino?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function transicionar(exec: DbOrTx, doc: DocMin, estadoNuevo: TEstadoDoc, ctx: LogisticaCtx, opts: TransOpts = {}): Promise<void> {
  const set: Record<string, unknown> = { estado: estadoNuevo, updatedAt: new Date() };
  if (opts.motivo !== undefined) set.motivo = opts.motivo;
  if (opts.actaId) set.actaId = opts.actaId;
  await exec.update(flitoLogisticaDocumentos).set(set).where(eq(flitoLogisticaDocumentos.id, doc.id));
  await exec.insert(flitoLogisticaEventos).values({
    documentoId: doc.id, estadoAnterior: doc.estado, estadoNuevo, actorId: ctx.userId,
    lat: opts.lat ?? null, lng: opts.lng ?? null, motivo: opts.motivo ?? null, origen: opts.origen ?? 'usuario',
    tipo: opts.tipo ?? null, trasladoId: opts.trasladoId ?? null, actaId: opts.actaId ?? null,
    destino: opts.destino ?? null, payload: opts.payload ?? null,
  });
}

/** Decodifica un dataURL (o base64 pelado) a Buffer. */
export function bufDesdeDataUrl(dataUrl: string): Buffer {
  const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}

/** ADR-0030 §17.2: una LT sin trámite resuelto no entra a un traslado, a un acta de compañía ni genera cobro. */
export class LtPendienteDeTramiteError extends LogisticaError {
  constructor(documentoIds: string[]) {
    super('Una o más LT están pendientes de trámite: resuelve el trámite antes de usarlas', 409, { documentoIds }, 'LT_PENDIENTE_DE_TRAMITE');
  }
}

/**
 * Puerta única para todo flujo que meta LT en un traslado/viaje o en un acta de compañía, FLIT o cliente:
 * lanza `LT_PENDIENTE_DE_TRAMITE` (409) si alguna tiene `tramite_id` NULL. Va ANTES de escribir o cobrar nada.
 */
export async function exigirTramiteResuelto(exec: DbOrTx, documentoIds: string[]): Promise<void> {
  if (!documentoIds.length) return;
  const pend = await exec.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
    .where(and(inArray(flitoLogisticaDocumentos.id, documentoIds), isNull(flitoLogisticaDocumentos.tramiteId)));
  if (pend.length) throw new LtPendienteDeTramiteError(pend.map((d) => d.id));
}
