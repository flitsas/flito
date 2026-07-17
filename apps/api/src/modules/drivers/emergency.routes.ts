import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { emergencyContacts, emergencyProtocols, emergencyDrills } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ------ Contactos ------

router.get('/contacts', async (req: Request, res: Response) => {
  const zona = req.query.zona as string | undefined;
  const tipo = req.query.tipo as string | undefined;
  const conds: any[] = [eq(emergencyContacts.activo, true)];
  if (zona) conds.push(eq(emergencyContacts.zona, zona));
  if (tipo) conds.push(eq(emergencyContacts.tipo, tipo as any));
  const rows = await db.select().from(emergencyContacts).where(and(...conds))
    .orderBy(asc(emergencyContacts.prioridad), asc(emergencyContacts.nombre));
  res.json({ data: rows });
});

const contactSchema = z.object({
  tipo: z.enum(['arl', 'ambulancia', 'bombero', 'policia', 'taller_grua', 'aseguradora', 'interno']),
  zona: z.string().min(1).max(100),
  nombre: z.string().min(1).max(150),
  telefono: z.string().min(3).max(40),
  telefonoAlternativo: z.string().max(40).optional().nullable(),
  email: z.string().email().optional().nullable(),
  direccion: z.string().max(300).optional().nullable(),
  observaciones: z.string().max(2000).optional().nullable(),
  prioridad: z.number().int().min(0).max(999).default(100),
});

router.post('/contacts', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(emergencyContacts).values(parsed.data as any).returning();
  await audit(req, { action: 'create', resource: 'emergency_contact', resourceId: String(created.id), detail: created.nombre });
  res.status(201).json({ data: created });
});

router.patch('/contacts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(emergencyContacts)
    .set({ ...parsed.data, updatedAt: new Date() } as any)
    .where(eq(emergencyContacts.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'emergency_contact', resourceId: String(id) });
  res.json({ data: updated });
});

router.delete('/contacts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [updated] = await db.update(emergencyContacts).set({ activo: false, updatedAt: new Date() }).where(eq(emergencyContacts.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'delete', resource: 'emergency_contact', resourceId: String(id) });
  res.json({ ok: true });
});

// ------ Protocolos ------

router.get('/protocols', async (_req, res: Response) => {
  const rows = await db.select().from(emergencyProtocols)
    .where(eq(emergencyProtocols.vigente, true))
    .orderBy(asc(emergencyProtocols.categoria), asc(emergencyProtocols.titulo));
  res.json({ data: rows });
});

const protocolSchema = z.object({
  titulo: z.string().min(1).max(200),
  categoria: z.enum(['accidente', 'averia', 'medico', 'seguridad']),
  descripcionMd: z.string().min(1).max(50000),
  zonas: z.array(z.string().max(100)).max(50).default([]),
});

router.post('/protocols', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = protocolSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(emergencyProtocols).values({
    ...parsed.data,
    createdBy: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'emergency_protocol', resourceId: String(created.id), detail: created.titulo });
  res.status(201).json({ data: created });
});

// ------ Simulacros ------

router.get('/drills', async (_req, res: Response) => {
  const rows = await db.select().from(emergencyDrills).orderBy(desc(emergencyDrills.fecha)).limit(200);
  res.json({ data: rows });
});

const drillSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  escenario: z.string().min(1).max(200),
  protocoloId: z.number().int().positive().optional().nullable(),
  participantes: z.array(z.number().int().positive()).max(500).default([]),
  observaciones: z.string().max(2000).optional().nullable(),
  planMejora: z.string().max(2000).optional().nullable(),
});

router.post('/drills', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = drillSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(emergencyDrills).values({
    ...parsed.data,
    responsableId: req.user?.sub ?? null,
  } as any).returning();
  await audit(req, { action: 'create', resource: 'emergency_drill', resourceId: String(created.id), detail: created.escenario });
  res.status(201).json({ data: created });
});

export default router;
