import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { eq, and, desc, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvPolicy, users } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { buildPolicyPdf } from './pdf-builder.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';

const slog = loggerFor('pesv-policy');

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

const createSchema = z.object({
  titulo: z.string().min(5).max(200),
  contenidoMd: z.string().min(20),
  pdfStorageKey: z.string().max(500).optional().nullable(),
  vigenciaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vigenciaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const updateSchema = createSchema.partial().extend({
  optimisticV: z.number().int().positive(),
});

function sha256(buf: string): Buffer {
  return crypto.createHash('sha256').update(buf, 'utf8').digest();
}

router.get('/current', async (_req, res) => {
  const [row] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.estado, 'vigente')).limit(1);
  if (!row) return res.status(404).json({ error: 'Sin política vigente' });
  res.json(row);
});

router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rows = await db.select().from(pesvPolicy).orderBy(desc(pesvPolicy.version)).limit(limit);
  res.json({ data: rows });
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [row] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.id, id)).limit(1);
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  res.json(row);
});

router.post('/', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;
  const userId = req.user!.sub;

  const inserted = await db.transaction(async (tx) => {
    const [{ next }] = await tx.execute(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pesv_policy` as any,
    ) as any;
    const version = Number(next) || 1;
    const hash = sha256(data.contenidoMd);
    const [row] = await tx.insert(pesvPolicy).values({
      version,
      titulo: data.titulo,
      contenidoMd: data.contenidoMd,
      pdfStorageKey: data.pdfStorageKey ?? null,
      vigenciaDesde: data.vigenciaDesde,
      vigenciaHasta: data.vigenciaHasta ?? null,
      hashSha256: hash,
      estado: 'borrador',
      createdBy: userId,
    }).returning();
    return row;
  });

  await audit(req, { action: 'create', resource: 'pesv_policy', resourceId: String(inserted.id), detail: `v${inserted.version}` });
  res.status(201).json(inserted);
});

router.patch('/:id', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' });
  const data = parsed.data;

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(pesvPolicy).where(eq(pesvPolicy.id, id)).limit(1);
    if (!current) return null;
    if (current.estado !== 'borrador') {
      throw Object.assign(new Error('solo borrador editable'), { httpStatus: 409 });
    }
    if (current.optimisticV !== data.optimisticV) {
      throw Object.assign(new Error('versión desactualizada (concurrencia)'), { httpStatus: 409 });
    }
    const hash = data.contenidoMd ? sha256(data.contenidoMd) : current.hashSha256;
    const [row] = await tx.update(pesvPolicy).set({
      ...(data.titulo !== undefined && { titulo: data.titulo }),
      ...(data.contenidoMd !== undefined && { contenidoMd: data.contenidoMd }),
      ...(data.pdfStorageKey !== undefined && { pdfStorageKey: data.pdfStorageKey ?? null }),
      ...(data.vigenciaDesde !== undefined && { vigenciaDesde: data.vigenciaDesde }),
      ...(data.vigenciaHasta !== undefined && { vigenciaHasta: data.vigenciaHasta ?? null }),
      hashSha256: hash,
      optimisticV: current.optimisticV + 1,
    }).where(eq(pesvPolicy.id, id)).returning();
    return row;
  }).catch((e) => {
    if (e?.httpStatus) return { __err: e };
    throw e;
  });

  if (!updated) return res.status(404).json({ error: 'No encontrada' });
  if ((updated as any).__err) return res.status((updated as any).__err.httpStatus).json({ error: (updated as any).__err.message });
  await audit(req, { action: 'update', resource: 'pesv_policy', resourceId: String(id) });
  res.json(updated);
});

router.post('/:id/firmar', requireRole('admin', 'lider_pesv'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(pesvPolicy).where(eq(pesvPolicy.id, id)).for('update').limit(1);
    if (!current) return { code: 404 as const };
    if (current.estado !== 'borrador') return { code: 409 as const, msg: 'solo borrador puede firmarse' };

    // Reemplazar la vigente actual antes de poner esta como vigente.
    await tx.update(pesvPolicy)
      .set({ estado: 'reemplazada' })
      .where(and(eq(pesvPolicy.estado, 'vigente'), ne(pesvPolicy.id, id)));

    const [signed] = await tx.update(pesvPolicy).set({
      estado: 'vigente',
      firmadaAt: new Date(),
      firmadaPor: req.user!.sub,
      optimisticV: current.optimisticV + 1,
    }).where(eq(pesvPolicy.id, id)).returning();
    return { code: 200 as const, row: signed };
  });

  if (result.code === 404) return res.status(404).json({ error: 'No encontrada' });
  if (result.code === 409) return res.status(409).json({ error: result.msg });

  // Generar PDF firmado post-tx (best-effort — fallo no rompe la firma).
  try {
    const policy = result.row!;
    const [signer] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    const pdf = await buildPolicyPdf({
      version: policy.version, titulo: policy.titulo, contenidoMd: policy.contenidoMd,
      vigenciaDesde: String(policy.vigenciaDesde),
      vigenciaHasta: policy.vigenciaHasta ? String(policy.vigenciaHasta) : null,
      signer: { nombre: signer?.name ?? `User #${req.user!.sub}`, rol: signer?.role ?? 'admin', userId: req.user!.sub, timestamp: policy.firmadaAt! },
    });
    const key = await uploadEntityDocument('pesv/policy', policy.id, `politica-v${policy.version}-firmada.pdf`, pdf, 'application/pdf');
    await db.update(pesvPolicy).set({
      pdfFirmadoStorageKey: key,
      signatureAlgo: 'sha256-electronica-ley527',
    }).where(eq(pesvPolicy.id, id));
  } catch (e: any) {
    slog.error({ err: e?.message, policyId: id }, 'fallo generar PDF firmado (firma lógica persistida sin PDF)');
  }

  await audit(req, { action: 'update', resource: 'pesv_policy', resourceId: String(id), detail: 'firmada (vigente)' });
  res.json(result.row);
});

router.get('/:id/pdf-firmado', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const [row] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.id, id)).limit(1);
  if (!row) return res.status(404).json({ error: 'No encontrada' });
  if (!row.pdfFirmadoStorageKey) return res.status(404).json({ error: 'PDF firmado no disponible (la política no se ha firmado todavía o el archivo no se generó)' });
  try {
    const { getEntityDocumentStream } = await import('../../services/storage.js');
    const stream = await getEntityDocumentStream(row.pdfFirmadoStorageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="politica-v${row.version}.pdf"`);
    stream.pipe(res);
  } catch (e: any) {
    res.status(500).json({ error: 'Error al recuperar PDF: ' + e?.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  // WORM trigger bloquea DELETE en estado terminal. Solo borrador admite DELETE.
  try {
    const [row] = await db.select().from(pesvPolicy).where(eq(pesvPolicy.id, id)).limit(1);
    if (!row) return res.status(404).json({ error: 'No encontrada' });
    if (row.estado !== 'borrador') return res.status(409).json({ error: 'solo borrador puede eliminarse' });
    await db.delete(pesvPolicy).where(eq(pesvPolicy.id, id));
    await audit(req, { action: 'delete', resource: 'pesv_policy', resourceId: String(id) });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'fallo' });
  }
});

export default router;
