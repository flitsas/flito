import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { safetyTrainings, trainingAttendees, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get('/', async (_req, res: Response) => {
  const rows = await db.execute<any>(sql`
    SELECT st.*, COUNT(ta.user_id)::int AS asistentes_count,
           COUNT(*) FILTER (WHERE ta.asistio)::int AS asistio_count
      FROM safety_trainings st
      LEFT JOIN training_attendees ta ON ta.training_id = st.id
      GROUP BY st.id
      ORDER BY st.fecha DESC
      LIMIT 200
  `);
  res.json({ data: (rows as any).rows ?? rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [training] = await db.select().from(safetyTrainings).where(eq(safetyTrainings.id, id)).limit(1);
  if (!training) { res.status(404).json({ error: 'No encontrado' }); return; }
  const attendees = await db.select({
    userId: trainingAttendees.userId,
    name: users.name,
    asistio: trainingAttendees.asistio,
    calificacion: trainingAttendees.calificacion,
    certificadoStorageKey: trainingAttendees.certificadoStorageKey,
  })
    .from(trainingAttendees)
    .leftJoin(users, eq(users.id, trainingAttendees.userId))
    .where(eq(trainingAttendees.trainingId, id));
  res.json({ data: training, attendees });
});

const trainingSchema = z.object({
  titulo: z.string().min(1).max(150),
  descripcion: z.string().max(2000).optional().nullable(),
  horas: z.number().positive().max(999),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  instructor: z.string().max(120).optional().nullable(),
  modalidad: z.enum(['presencial', 'virtual', 'mixta']).default('presencial'),
  linkMaterial: z.string().max(500).optional().nullable(),
  vigenciaMeses: z.number().int().min(1).max(120).optional().nullable(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = trainingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(safetyTrainings).values({
    ...parsed.data, horas: String(parsed.data.horas), creadaPor: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'safety_training', resourceId: String(created.id), detail: created.titulo });
  res.status(201).json({ data: created });
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = trainingSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data: any = { ...parsed.data };
  if (data.horas != null) data.horas = String(data.horas);
  const [updated] = await db.update(safetyTrainings).set(data).where(eq(safetyTrainings.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'safety_training', resourceId: String(id) });
  res.json({ data: updated });
});

router.post('/:id/attendees', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ userIds: z.array(z.number().int().positive()).min(1).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }

  // Verifica que todos sean conductores activos.
  const valid = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.id, parsed.data.userIds), eq(users.esConductor, true), eq(users.active, true)));
  const validIds = valid.map((u) => u.id);

  for (const userId of validIds) {
    await db.insert(trainingAttendees).values({ trainingId: id, userId, asistio: false } as any)
      .onConflictDoNothing();
  }
  res.status(201).json({ ok: true, registered: validIds.length });
});

router.patch('/:id/attendees/:userId', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (!id || !userId) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({
    asistio: z.boolean().optional(),
    calificacion: z.number().min(0).max(5).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data: any = { ...parsed.data };
  if (data.calificacion != null) data.calificacion = String(data.calificacion);
  const [updated] = await db.update(trainingAttendees)
    .set(data)
    .where(and(eq(trainingAttendees.trainingId, id), eq(trainingAttendees.userId, userId)))
    .returning();
  if (!updated) { res.status(404).json({ error: 'Asistente no registrado' }); return; }
  res.json({ data: updated });
});

// Reporte: horas anuales de capacitación por conductor.
router.get('/report/horas-conductor', async (req: Request, res: Response) => {
  const year = parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
  if (!Number.isFinite(year) || year < 2020 || year > 2100) { res.status(400).json({ error: 'Año inválido' }); return; }
  const rows = await db.execute<any>(sql`
    SELECT u.id AS user_id, u.name,
      COALESCE(SUM(st.horas) FILTER (WHERE EXTRACT(YEAR FROM st.fecha) = ${year} AND ta.asistio), 0)::numeric(8,2) AS horas
      FROM users u
      LEFT JOIN training_attendees ta ON ta.user_id = u.id
      LEFT JOIN safety_trainings st  ON st.id = ta.training_id
     WHERE u.es_conductor = true AND u.active = true
     GROUP BY u.id, u.name
     ORDER BY horas DESC, u.name ASC
  `);
  const data = ((rows as any).rows ?? rows) as any[];
  res.json({ year, data: data.map((r: any) => ({ userId: r.user_id, name: r.name, horas: Number(r.horas) })) });
});

export default router;
