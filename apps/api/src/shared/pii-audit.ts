// Helper para registrar accesos a PII en pii_access_log (Ley 1581 art. 17).
// Append-only por trigger SQL. Best-effort: no aborta la operación principal.
//
// Llamar desde endpoints que LEAN datos cifrados (cedula, licencia, runt_payload,
// titular_pago_cuenta, etc.). El handler decide qué campos lista en `camposAccedidos`.

import type { Request } from 'express';
import { db } from '../db/client.js';
import { piiAccessLog } from '../db/schema.js';
import { loggerFor } from './logger.js';

const log = loggerFor('pii-audit');

export interface PiiAuditOpts {
  resourceTipo: string;
  resourceId?: number | null;
  accion: 'read' | 'export' | 'decrypt' | 'search';
  camposAccedidos: string[];
  motivo?: string;
}

export async function logPiiAccess(req: Request, opts: PiiAuditOpts): Promise<void> {
  try {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || req.ip || null;
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 500);
    const requestId = req.headers['x-request-id'] || (req as any).id || null;
    await db.insert(piiAccessLog).values({
      userId: req.user?.sub ?? null,
      userRole: req.user?.role ?? null,
      resourceTipo: opts.resourceTipo,
      resourceId: opts.resourceId ?? null,
      accion: opts.accion,
      camposAccedidos: opts.camposAccedidos,
      motivo: opts.motivo ?? null,
      ipOrigen: xff,
      userAgent: ua,
      requestId: typeof requestId === 'string' ? requestId : null,
    });
  } catch (e: any) {
    log.error({ err: e?.message, resource: opts.resourceTipo }, 'fallo escribiendo pii_access_log');
  }
}
