import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { maskName } from '../../shared/utils/pii.js';

const router = Router();
router.use(authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  document: z.string().max(20).optional(),
  documentType: z.string().max(5).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  notes: z.string().optional(),
});

router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const result = await db.select().from(clients).orderBy(clients.name).limit(limit).offset(offset);
  res.json(result);
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const [client] = await db.insert(clients).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'client', resourceId: String(client.id), detail: `Cliente: ${maskName(client.name)}` });
  res.status(201).json(client);
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const [updated] = await db.update(clients).set(parsed.data).where(eq(clients.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
  res.json(updated);
});

export default router;
