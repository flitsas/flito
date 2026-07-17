import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { eq, and, desc, sql, isNull, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvComite, pesvComiteMiembros, pesvComiteActas } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const PERIODICIDADES = ['mensual', 'bimestral', 'trimestral', 'semestral'] as const;
const ROLES = ['presidente', 'secretario', 'lider_pesv', 'vocal', 'representante_conductores', 'hse', 'mantenimiento'] as const;

const comiteCreateSchema = z.object({
  nombre: z.string().min(3).max(150),
  periodicidad: z.enum(PERIODICIDADES).default('trimestral'),
});
const miembroSchema = z.object({
  userId: z.number().int().positive(),
  rol: z.enum(ROLES),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});
const actaCreateSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lugar: z.string().max(200).optional().nullable(),
  agendaMd: z.string().optional().nullable(),
  decisionesMd: z.string().optional().nullable(),
  asistentesIds: z.array(z.number().int().positive()).default([]),
  ausentesIds: z.array(z.number().int().positive()).default([]),
});
const actaUpdateSchema = actaCreateSchema.partial();

function sha256(buf: string): Buffer {
  return crypto.createHash('sha256').update(buf, 'utf8').digest();
}

router.get('/', async (_req, res) => {
  const rows = await db.select().from(pesvComite).orderBy(desc(pesvComite.createdAt));
  res.json({ data: rows });
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [comite] = await db.select().from(pesvComite).where(eq(pesvComite.id, id)).limit(1);
  if (!comite) return res.status(404).json({ error: 'No encontrado' });
  const miembros = await db.select().from(pesvComiteMiembros).where(eq(pesvComiteMiembros.comiteId, id));
  res.json({ ...comite, miembros });
});

router.post('/', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const parsed = comiteCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const [row] = await db.insert(pesvComite).values({
    nombre: parsed.data.nombre,
    periodicidad: parsed.data.periodicidad,
    createdBy: req.user!.sub,
  }).returning();
  await audit(req, { action: 'create', resource: 'pesv_comite', resourceId: String(row.id) });
  res.status(201).json(row);
});

router.post('/:id/miembros', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = miembroSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  try {
    const [row] = await db.insert(pesvComiteMiembros).values({
      comiteId: id,
      userId: parsed.data.userId,
      rol: parsed.data.rol,
      desde: parsed.data.desde,
      hasta: parsed.data.hasta ?? null,
    }).returning();
    await audit(req, { action: 'create', resource: 'pesv_comite_miembro', resourceId: `${id}/${parsed.data.userId}`, detail: parsed.data.rol });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Miembro ya registrado en esa fecha' });
    if (e?.code === '23503') return res.status(400).json({ error: 'Comité o usuario inexistente' });
    throw e;
  }
});

router.delete('/:id/miembros/:userId', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'parámetros inválidos' });
  }
  // Cierre por fecha (no DELETE) — preserva histórico.
  const desde = (req.query.desde as string) || '';
  const today = new Date().toISOString().slice(0, 10);
  await db.update(pesvComiteMiembros)
    .set({ hasta: today })
    .where(and(eq(pesvComiteMiembros.comiteId, id), eq(pesvComiteMiembros.userId, userId), desde ? eq(pesvComiteMiembros.desde, desde) : isNull(pesvComiteMiembros.hasta)));
  await audit(req, { action: 'update', resource: 'pesv_comite_miembro', resourceId: `${id}/${userId}`, detail: 'cierre' });
  res.json({ ok: true });
});

// ============ ACTAS ============

router.get('/:id/actas', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const rows = await db.select().from(pesvComiteActas).where(eq(pesvComiteActas.comiteId, id)).orderBy(desc(pesvComiteActas.fecha));
  res.json({ data: rows });
});

router.post('/:id/actas', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = actaCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;

  const inserted = await db.transaction(async (tx) => {
    // Advisory lock por comité para correlativo sin race.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'pesv_acta:' + id}))`);
    const rows = await tx.execute(sql`SELECT COALESCE(MAX(numero), 0) + 1 AS next FROM pesv_comite_actas WHERE comite_id = ${id}` as any);
    const next = Number((rows as any)?.[0]?.next ?? (rows as any)?.rows?.[0]?.next ?? 1);
    const concat = (data.agendaMd ?? '') + '|' + (data.decisionesMd ?? '');
    const hash = sha256(concat);
    const [row] = await tx.insert(pesvComiteActas).values({
      comiteId: id,
      numero: next,
      fecha: data.fecha,
      lugar: data.lugar ?? null,
      agendaMd: data.agendaMd ?? null,
      decisionesMd: data.decisionesMd ?? null,
      asistentesIds: data.asistentesIds,
      ausentesIds: data.ausentesIds,
      hashSha256: hash,
      createdBy: req.user!.sub,
    }).returning();
    return row;
  });

  await audit(req, { action: 'create', resource: 'pesv_comite_acta', resourceId: String(inserted.id), detail: `comite=${id} num=${inserted.numero}` });
  res.status(201).json(inserted);
});

router.patch('/:id/actas/:actaId', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const actaId = parseInt(req.params.actaId, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(actaId) || actaId <= 0) return res.status(400).json({ error: 'parámetros inválidos' });
  const parsed = actaUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });

  const [current] = await db.select().from(pesvComiteActas).where(and(eq(pesvComiteActas.id, actaId), eq(pesvComiteActas.comiteId, id))).limit(1);
  if (!current) return res.status(404).json({ error: 'Acta no encontrada' });
  if (current.estado === 'cerrada') return res.status(409).json({ error: 'acta cerrada (WORM)' });

  const data = parsed.data;
  const newAgenda = data.agendaMd ?? current.agendaMd;
  const newDec = data.decisionesMd ?? current.decisionesMd;
  const hash = sha256((newAgenda ?? '') + '|' + (newDec ?? ''));

  const [row] = await db.update(pesvComiteActas).set({
    ...(data.fecha !== undefined && { fecha: data.fecha }),
    ...(data.lugar !== undefined && { lugar: data.lugar ?? null }),
    ...(data.agendaMd !== undefined && { agendaMd: data.agendaMd ?? null }),
    ...(data.decisionesMd !== undefined && { decisionesMd: data.decisionesMd ?? null }),
    ...(data.asistentesIds !== undefined && { asistentesIds: data.asistentesIds }),
    ...(data.ausentesIds !== undefined && { ausentesIds: data.ausentesIds }),
    hashSha256: hash,
  }).where(eq(pesvComiteActas.id, actaId)).returning();

  await audit(req, { action: 'update', resource: 'pesv_comite_acta', resourceId: String(actaId) });
  res.json(row);
});

router.post('/:id/actas/:actaId/cerrar', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const actaId = parseInt(req.params.actaId, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(actaId) || actaId <= 0) return res.status(400).json({ error: 'parámetros inválidos' });
  const result = await db.update(pesvComiteActas)
    .set({ estado: 'cerrada' })
    .where(and(eq(pesvComiteActas.id, actaId), eq(pesvComiteActas.comiteId, id), eq(pesvComiteActas.estado, 'borrador')))
    .returning();
  if (!result.length) return res.status(409).json({ error: 'acta no existe o ya está cerrada' });
  await audit(req, { action: 'update', resource: 'pesv_comite_acta', resourceId: String(actaId), detail: 'cerrada (WORM)' });
  res.json(result[0]);
});

export default router;
