// FLITO Bitácora (HTTP). Porta packages/server/src/comun/bitacora.controlador.ts. Montado en
// /api/flito/bitacora. Consulta de solo lectura sobre audit_logs (la bitácora del pequeño se folda en
// la auditoría del grande): entidad→resource, entidadId→resourceId, accion→action, actor→userEmail.
//
// Auditoría entra aquí, y solo aquí, en modo lectura (§5 de los tres features). Los gestores no entran.

import { Router, type Request, type Response } from 'express';
import { and, desc, asc, eq, inArray } from 'drizzle-orm';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { db } from '../../db/client.js';
import { auditLogs } from '../../db/schema.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'operaciones', 'auditor');

// Recursos que pertenecen al dominio FLITO dentro de audit_logs.
const RECURSOS_FLITO = ['flito_soat', 'flito_impuesto', 'flito_tramite', 'flito_revision'] as const;

interface BitacoraItem {
  id: number; resource: string; resourceId: string | null; action: string;
  actorNombre: string | null; actorId: number | null; detalle: string | null; creadoEn: string;
}

function aItem(r: typeof auditLogs.$inferSelect): BitacoraItem {
  return {
    id: r.id, resource: r.resource, resourceId: r.resourceId, action: r.action,
    actorNombre: r.userEmail, actorId: r.userId, detalle: r.detail, creadoEn: r.createdAt.toISOString(),
  };
}

// GET / — últimos registros del dominio FLITO (?resource= filtra a uno; ?limite= tope, máx 500).
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const resource = typeof req.query.resource === 'string' && (RECURSOS_FLITO as readonly string[]).includes(req.query.resource)
    ? req.query.resource : undefined;
  const limite = Math.min(Number(req.query.limite) || 100, 500);

  const rows = await db.select().from(auditLogs)
    .where(resource ? eq(auditLogs.resource, resource) : inArray(auditLogs.resource, [...RECURSOS_FLITO]))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limite);
  res.json(rows.map(aItem));
});

// GET /:resource/:resourceId — historia cronológica de una entidad concreta.
router.get('/:resource/:resourceId', LECTURA, async (req: Request, res: Response) => {
  if (!(RECURSOS_FLITO as readonly string[]).includes(req.params.resource)) {
    res.status(400).json({ error: 'Recurso desconocido' }); return;
  }
  const rows = await db.select().from(auditLogs)
    .where(and(eq(auditLogs.resource, req.params.resource), eq(auditLogs.resourceId, req.params.resourceId)))
    .orderBy(asc(auditLogs.createdAt))
    .limit(500);
  res.json(rows.map(aItem));
});

export default router;
