import { Router, Request, Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { laftAuditLog } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

// Audit log es READ-ONLY (append-only por GRANT en BD).
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const resource = req.query.resource as string | undefined;
  const resourceId = req.query.resourceId as string | undefined;

  const conds = [];
  if (resource) conds.push(eq(laftAuditLog.resource, resource));
  if (resourceId) conds.push(eq(laftAuditLog.resourceId, resourceId));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(laftAuditLog).where(where).orderBy(desc(laftAuditLog.createdAt)).limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(laftAuditLog).where(where);
  res.json({ rows, total: count, limit, offset });
});

export default router;
