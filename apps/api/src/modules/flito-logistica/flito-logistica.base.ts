// FLITO Logística — base compartida (HU #14108, ADR-0030 §11): contexto, error de dominio, tipos de
// transacción, constantes y helpers que usan los demás archivos del módulo. Sin dependencias de ellos.

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { tipoEventoEfectivo, type EstadoDocumentoLogistica as TEstadoDoc } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';

export const log = loggerFor('flito-logistica');

/**
 * HU #13425: `operaAjenas` = el usuario tiene `logistica.actas.operar_ajenas` (lo calcula la ruta con
 * `tieneFuncion`; el servicio no consulta permisos). Sin ella, solo opera SUS actas (CA-11). Ninguna
 * regla de este servicio lee el nombre del rol: `role` viaja solo como dato de auditoría.
 */
export interface LogisticaCtx {
  userId: number; username: string; role: string; operaAjenas: boolean;
  /** HU #14347 y #14351 (ADR-0039 §6.4): el alcance del usuario. Con `operaAjenas`, «todas las de mi alcance». */
  alcance: AlcanceResuelto;
  /** AC10 de #14351: para registrar en `logPiiAccess` la generación del PDF que esta petición provoca. No se persiste ni se loguea. */
  req?: Request;
}

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

/**
 * Inserta un evento de bitácora. Auto-fill 1:1 de `tipo` desde estadoNuevo si `opts.tipo` no viene
 * (HU #14117). No adivina clasificado/en_flit/generado. Payload tal cual (el caller arma el literal).
 */
export async function insertarEvento(
  exec: DbOrTx, doc: { id: string; estado: string | null }, estadoNuevo: string, ctx: LogisticaCtx, opts: TransOpts = {},
): Promise<void> {
  await exec.insert(flitoLogisticaEventos).values({
    documentoId: doc.id, estadoAnterior: doc.estado, estadoNuevo, actorId: ctx.userId,
    lat: opts.lat ?? null, lng: opts.lng ?? null, motivo: opts.motivo ?? null, origen: opts.origen ?? 'usuario',
    tipo: tipoEventoEfectivo(opts.tipo ?? null, estadoNuevo),
    trasladoId: opts.trasladoId ?? null, actaId: opts.actaId ?? null,
    destino: opts.destino ?? null, payload: opts.payload ?? null,
  });
}

export async function transicionar(exec: DbOrTx, doc: DocMin, estadoNuevo: TEstadoDoc, ctx: LogisticaCtx, opts: TransOpts = {}): Promise<void> {
  const set: Record<string, unknown> = { estado: estadoNuevo, updatedAt: new Date() };
  // El motivo del documento es el de ESTA transición (o NULL): no se arrastra a estados posteriores. El historial vive en eventos.
  set.motivo = opts.motivo ?? null;
  if (opts.actaId) set.actaId = opts.actaId;
  await exec.update(flitoLogisticaDocumentos).set(set).where(eq(flitoLogisticaDocumentos.id, doc.id));
  await insertarEvento(exec, doc, estadoNuevo, ctx, opts);
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

// ── Dueño de la LT (HU #14346, ADR-0039 §6.3) ───────────────────────────────
//
// Orden de bloqueo: cliente antes que licencias. El PATCH de compañía toma el cliente `FOR UPDATE` y luego actualiza
// sus LT, así que quien ya tiene una LT bloqueada no puede pedir después el cliente: se tomaría el ciclo inverso.
// Esto incluye el FK `compania_id` de un INSERT, que pide `FOR KEY SHARE` y choca con ese `FOR UPDATE`.

/**
 * El proveedor que gestiona la logística de una compañía. Autogestionada = sin proveedor: conserva el que tenía asignado
 * (RN-PLOGC-1), pero sus licencias no llevan dueño (decisión del agente en F4.2, declarada al humano): ningún tercero ve las
 * de una compañía cuya logística no gestiona FLITO.
 */
const proveedorQueGestiona = (c: { proveedorId: string | null; autogestionable?: boolean | null } | undefined): string | null =>
  (c?.autogestionable ? null : c?.proveedorId ?? null);

/** Toma el cliente `FOR SHARE` y devuelve su proveedor vigente. Va antes de bloquear o escribir licencias. */
export async function bloquearCompania(tx: Tx, companiaId: number): Promise<string | null> {
  const [c] = await tx.select({ proveedorId: clients.flitoProveedorLogisticaId, autogestionable: clients.logisticaAutogestionable }).from(clients)
    .where(eq(clients.id, companiaId)).for('share');
  return proveedorQueGestiona(c);
}

/** Bloquea las compañías de estas licencias, en orden de id. La lectura de `compania_id` es sin bloqueo: no cambia en una LT con compañía. */
export async function bloquearCompaniasDeDocumentos(tx: Tx, docIds: string[]): Promise<Array<{ id: number; proveedorId: string | null }>> {
  if (!docIds.length) return [];
  const filas = await tx.select({ companiaId: flitoLogisticaDocumentos.companiaId }).from(flitoLogisticaDocumentos)
    .where(inArray(flitoLogisticaDocumentos.id, docIds));
  const companias = [...new Set(filas.flatMap((f) => (f.companiaId === null ? [] : [f.companiaId])))];
  if (!companias.length) return [];
  const bloqueadas = await tx.select({ id: clients.id, proveedorId: clients.flitoProveedorLogisticaId, autogestionable: clients.logisticaAutogestionable }).from(clients)
    .where(inArray(clients.id, companias)).orderBy(clients.id).for('share');
  return bloqueadas.map((c) => ({ id: c.id, proveedorId: proveedorQueGestiona(c) }));
}

/** La LT no está en un acta abierta, ni por `acta_id` (acta sin viaje) ni por las líneas del acta. */
export const sinActaAbierta = sql`NOT EXISTS (SELECT 1 FROM ${flitoLogisticaActas} WHERE ${flitoLogisticaActas.id} = ${flitoLogisticaDocumentos.actaId} AND ${flitoLogisticaActas.estado} IN ('generada', 'despachada'))
  AND NOT EXISTS (SELECT 1 FROM ${flitoLogisticaActaLineas} JOIN ${flitoLogisticaActas} ON ${flitoLogisticaActas.id} = ${flitoLogisticaActaLineas.actaId}
    WHERE ${flitoLogisticaActaLineas.documentoId} = ${flitoLogisticaDocumentos.id} AND ${flitoLogisticaActas.estado} IN ('generada', 'despachada'))`;

/**
 * Al cerrarse un acta: lo no entregado pasa al proveedor vigente de su compañía; lo entregado se queda con quien lo
 * entregó. Sin proveedor vigente (o con la LT aún en otra acta abierta), el dueño no cambia. `en_flit` no es entregado:
 * falta el viaje al cliente, y lo hace el proveedor vigente.
 */
export async function pasarAlProveedorVigente(tx: Tx, docIds: string[]): Promise<void> {
  const D = flitoLogisticaDocumentos;
  for (const c of await bloquearCompaniasDeDocumentos(tx, docIds)) {
    if (c.proveedorId === null) continue;
    await tx.update(D).set({ proveedorLogisticaId: c.proveedorId, updatedAt: new Date() }).where(and(
      inArray(D.id, docIds), eq(D.companiaId, c.id), ne(D.estado, 'entregado'), sinActaAbierta,
      or(isNull(D.proveedorLogisticaId), ne(D.proveedorLogisticaId, c.proveedorId)),
    ));
  }
}
