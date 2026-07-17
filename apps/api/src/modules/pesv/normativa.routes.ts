// PESV-S9 · Paso 1.7 — Tracker de normativa aplicable
// CRUD + endpoint /revisar para registrar revisión periódica con audit append-only.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql, lte, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvNormativa, pesvNormativaRevisiones } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv_normativa'));

const ADMIN_OR_LIDER = ['admin', 'lider_pesv'] as const;
const TIPOS = ['ley', 'decreto', 'resolucion', 'concepto', 'circular', 'norma_tecnica'] as const;

const normSchema = z.object({
  codigo: z.string().min(3).max(80).regex(/^[A-Z0-9-_/.]+$/i, 'código alfanumérico'),
  tipo: z.enum(TIPOS),
  titulo: z.string().min(5).max(2000),
  emisor: z.string().min(2).max(120),
  fechaPublicacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vigente: z.boolean().default(true),
  aplicaA: z.array(z.string().min(1).max(30)).max(20).default([]),
  urlOficial: z.string().url().max(500).optional().nullable(),
  resumenMd: z.string().max(20000).optional().nullable(),
  proximaRevisionAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  notasMd: z.string().max(20000).optional().nullable(),
});

router.get('/', async (req, res) => {
  const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined;
  const aplicaA = typeof req.query.aplicaA === 'string' ? req.query.aplicaA : undefined;
  const vigentes = req.query.vigentes === 'true' || req.query.vigentes === undefined; // default true
  const proximas = req.query.proximas === 'true'; // próximas a vencer (30 días)
  const conds: any[] = [];
  if (tipo) conds.push(eq(pesvNormativa.tipo, tipo as any));
  if (aplicaA) conds.push(sql`${aplicaA} = ANY(${pesvNormativa.aplicaA})`);
  if (vigentes) conds.push(eq(pesvNormativa.vigente, true));
  if (proximas) {
    const lim = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    conds.push(lte(pesvNormativa.proximaRevisionAt, lim));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pesvNormativa).where(where).orderBy(pesvNormativa.proximaRevisionAt).limit(500);
  res.json({ data: rows });
});

router.get('/:id(\\d+)', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(pesvNormativa).where(eq(pesvNormativa.id, id)).limit(1);
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  const revisiones = await db.select().from(pesvNormativaRevisiones)
    .where(eq(pesvNormativaRevisiones.normativaId, id))
    .orderBy(desc(pesvNormativaRevisiones.revisadaAt))
    .limit(50);
  res.json({ ...row, revisiones });
});

router.post('/', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const parsed = normSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  try {
    const [row] = await db.insert(pesvNormativa).values({
      codigo: d.codigo,
      tipo: d.tipo,
      titulo: d.titulo,
      emisor: d.emisor,
      fechaPublicacion: d.fechaPublicacion,
      vigente: d.vigente,
      aplicaA: d.aplicaA,
      urlOficial: d.urlOficial ?? null,
      resumenMd: d.resumenMd ?? null,
      proximaRevisionAt: new Date(d.proximaRevisionAt),
      notasMd: d.notasMd ?? null,
      createdBy: req.user!.sub,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_normativa', resourceId: String(row.id), detail: d.codigo });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Código de normativa duplicado' });
    throw e;
  }
});

router.patch('/:id(\\d+)', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const parsed = normSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const expectedV = Number(req.body?.optimisticV);
  if (!Number.isFinite(expectedV)) return res.status(400).json({ error: 'optimisticV requerido' });
  const setData: any = { optimisticV: expectedV + 1, updatedAt: new Date() };
  if (d.codigo !== undefined) setData.codigo = d.codigo;
  if (d.tipo !== undefined) setData.tipo = d.tipo;
  if (d.titulo !== undefined) setData.titulo = d.titulo;
  if (d.emisor !== undefined) setData.emisor = d.emisor;
  if (d.fechaPublicacion !== undefined) setData.fechaPublicacion = d.fechaPublicacion;
  if (d.vigente !== undefined) setData.vigente = d.vigente;
  if (d.aplicaA !== undefined) setData.aplicaA = d.aplicaA;
  if (d.urlOficial !== undefined) setData.urlOficial = d.urlOficial ?? null;
  if (d.resumenMd !== undefined) setData.resumenMd = d.resumenMd ?? null;
  if (d.proximaRevisionAt !== undefined) setData.proximaRevisionAt = new Date(d.proximaRevisionAt);
  if (d.notasMd !== undefined) setData.notasMd = d.notasMd ?? null;
  const [row] = await db.update(pesvNormativa).set(setData)
    .where(and(eq(pesvNormativa.id, id), eq(pesvNormativa.optimisticV, expectedV)))
    .returning();
  if (!row) return res.status(409).json({ error: 'No encontrada o versión desactualizada' });
  await audit(req, { action: 'update', resource: 'pesv_normativa', resourceId: String(id) });
  res.json(row);
});

// Marcar como revisada (registra audit + actualiza ultima_revision_at + setea próxima).
const revSchema = z.object({
  cambiosObservados: z.string().max(5000).optional().nullable(),
  proximaRevisionAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});
router.post('/:id(\\d+)/revisar', requireRole(...ADMIN_OR_LIDER), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const parsed = revSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const d = parsed.data;
  const proxima = new Date(d.proximaRevisionAt);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [n] = await tx.select().from(pesvNormativa).where(eq(pesvNormativa.id, id)).for('update').limit(1);
    if (!n) return { code: 404 as const };
    await tx.insert(pesvNormativaRevisiones).values({
      normativaId: id,
      revisadaAt: now,
      revisadaPor: req.user!.sub,
      cambiosObservados: d.cambiosObservados ?? null,
      proximaRevisionAt: proxima,
    });
    const [updated] = await tx.update(pesvNormativa).set({
      ultimaRevisionAt: now,
      ultimaRevisionPor: req.user!.sub,
      proximaRevisionAt: proxima,
      optimisticV: n.optimisticV + 1,
      updatedAt: now,
    }).where(eq(pesvNormativa.id, id)).returning();
    return { code: 200 as const, row: updated };
  });
  if (result.code !== 200) return res.status(result.code).json({ error: 'No encontrada' });
  await audit(req, { action: 'update', resource: 'pesv_normativa_revisada', resourceId: String(id) });
  res.json(result.row);
});

router.delete('/:id(\\d+)', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const result = await db.delete(pesvNormativa).where(eq(pesvNormativa.id, id)).returning();
  if (!result.length) return res.status(404).json({ error: 'No encontrada' });
  await audit(req, { action: 'delete', resource: 'pesv_normativa', resourceId: String(id) });
  res.json({ ok: true });
});

export default router;
