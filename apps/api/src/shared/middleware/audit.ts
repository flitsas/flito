import { db } from '../../db/client.js';
import { auditLogs } from '../../db/schema.js';
import type { Request } from 'express';
import { loggerFor } from '../logger.js';

const log = loggerFor('audit');

type AuditAction = 'login' | 'login_failed' | 'logout' | 'create' | 'update' | 'delete' | 'upload' | 'export' | 'view' | 'purchase' | 'wo_open' | 'wo_close' | 'stock_adjust';

interface AuditEntry {
  action: AuditAction;
  resource: string;
  resourceId?: string;
  detail?: string;
}

/** Tope de `audit_logs.resource_id`. Un UUID son 36; dos unidos por coma, 73. */
const MAX_RESOURCE_ID = 50;

/**
 * Parte el `resourceId` en lo que cabe en la columna y lo que no.
 *
 * Varios sitios pasaban `ids.join(',')` para una operación en lote. Con dos UUID son 73 caracteres
 * contra una columna de 50: Postgres RECHAZA el INSERT —no lo trunca— y como `audit()` se traga sus
 * errores, la operación se completaba sin dejar ninguna fila de auditoría. Silencioso y del lado
 * malo: cuanto más grande el lote, más seguro que no quedara rastro.
 *
 * En vez de recortar el identificador —que dejaría un id inválido, peor que ninguno— el valor largo
 * se manda al `detail`, que es `text` y no tiene tope, y la columna queda nula.
 */
function acotarResourceId(entry: AuditEntry): { resourceId: string | null; detail: string | null } {
  const id = entry.resourceId || null;
  const detail = entry.detail || null;
  if (!id || id.length <= MAX_RESOURCE_ID) return { resourceId: id, detail };
  return { resourceId: null, detail: detail ? `${detail} · Registros: ${id}` : `Registros: ${id}` };
}

export async function audit(req: Request, entry: AuditEntry) {
  try {
    const { resourceId, detail } = acotarResourceId(entry);
    await db.insert(auditLogs).values({
      userId: req.user?.sub || null,
      userEmail: req.user?.username || null,
      action: entry.action,
      resource: entry.resource,
      resourceId,
      detail,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
    });
  } catch (err) {
    // Audit failure should never break the request — but DOES alert ISO 27001 monitoring.
    log.error({ err: (err as Error).message, action: entry.action, resource: entry.resource }, 'audit insert failed');
  }
}
