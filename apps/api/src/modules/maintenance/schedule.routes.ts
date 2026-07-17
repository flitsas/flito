import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, asc, desc, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { maintenanceSchedule, vehicles, maintenanceRoutines, maintenanceJobs } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { runScheduleOnce } from './schedule.cron.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get('/', async (req: Request, res: Response) => {
  const vehicleId = req.query.vehicleId ? parseId(String(req.query.vehicleId)) : null;
  const estado = req.query.estado as string | undefined;
  const desde = req.query.desde as string | undefined;
  const hasta = req.query.hasta as string | undefined;

  const conds: any[] = [];
  if (vehicleId) conds.push(eq(maintenanceSchedule.vehicleId, vehicleId));
  if (estado) conds.push(eq(maintenanceSchedule.estado, estado as any));
  if (desde) conds.push(gte(maintenanceSchedule.fechaProgramada, desde));
  if (hasta) conds.push(lte(maintenanceSchedule.fechaProgramada, hasta));

  const rows = await db.select({
    id: maintenanceSchedule.id,
    vehicleId: maintenanceSchedule.vehicleId,
    plate: vehicles.plate,
    alias: vehicles.alias,
    routineId: maintenanceSchedule.routineId,
    routineNombre: maintenanceRoutines.nombre,
    jobId: maintenanceSchedule.jobId,
    jobNombre: maintenanceJobs.nombre,
    fechaProgramada: maintenanceSchedule.fechaProgramada,
    medicionProgramada: maintenanceSchedule.medicionProgramada,
    tipo: maintenanceSchedule.tipo,
    estado: maintenanceSchedule.estado,
    notas: maintenanceSchedule.notas,
  })
    .from(maintenanceSchedule)
    .leftJoin(vehicles, eq(vehicles.id, maintenanceSchedule.vehicleId))
    .leftJoin(maintenanceRoutines, eq(maintenanceRoutines.id, maintenanceSchedule.routineId))
    .leftJoin(maintenanceJobs, eq(maintenanceJobs.id, maintenanceSchedule.jobId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(maintenanceSchedule.fechaProgramada))
    .limit(500);
  res.json({ data: rows });
});

const manualSchema = z.object({
  vehicleId: z.number().int().positive(),
  routineId: z.number().int().positive().optional().nullable(),
  jobId: z.number().int().positive().optional().nullable(),
  fechaProgramada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  medicionProgramada: z.number().int().positive().optional().nullable(),
  notas: z.string().max(500).optional().nullable(),
}).refine((d) => d.routineId != null || d.jobId != null, {
  message: 'Debe especificar routineId o jobId',
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;
  const [created] = await db.insert(maintenanceSchedule).values({
    vehicleId: data.vehicleId,
    routineId: data.routineId ?? null,
    jobId: data.jobId ?? null,
    fechaProgramada: data.fechaProgramada,
    medicionProgramada: data.medicionProgramada ?? null,
    tipo: 'manual',
    estado: 'pendiente',
    creadoPor: req.user?.sub ?? null,
    notas: data.notas ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'maintenance_schedule', resourceId: String(created.id) });
  res.status(201).json({ data: created });
});

router.patch('/:id/cancel', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(maintenanceSchedule)
    .set({ estado: 'cancelada', updatedAt: new Date() })
    .where(and(eq(maintenanceSchedule.id, id), eq(maintenanceSchedule.estado, 'pendiente')))
    .returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado o ya cerrado' }); return; }
  await audit(req, { action: 'update', resource: 'maintenance_schedule', resourceId: String(id), detail: 'cancelled' });
  res.json({ data: updated });
});

// Disparo manual del cron (admin) — útil para refrescar tras cambios masivos.
router.post('/recompute', requireRole('admin'), async (req: Request, res: Response) => {
  const stats = await runScheduleOnce();
  await audit(req, { action: 'update', resource: 'maintenance_schedule', detail: `recompute manual: ${JSON.stringify(stats)}` });
  res.json({ ok: true, stats });
});

export default router;
