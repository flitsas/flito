import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvPlanAnual, pesvPlanObjetivos, pesvPlanAcciones } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const ACCION_ESTADOS = ['pendiente', 'en_proceso', 'cumplida', 'vencida'] as const;
const numericish = z.union([z.string(), z.number()]).transform((v) => String(v));

const planCreateSchema = z.object({
  anio: z.number().int().min(2020).max(2100),
  objetivoGeneral: z.string().min(20),
  presupuestoCop: numericish.default('0'),
});
const planUpdateSchema = planCreateSchema.partial().extend({
  optimisticV: z.number().int().positive(),
});

const objetivoSchema = z.object({
  codigo: z.string().min(1).max(20),
  descripcion: z.string().min(10),
  metaPct: numericish,
  unidad: z.string().max(50).optional().nullable(),
  responsableId: z.number().int().positive().optional().nullable(),
  fechaLimite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});
const accionSchema = z.object({
  descripcion: z.string().min(5),
  responsableId: z.number().int().positive().optional().nullable(),
  fechaInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  fechaFin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  presupuestoCop: numericish.default('0'),
  avancePct: numericish.default('0'),
  estado: z.enum(ACCION_ESTADOS).default('pendiente'),
  evidenciaKeys: z.array(z.string()).default([]),
});

router.get('/', async (_req, res) => {
  const rows = await db.select().from(pesvPlanAnual).orderBy(desc(pesvPlanAnual.anio));
  res.json({ data: rows });
});

router.get('/anio/:anio', async (req, res) => {
  const anio = parseInt(req.params.anio, 10);
  if (!Number.isFinite(anio)) return res.status(400).json({ error: 'año inválido' });
  const [plan] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.anio, anio)).limit(1);
  if (!plan) return res.status(404).json({ error: 'sin plan ese año' });
  const objetivos = await db.select().from(pesvPlanObjetivos).where(eq(pesvPlanObjetivos.planId, plan.id));
  const acciones = await db.select().from(pesvPlanAcciones);
  const accionesPorObj = new Map<number, typeof acciones>();
  for (const a of acciones) {
    const arr = accionesPorObj.get(a.objetivoId) ?? [];
    arr.push(a);
    accionesPorObj.set(a.objetivoId, arr);
  }
  res.json({ ...plan, objetivos: objetivos.map((o) => ({ ...o, acciones: accionesPorObj.get(o.id) ?? [] })) });
});

router.post('/', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const parsed = planCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  try {
    const [row] = await db.insert(pesvPlanAnual).values({
      anio: parsed.data.anio,
      objetivoGeneral: parsed.data.objetivoGeneral,
      presupuestoCop: parsed.data.presupuestoCop,
      createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_plan', resourceId: String(row.id), detail: String(row.anio) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: `Plan ${parsed.data.anio} ya existe` });
    throw e;
  }
});

router.patch('/:id', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = planUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });

  const [current] = await db.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.id, id)).limit(1);
  if (!current) return res.status(404).json({ error: 'no encontrado' });
  if (current.estado === 'cerrado') return res.status(409).json({ error: 'plan cerrado (WORM)' });
  if (current.optimisticV !== parsed.data.optimisticV) return res.status(409).json({ error: 'concurrencia' });

  const [row] = await db.update(pesvPlanAnual).set({
    ...(parsed.data.objetivoGeneral !== undefined && { objetivoGeneral: parsed.data.objetivoGeneral }),
    ...(parsed.data.presupuestoCop !== undefined && { presupuestoCop: parsed.data.presupuestoCop }),
    optimisticV: current.optimisticV + 1,
  }).where(eq(pesvPlanAnual.id, id)).returning();
  await audit(req, { action: 'update', resource: 'pesv_plan', resourceId: String(id) });
  res.json(row);
});

router.post('/:id/aprobar', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(pesvPlanAnual).where(eq(pesvPlanAnual.id, id)).for('update').limit(1);
    if (!current) return { code: 404 as const };
    if (current.estado !== 'borrador') return { code: 409 as const, msg: 'solo borrador puede aprobarse' };
    const [row] = await tx.update(pesvPlanAnual).set({
      estado: 'aprobado',
      aprobadoAt: new Date(),
      aprobadoPor: req.user!.sub,
      optimisticV: current.optimisticV + 1,
    }).where(eq(pesvPlanAnual.id, id)).returning();
    return { code: 200 as const, row };
  });
  if (result.code !== 200) return res.status(result.code).json({ error: (result as any).msg || 'no encontrado' });
  await audit(req, { action: 'update', resource: 'pesv_plan', resourceId: String(id), detail: 'aprobado' });
  res.json(result.row);
});

// ============ OBJETIVOS / ACCIONES ============

router.post('/:id/objetivos', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const planId = parseInt(req.params.id, 10);
  if (!Number.isFinite(planId) || planId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = objetivoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  try {
    const [row] = await db.insert(pesvPlanObjetivos).values({
      planId,
      codigo: parsed.data.codigo,
      descripcion: parsed.data.descripcion,
      metaPct: parsed.data.metaPct,
      unidad: parsed.data.unidad ?? null,
      responsableId: parsed.data.responsableId ?? null,
      fechaLimite: parsed.data.fechaLimite ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_plan_obj', resourceId: String(row.id) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'código duplicado en el plan' });
    if (e?.code === '23503') return res.status(400).json({ error: 'plan inexistente' });
    throw e;
  }
});

router.post('/objetivos/:objId/acciones', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const objId = parseInt(req.params.objId, 10);
  if (!Number.isFinite(objId) || objId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = accionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  try {
    const [row] = await db.insert(pesvPlanAcciones).values({
      objetivoId: objId,
      descripcion: parsed.data.descripcion,
      responsableId: parsed.data.responsableId ?? null,
      fechaInicio: parsed.data.fechaInicio ?? null,
      fechaFin: parsed.data.fechaFin ?? null,
      presupuestoCop: parsed.data.presupuestoCop,
      avancePct: parsed.data.avancePct,
      estado: parsed.data.estado,
      evidenciaKeys: parsed.data.evidenciaKeys,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_plan_acc', resourceId: String(row.id) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23503') return res.status(400).json({ error: 'objetivo inexistente' });
    throw e;
  }
});

router.patch('/acciones/:accId', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const accId = parseInt(req.params.accId, 10);
  if (!Number.isFinite(accId) || accId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = accionSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;
  const [row] = await db.update(pesvPlanAcciones).set({
    ...(data.descripcion !== undefined && { descripcion: data.descripcion }),
    ...(data.responsableId !== undefined && { responsableId: data.responsableId ?? null }),
    ...(data.fechaInicio !== undefined && { fechaInicio: data.fechaInicio ?? null }),
    ...(data.fechaFin !== undefined && { fechaFin: data.fechaFin ?? null }),
    ...(data.presupuestoCop !== undefined && { presupuestoCop: data.presupuestoCop }),
    ...(data.avancePct !== undefined && { avancePct: data.avancePct }),
    ...(data.estado !== undefined && { estado: data.estado }),
    ...(data.evidenciaKeys !== undefined && { evidenciaKeys: data.evidenciaKeys }),
  }).where(eq(pesvPlanAcciones.id, accId)).returning();
  if (!row) return res.status(404).json({ error: 'acción no encontrada' });
  await audit(req, { action: 'update', resource: 'pesv_plan_acc', resourceId: String(accId) });
  res.json(row);
});

export default router;
