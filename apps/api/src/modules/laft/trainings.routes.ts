import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { laftTrainings, laftTrainingAttendees, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { laftAudit } from './audit.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const trainingSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  trainerName: z.string().max(120).optional(),
  scheduledAt: z.string(),
  durationHours: z.number().positive().max(99.9).optional(),
  contentUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  evaluationUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  passingScore: z.number().int().min(0).max(100).default(70),
});

const attendanceSchema = z.object({
  attendees: z.array(z.object({
    userId: z.number().int().positive(),
    attended: z.boolean(),
    score: z.number().int().min(0).max(100).optional(),
  })).min(1).max(500),
});

// === Listado de capacitaciones ==============================================
router.get('/', async (_req: Request, res: Response) => {
  const rows = await db.select({
    id: laftTrainings.id,
    title: laftTrainings.title,
    description: laftTrainings.description,
    trainerName: laftTrainings.trainerName,
    scheduledAt: laftTrainings.scheduledAt,
    durationHours: laftTrainings.durationHours,
    passingScore: laftTrainings.passingScore,
    createdAt: laftTrainings.createdAt,
    attendeesCount: sql<number>`(SELECT COUNT(*)::int FROM laft_training_attendees WHERE training_id = ${laftTrainings.id})`,
    attendedCount: sql<number>`(SELECT COUNT(*)::int FROM laft_training_attendees WHERE training_id = ${laftTrainings.id} AND attended = true)`,
  }).from(laftTrainings).orderBy(desc(laftTrainings.scheduledAt)).limit(200);
  res.json(rows);
});

// === Detalle con asistentes =================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const [training] = await db.select().from(laftTrainings).where(eq(laftTrainings.id, id));
  if (!training) { res.status(404).json({ error: 'No encontrado' }); return; }

  const attendees = await db.select({
    id: laftTrainingAttendees.id,
    userId: laftTrainingAttendees.userId,
    userName: users.name,
    userUsername: users.username,
    userRole: users.role,
    attended: laftTrainingAttendees.attended,
    score: laftTrainingAttendees.score,
    attendedAt: laftTrainingAttendees.attendedAt,
  }).from(laftTrainingAttendees)
    .innerJoin(users, eq(laftTrainingAttendees.userId, users.id))
    .where(eq(laftTrainingAttendees.trainingId, id));

  res.json({ ...training, attendees });
});

// === Crear capacitación =====================================================
router.post('/', requireRole('admin', 'compliance'), async (req: Request, res: Response) => {
  const parsed = trainingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [created] = await db.insert(laftTrainings).values({
    title: data.title,
    description: data.description ?? null,
    trainerName: data.trainerName ?? null,
    scheduledAt: new Date(data.scheduledAt),
    durationHours: data.durationHours != null ? String(data.durationHours) : null,
    contentUrl: data.contentUrl ?? null,
    evaluationUrl: data.evaluationUrl ?? null,
    passingScore: data.passingScore,
    createdBy: req.user!.sub,
  }).returning();

  await laftAudit(req, { action: 'create_training', resource: 'document', resourceId: created.id, after: { title: created.title } });
  res.status(201).json(created);
});

// === Registrar asistencia (upsert por user) =================================
router.post('/:id/attendance', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const [training] = await db.select({ id: laftTrainings.id }).from(laftTrainings).where(eq(laftTrainings.id, id));
  if (!training) { res.status(404).json({ error: 'Capacitación no encontrada' }); return; }

  // Borramos los asistentes existentes y reinsertamos (idempotente desde la UI).
  await db.transaction(async (tx) => {
    await tx.delete(laftTrainingAttendees).where(eq(laftTrainingAttendees.trainingId, id));
    if (parsed.data.attendees.length > 0) {
      await tx.insert(laftTrainingAttendees).values(parsed.data.attendees.map((a) => ({
        trainingId: id,
        userId: a.userId,
        attended: a.attended,
        score: a.score ?? null,
        attendedAt: a.attended ? new Date() : null,
      })));
    }
  });

  await laftAudit(req, {
    action: 'update_training_attendance', resource: 'document', resourceId: id,
    after: { attendeesCount: parsed.data.attendees.length, attended: parsed.data.attendees.filter((a) => a.attended).length },
  });

  res.json({ ok: true, count: parsed.data.attendees.length });
});

export default router;
