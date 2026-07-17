import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, asc, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  maintenanceRoutines, routineJobs, routineParts, routinePeriodicity,
  maintenanceSchedule, vehicles,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ------ Rutinas ------

router.get('/', async (_req, res: Response) => {
  const rows = await db.select().from(maintenanceRoutines)
    .where(eq(maintenanceRoutines.activo, true))
    .orderBy(asc(maintenanceRoutines.codigo));
  res.json({ data: rows });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [routine] = await db.select().from(maintenanceRoutines).where(eq(maintenanceRoutines.id, id)).limit(1);
  if (!routine) { res.status(404).json({ error: 'No encontrado' }); return; }
  const [jobs, parts, periods] = await Promise.all([
    db.select().from(routineJobs).where(eq(routineJobs.routineId, id)).orderBy(asc(routineJobs.orden)),
    db.select().from(routineParts).where(eq(routineParts.routineId, id)),
    db.select().from(routinePeriodicity).where(eq(routinePeriodicity.routineId, id)),
  ]);
  res.json({ data: routine, jobs, parts, periodicity: periods });
});

const routineSchema = z.object({
  codigo: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/),
  nombre: z.string().min(1).max(150),
  descripcion: z.string().max(2000).optional().nullable(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = routineSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(maintenanceRoutines).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'maintenance_routine', resourceId: String(created.id), detail: created.codigo });
  res.status(201).json({ data: created });
});

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = routineSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(maintenanceRoutines)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(maintenanceRoutines.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'maintenance_routine', resourceId: String(id) });
  res.json({ data: updated });
});

// ------ Jobs y Parts asociados ------

router.post('/:id/jobs', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ jobId: z.number().int().positive(), orden: z.number().int().min(1).default(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  await db.insert(routineJobs).values({ routineId: id, ...parsed.data })
    .onConflictDoUpdate({ target: [routineJobs.routineId, routineJobs.jobId], set: { orden: parsed.data.orden } });
  res.status(201).json({ ok: true });
});

router.delete('/:id/jobs/:jobId', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const jobId = parseId(req.params.jobId);
  if (!id || !jobId) { res.status(400).json({ error: 'ID inválido' }); return; }
  await db.delete(routineJobs).where(and(eq(routineJobs.routineId, id), eq(routineJobs.jobId, jobId)));
  res.json({ ok: true });
});

router.post('/:id/parts', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const schema = z.object({ partId: z.number().int().positive(), cantidad: z.number().positive().max(9999) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  await db.insert(routineParts).values({ routineId: id, partId: parsed.data.partId, cantidad: String(parsed.data.cantidad) })
    .onConflictDoUpdate({ target: [routineParts.routineId, routineParts.partId], set: { cantidad: String(parsed.data.cantidad) } });
  res.status(201).json({ ok: true });
});

router.delete('/:id/parts/:partId', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const partId = parseId(req.params.partId);
  if (!id || !partId) { res.status(400).json({ error: 'ID inválido' }); return; }
  await db.delete(routineParts).where(and(eq(routineParts.routineId, id), eq(routineParts.partId, partId)));
  res.json({ ok: true });
});

// ------ Periodicidad ------

const periodicitySchema = z.object({
  criterio: z.enum(['vehicle', 'tipo_vehiculo', 'combustible']),
  refId: z.number().int().positive().optional().nullable(),
  tipoVehiculo: z.enum(['tractomula', 'camion', 'buseta', 'camioneta', 'automovil', 'motocicleta', 'otro']).optional().nullable(),
  combustible: z.enum(['acpm', 'gasolina', 'gas', 'electrico', 'hibrido']).optional().nullable(),
  kmPeriodo: z.number().int().positive().max(1_000_000).optional().nullable(),
  horasPeriodo: z.number().int().positive().max(100_000).optional().nullable(),
  diasPeriodo: z.number().int().positive().max(3650).optional().nullable(),
}).refine((d) => d.kmPeriodo != null || d.horasPeriodo != null || d.diasPeriodo != null, {
  message: 'Debe definir al menos un período (km, horas o días)',
}).refine((d) => {
  if (d.criterio === 'vehicle') return d.refId != null;
  if (d.criterio === 'tipo_vehiculo') return d.tipoVehiculo != null;
  if (d.criterio === 'combustible') return d.combustible != null;
  return false;
}, { message: 'El criterio requiere su referencia correspondiente' });

router.post('/:id/periodicity', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = periodicitySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(routinePeriodicity).values({ routineId: id, ...(parsed.data as any) }).returning();

  // Si cambia la periodicidad, invalidar schedules pendientes para que el cron las reprograme.
  await db.update(maintenanceSchedule)
    .set({ estado: 'cancelada', updatedAt: new Date() })
    .where(and(eq(maintenanceSchedule.routineId, id), eq(maintenanceSchedule.estado, 'pendiente')));

  await audit(req, { action: 'create', resource: 'routine_periodicity', resourceId: String(created.id) });
  res.status(201).json({ data: created });
});

router.delete('/:id/periodicity/:periodId', requireRole('admin'), async (req: Request, res: Response) => {
  const periodId = parseId(req.params.periodId);
  if (!periodId) { res.status(400).json({ error: 'ID inválido' }); return; }
  await db.delete(routinePeriodicity).where(eq(routinePeriodicity.id, periodId));
  res.json({ ok: true });
});

export default router;
