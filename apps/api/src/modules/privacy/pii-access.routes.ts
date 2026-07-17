// Ley 1581 art. 17 — endpoint read-only para auditoría del log de accesos PII.
// El log es append-only en BD (trigger). Aquí solo se consulta con filtros.
//
// Solo admin y compliance pueden ver. NO existen endpoints de DELETE/UPDATE.

import { Router, Request, Response } from 'express';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { piiAccessLog } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const userId = req.query.userId ? parseInt(req.query.userId as string, 10) : undefined;
  const resourceTipo = req.query.resourceTipo as string | undefined;
  const resourceId = req.query.resourceId ? parseInt(req.query.resourceId as string, 10) : undefined;
  const accion = req.query.accion as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conds: any[] = [];
  if (userId) conds.push(eq(piiAccessLog.userId, userId));
  if (resourceTipo) conds.push(eq(piiAccessLog.resourceTipo, resourceTipo));
  if (resourceId) conds.push(eq(piiAccessLog.resourceId, resourceId));
  if (accion) conds.push(eq(piiAccessLog.accion, accion));
  if (from) conds.push(gte(piiAccessLog.accessedAt, new Date(from)));
  if (to) conds.push(lte(piiAccessLog.accessedAt, new Date(to)));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(piiAccessLog).where(where).orderBy(desc(piiAccessLog.accessedAt)).limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(piiAccessLog).where(where);
  res.json({ rows, total: count, limit, offset });
});

router.get('/stats', async (_req: Request, res: Response) => {
  // Resumen ejecutivo: accesos por usuario y por tipo en últimos 30 días.
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const rowsUser = await db.execute(sql`
    SELECT user_id, user_role, COUNT(*)::int AS accesos
      FROM pii_access_log
     WHERE accessed_at >= ${since.toISOString()}::timestamptz
     GROUP BY user_id, user_role
     ORDER BY accesos DESC LIMIT 20
  ` as any) as any;
  const rowsResource = await db.execute(sql`
    SELECT resource_tipo, accion, COUNT(*)::int AS accesos
      FROM pii_access_log
     WHERE accessed_at >= ${since.toISOString()}::timestamptz
     GROUP BY resource_tipo, accion
     ORDER BY accesos DESC LIMIT 50
  ` as any) as any;
  res.json({
    desde: since.toISOString(),
    porUsuario: (rowsUser?.rows ?? rowsUser ?? []),
    porRecurso: (rowsResource?.rows ?? rowsResource ?? []),
  });
});

export default router;
