// FLITO Logística — base compartida (HU #14108, ADR-0030 §11): contexto, error de dominio, tipos de
// transacción, constantes y helpers que usan los demás archivos del módulo. Sin dependencias de ellos.

import { eq, sql } from 'drizzle-orm';
import { type EstadoDocumentoLogistica as TEstadoDoc } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoLogisticaDocumentos, flitoLogisticaEventos, flitoTramites } from '../../db/schema.js';
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

export const normPlaca = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');
// HU #13946: un trámite retenido (cliente inactivo) puede llegar o pasar a «Aprobado» en FLIT (el sync escribe
// `flit_estado` en cada update), pero no entra a la consola, ni al escaneo/validación de la LT, ni a las facetas.
export const aprobadoSql = sql`lower(${flitoTramites.flitEstado}) = 'aprobado' AND NOT ${flitoTramites.retenido}`;

/** Error de negocio con estado HTTP sugerido (lo traduce la ruta). */
export class LogisticaError extends Error {
  constructor(message: string, readonly status = 400, readonly extra?: unknown) { super(message); }
}

// ── Transición genérica (deja evento; sostiene CA-07/RN-04/RN-07) ────────────

export interface DocMin { id: string; estado: string }
export interface TransOpts { motivo?: string | null; lat?: string | null; lng?: string | null; origen?: 'api' | 'usuario' }

export async function transicionar(exec: DbOrTx, doc: DocMin, estadoNuevo: TEstadoDoc, ctx: LogisticaCtx, opts: TransOpts = {}): Promise<void> {
  const set: Record<string, unknown> = { estado: estadoNuevo, updatedAt: new Date() };
  if (opts.motivo !== undefined) set.motivo = opts.motivo;
  await exec.update(flitoLogisticaDocumentos).set(set).where(eq(flitoLogisticaDocumentos.id, doc.id));
  await exec.insert(flitoLogisticaEventos).values({
    documentoId: doc.id, estadoAnterior: doc.estado, estadoNuevo, actorId: ctx.userId,
    lat: opts.lat ?? null, lng: opts.lng ?? null, motivo: opts.motivo ?? null, origen: opts.origen ?? 'usuario',
  });
}

/** Decodifica un dataURL (o base64 pelado) a Buffer. */
export function bufDesdeDataUrl(dataUrl: string): Buffer {
  const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}
