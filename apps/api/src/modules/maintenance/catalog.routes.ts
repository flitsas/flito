import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, ilike, and, asc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { maintenanceSystems, maintenanceSubsystems, maintenanceJobs, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('maintenance'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ------ Sistemas ------

router.get('/systems', async (_req, res: Response) => {
  const rows = await db.select().from(maintenanceSystems)
    .where(eq(maintenanceSystems.activo, true))
    .orderBy(asc(maintenanceSystems.orden));
  res.json({ data: rows });
});

const systemSchema = z.object({
  codigo: z.string().min(1).max(20).regex(/^[A-Z0-9_]+$/),
  nombre: z.string().min(1).max(80),
  orden: z.number().int().min(0).max(9999).default(100),
});

router.post('/systems', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = systemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(maintenanceSystems).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'maintenance_system', resourceId: String(created.id), detail: created.codigo });
  res.status(201).json({ data: created });
});

// ------ Subsistemas ------

router.get('/subsystems', async (req: Request, res: Response) => {
  const systemId = req.query.systemId ? parseId(String(req.query.systemId)) : null;
  const cond = systemId
    ? and(eq(maintenanceSubsystems.activo, true), eq(maintenanceSubsystems.systemId, systemId))
    : eq(maintenanceSubsystems.activo, true);
  const rows = await db.select().from(maintenanceSubsystems).where(cond).orderBy(asc(maintenanceSubsystems.codigo));
  res.json({ data: rows });
});

const subsystemSchema = z.object({
  systemId: z.number().int().positive(),
  codigo: z.string().min(1).max(20),
  nombre: z.string().min(1).max(80),
});

router.post('/subsystems', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = subsystemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(maintenanceSubsystems).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'maintenance_subsystem', resourceId: String(created.id) });
  res.status(201).json({ data: created });
});

// ------ Jobs (trabajos atómicos) ------

router.get('/jobs', async (req: Request, res: Response) => {
  const q = req.query.q ? String(req.query.q).slice(0, 100) : null;
  const systemId = req.query.systemId ? parseId(String(req.query.systemId)) : null;
  const conds = [eq(maintenanceJobs.activo, true)];
  if (q) conds.push(sql`(${maintenanceJobs.nombre} ILIKE ${`%${q}%`} OR ${maintenanceJobs.codigo} ILIKE ${`%${q}%`})`);
  if (systemId) conds.push(eq(maintenanceJobs.systemId, systemId));
  const rows = await db.select().from(maintenanceJobs).where(and(...conds)).orderBy(asc(maintenanceJobs.nombre)).limit(200);
  res.json({ data: rows });
});

const jobSchema = z.object({
  codigo: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/),
  nombre: z.string().min(1).max(150),
  systemId: z.number().int().positive().optional().nullable(),
  subsystemId: z.number().int().positive().optional().nullable(),
  tiempoEstimadoHoras: z.number().min(0).max(999).optional().nullable(),
  descripcion: z.string().max(2000).optional().nullable(),
});

router.post('/jobs', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(maintenanceJobs).values(parsed.data as any).returning();
  await audit(req, { action: 'create', resource: 'maintenance_job', resourceId: String(created.id), detail: created.codigo });
  res.status(201).json({ data: created });
});

router.patch('/jobs/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = jobSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(maintenanceJobs).set(parsed.data as any).where(eq(maintenanceJobs.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'maintenance_job', resourceId: String(id) });
  res.json({ data: updated });
});

// ------ Mecánicos (vista filtrada de users) ------

router.get('/mechanics', async (_req, res: Response) => {
  const rows = await db.select({
    id: users.id,
    name: users.name,
    username: users.username,
    email: users.email,
    especialidades: users.especialidades,
    active: users.active,
  })
    .from(users)
    .where(and(eq(users.esMecanico, true), eq(users.active, true)))
    .orderBy(asc(users.name));
  res.json({ data: rows });
});

const mechanicSchema = z.object({
  esMecanico: z.boolean(),
  especialidades: z.array(z.string().max(60)).max(20).optional(),
});

router.patch('/mechanics/:userId', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.userId);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = mechanicSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(users)
    .set({
      esMecanico: parsed.data.esMecanico,
      ...(parsed.data.especialidades ? { especialidades: parsed.data.especialidades } : {}),
    })
    .where(eq(users.id, id))
    .returning({ id: users.id, esMecanico: users.esMecanico, especialidades: users.especialidades });
  if (!updated) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'user_mechanic', resourceId: String(id), detail: `es_mecanico=${parsed.data.esMecanico}` });
  res.json({ data: updated });
});

export default router;
