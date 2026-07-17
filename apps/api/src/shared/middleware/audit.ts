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

export async function audit(req: Request, entry: AuditEntry) {
  try {
    await db.insert(auditLogs).values({
      userId: req.user?.sub || null,
      userEmail: req.user?.username || null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId || null,
      detail: entry.detail || null,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
    });
  } catch (err) {
    // Audit failure should never break the request — but DOES alert ISO 27001 monitoring.
    log.error({ err: (err as Error).message, action: entry.action, resource: entry.resource }, 'audit insert failed');
  }
}
