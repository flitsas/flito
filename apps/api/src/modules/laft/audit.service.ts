import type { Request } from 'express';
import { db } from '../../db/client.js';
import { laftAuditLog } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('laft-audit');

export interface LaftAuditEntry {
  action: string;
  resource: 'counterparty' | 'beneficial_owner' | 'document' | 'risk_assessment' | 'list_check';
  resourceId?: string | number;
  before?: unknown;
  after?: unknown;
}

// Audit log inmutable LAFT (§15, §16 política — append-only, conservación 5 años).
// Failure no debe romper la operación principal: se loggea y sigue.
export async function laftAudit(req: Request, entry: LaftAuditEntry): Promise<void> {
  try {
    await db.insert(laftAuditLog).values({
      userId: req.user?.sub ?? null,
      userUsername: req.user?.username ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId != null ? String(entry.resourceId) : null,
      beforeState: (entry.before as never) ?? null,
      afterState: (entry.after as never) ?? null,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
    });
  } catch (err) {
    log.error({ err, action: entry.action, resource: entry.resource }, 'insert failed');
  }
}
