import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { routeRiskAnalyses, routeRiskItems } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const trimestreRegex = /^[0-9]{4}-Q[1-4]$/;

const riskCreateSchema = z.object({
  routeId: z.number().int().positive(),
  trimestre: z.string().regex(trimestreRegex, 'Formato YYYY-QN'),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  resumen: z.string().max(5000).optional().nullable(),
});

const itemSchema = z.object({
  peligro: z.string().min(3).max(300),
  probabilidad: z.number().int().min(1).max(5),
  impacto: z.number().int().min(1).max(5),
  controlesActuales: z.string().max(2000).optional().nullable(),
  residualProb: z.number().int().min(1).max(5).optional().nullable(),
  residualImp: z.number().int().min(1).max(5).optional().nullable(),
  planAccion: z.string().max(2000).optional().nullable(),
  responsableId: z.number().int().positive().optional().nullable(),
  fechaLimite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

router.get('/', async (req, res) => {
  const routeId = req.query.routeId ? parseInt(req.query.routeId as string, 10) : undefined;
  const conds: any[] = [];
  if (routeId) conds.push(eq(routeRiskAnalyses.routeId, routeId));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(routeRiskAnalyses).where(where).orderBy(desc(routeRiskAnalyses.fecha));
  res.json({ data: rows });
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [a] = await db.select().from(routeRiskAnalyses).where(eq(routeRiskAnalyses.id, id)).limit(1);
  if (!a) return res.status(404).json({ error: 'No encontrado' });
  const items = await db.select().from(routeRiskItems).where(eq(routeRiskItems.analisisId, id));
  res.json({ ...a, items });
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = riskCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  try {
    const [row] = await db.insert(routeRiskAnalyses).values({
      routeId: parsed.data.routeId,
      trimestre: parsed.data.trimestre,
      fecha: parsed.data.fecha,
      evaluadorId: req.user!.sub,
      resumen: parsed.data.resumen ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'route_risk', resourceId: String(row.id), detail: parsed.data.trimestre });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: `Ya hay análisis para ese trimestre` });
    if (e?.code === '23503') return res.status(400).json({ error: 'Ruta inexistente' });
    throw e;
  }
});

router.post('/:id/aprobar', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(routeRiskAnalyses).where(eq(routeRiskAnalyses.id, id)).for('update').limit(1);
    if (!current) return { code: 404 as const };
    if (current.estado !== 'borrador') return { code: 409 as const, msg: 'Solo borrador puede aprobarse' };
    const [row] = await tx.update(routeRiskAnalyses).set({
      estado: 'aprobado',
      aprobadoAt: new Date(),
      aprobadoPor: req.user!.sub,
      optimisticV: current.optimisticV + 1,
    }).where(eq(routeRiskAnalyses.id, id)).returning();
    return { code: 200 as const, row };
  });
  if (result.code !== 200) return res.status(result.code).json({ error: (result as any).msg || 'no encontrado' });
  await audit(req, { action: 'update', resource: 'route_risk', resourceId: String(id), detail: 'aprobado (WORM)' });
  res.json(result.row);
});

router.post('/:id/items', requireRole('admin'), async (req: Request, res: Response) => {
  const analisisId = parseInt(req.params.id, 10);
  if (!Number.isFinite(analisisId) || analisisId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });

  // Verificar que el análisis no está aprobado (WORM lo bloquearía pero damos error claro).
  const [a] = await db.select().from(routeRiskAnalyses).where(eq(routeRiskAnalyses.id, analisisId)).limit(1);
  if (!a) return res.status(404).json({ error: 'Análisis no encontrado' });
  if (a.estado === 'aprobado') return res.status(409).json({ error: 'Análisis aprobado (WORM)' });

  const d = parsed.data;
  try {
    const [row] = await db.insert(routeRiskItems).values({
      analisisId,
      peligro: d.peligro,
      probabilidad: d.probabilidad,
      impacto: d.impacto,
      controlesActuales: d.controlesActuales ?? null,
      residualProb: d.residualProb ?? null,
      residualImp: d.residualImp ?? null,
      planAccion: d.planAccion ?? null,
      responsableId: d.responsableId ?? null,
      fechaLimite: d.fechaLimite ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'route_risk_item', resourceId: String(row.id) });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23514') return res.status(400).json({ error: 'probabilidad/impacto fuera de rango (1-5)' });
    throw e;
  }
});

router.patch('/items/:itemId', requireRole('admin'), async (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(itemId) || itemId <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;

  // Bloquear edición si el análisis padre está aprobado.
  const [item] = await db.select().from(routeRiskItems).where(eq(routeRiskItems.id, itemId)).limit(1);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  const [a] = await db.select().from(routeRiskAnalyses).where(eq(routeRiskAnalyses.id, item.analisisId)).limit(1);
  if (a?.estado === 'aprobado') return res.status(409).json({ error: 'Análisis aprobado (WORM)' });

  const [row] = await db.update(routeRiskItems).set({
    ...(d.peligro !== undefined && { peligro: d.peligro }),
    ...(d.probabilidad !== undefined && { probabilidad: d.probabilidad }),
    ...(d.impacto !== undefined && { impacto: d.impacto }),
    ...(d.controlesActuales !== undefined && { controlesActuales: d.controlesActuales ?? null }),
    ...(d.residualProb !== undefined && { residualProb: d.residualProb ?? null }),
    ...(d.residualImp !== undefined && { residualImp: d.residualImp ?? null }),
    ...(d.planAccion !== undefined && { planAccion: d.planAccion ?? null }),
    ...(d.responsableId !== undefined && { responsableId: d.responsableId ?? null }),
    ...(d.fechaLimite !== undefined && { fechaLimite: d.fechaLimite ?? null }),
  }).where(eq(routeRiskItems.id, itemId)).returning();
  await audit(req, { action: 'update', resource: 'route_risk_item', resourceId: String(itemId) });
  res.json(row);
});

router.delete('/items/:itemId', requireRole('admin'), async (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(itemId) || itemId <= 0) return res.status(400).json({ error: 'id inválido' });
  const [item] = await db.select().from(routeRiskItems).where(eq(routeRiskItems.id, itemId)).limit(1);
  if (!item) return res.status(404).json({ error: 'Item no encontrado' });
  const [a] = await db.select().from(routeRiskAnalyses).where(eq(routeRiskAnalyses.id, item.analisisId)).limit(1);
  if (a?.estado === 'aprobado') return res.status(409).json({ error: 'Análisis aprobado (WORM)' });
  await db.delete(routeRiskItems).where(eq(routeRiskItems.id, itemId));
  await audit(req, { action: 'delete', resource: 'route_risk_item', resourceId: String(itemId) });
  res.json({ ok: true });
});

export default router;
