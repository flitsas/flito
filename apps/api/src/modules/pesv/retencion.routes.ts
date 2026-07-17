// PESV-S9 · Paso 19 — Políticas de retención documental Ley 594/2000
// CRUD políticas + log de ejecuciones (read-only desde UI, escribe el cron).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvRetencionPoliticas, pesvRetencionLog } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv_retencion'));

const ADMIN_OR_LIDER = ['admin', 'lider_pesv'] as const;
const ACCIONES = ['purgar', 'archivar_offline', 'anonimizar'] as const;

const polSchema = z.object({
  tipoDocumento: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/, 'snake_case minúsculas'),
  retencionAnios: z.number().int().min(1).max(100),
  baseLegal: z.string().min(5).max(200),
  accion: z.enum(ACCIONES).default('archivar_offline'),
  habilitado: z.boolean().default(true),
  notasMd: z.string().max(10000).optional().nullable(),
});

router.get('/politicas', async (_req, res) => {
  const rows = await db.select().from(pesvRetencionPoliticas).orderBy(pesvRetencionPoliticas.tipoDocumento).limit(200);
  res.json({ data: rows });
});

router.post('/politicas', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = polSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(pesvRetencionPoliticas).values({
      ...d, notasMd: d.notasMd ?? null, createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_retencion_politica', resourceId: String(row.id), detail: d.tipoDocumento });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Tipo de documento ya tiene política' });
    throw e;
  }
});

router.patch('/politicas/:id(\\d+)', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const parsed = polSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const expectedV = Number(req.body?.optimisticV);
  if (!Number.isFinite(expectedV)) return res.status(400).json({ error: 'optimisticV requerido' });
  const setData: any = { optimisticV: expectedV + 1, updatedAt: new Date() };
  if (d.tipoDocumento !== undefined) setData.tipoDocumento = d.tipoDocumento;
  if (d.retencionAnios !== undefined) setData.retencionAnios = d.retencionAnios;
  if (d.baseLegal !== undefined) setData.baseLegal = d.baseLegal;
  if (d.accion !== undefined) setData.accion = d.accion;
  if (d.habilitado !== undefined) setData.habilitado = d.habilitado;
  if (d.notasMd !== undefined) setData.notasMd = d.notasMd ?? null;
  const [row] = await db.update(pesvRetencionPoliticas).set(setData)
    .where(and(eq(pesvRetencionPoliticas.id, id), eq(pesvRetencionPoliticas.optimisticV, expectedV)))
    .returning();
  if (!row) return res.status(409).json({ error: 'No encontrada o versión desactualizada' });
  await audit(req, { action: 'update', resource: 'pesv_retencion_politica', resourceId: String(id) });
  res.json(row);
});

router.delete('/politicas/:id(\\d+)', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const result = await db.delete(pesvRetencionPoliticas).where(eq(pesvRetencionPoliticas.id, id)).returning();
  if (!result.length) return res.status(404).json({ error: 'No encontrada' });
  await audit(req, { action: 'delete', resource: 'pesv_retencion_politica', resourceId: String(id) });
  res.json({ ok: true });
});

// Log de ejecuciones — read only para UI (escribe el cron + endpoint /run-now manual)
router.get('/log', async (req, res) => {
  const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const conds: any[] = [];
  if (tipo) conds.push(eq(pesvRetencionLog.tipoDocumento, tipo));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvRetencionLog).where(where).orderBy(desc(pesvRetencionLog.ejecutadoAt)).limit(limit);
  res.json({ data: rows });
});

// Ejecución manual de una política puntual (DRY-RUN por defecto, real con ?confirm=true).
// Solo registra en el log la simulación; el cron diario hace la ejecución real automatizada.
const runSchema = z.object({
  tipoDocumento: z.string().min(2).max(60),
  confirm: z.boolean().default(false),
});
router.post('/run', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const { tipoDocumento, confirm } = parsed.data;
  const [pol] = await db.select().from(pesvRetencionPoliticas)
    .where(eq(pesvRetencionPoliticas.tipoDocumento, tipoDocumento)).limit(1);
  if (!pol) return res.status(404).json({ error: 'Política no encontrada' });
  if (!pol.habilitado) return res.status(409).json({ error: 'Política deshabilitada' });

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - pol.retencionAnios);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // DRY-RUN: cuenta cuántos registros calificarían (no toca datos).
  // El cron real implementará la lógica por tipo (ver retencion.cron.ts).
  let cantidadEstimada = 0;
  // Stub: por ahora sólo registra la corrida sin tocar datos reales en endpoint manual.
  // Producción: el cron diario hace la ejecución real.
  await db.insert(pesvRetencionLog).values({
    politicaId: pol.id,
    tipoDocumento: pol.tipoDocumento,
    cantidadAfectada: confirm ? 0 : cantidadEstimada,
    cutoffDate: cutoffDate,
    accion: pol.accion,
    ejecutadoPorCron: false,
    ejecutadoPorUser: req.user!.sub,
    detalleMd: `Ejecución manual ${confirm ? 'real' : 'dry-run'} desde UI por user ${req.user!.sub}. Cutoff ${cutoffDate}.`,
  });
  await audit(req, {
    action: 'update',
    resource: 'pesv_retencion_run',
    resourceId: String(pol.id),
    detail: `${tipoDocumento} ${confirm ? 'real' : 'dry-run'}`,
  });
  res.json({ ok: true, politica: pol.tipoDocumento, cutoffDate, modo: confirm ? 'real' : 'dry-run', cantidadEstimada });
});

export default router;
