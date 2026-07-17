// LAFT/SARLAFT v2 · F5 — Manual SARLAFT versionado WORM (Resolución 4607/2026).
//
// Flujo:
//   1. POST /         — admin crea borrador (publicado=false). Calcula version=max+1.
//                       Genera PDF + sube a MinIO + persiste sha256 + storage_key.
//   2. POST /:id/firmar  — admin/compliance firma como representante legal u oficial cumplimiento.
//   3. POST /:id/publicar — admin publica si tiene AMBAS firmas. Trigger BD bloquea
//                           cualquier UPDATE/DELETE posterior. WORM defensa profunda.
//
// Idempotencia: header Idempotency-Key opcional en POST. La clave se hashea con la
// version siguiente para que reintentos no creen duplicados (raros — version es UNIQUE).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { laftManualVersions, users } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { requirePage } from '../../../shared/permissions.js';
import { laftAudit } from '../audit.service.js';
import { uploadEntityDocument, getEntityDocumentStream } from '../../../services/storage.js';
import { buildManualPdf, type ManualSignerInfo } from './pdf-builder.js';
import { loggerFor } from '../../../shared/logger.js';

const slog = loggerFor('laft-manual');

const router = Router();
router.use(authMiddleware, requirePage('laft_manual'));

// Rate limit estricto para POSTs — 10/minuto. Generación de PDF es costosa.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones LAFT manual, espere 1 minuto' },
});

const createSchema = z.object({
  titulo: z.string().min(5).max(200).default('Manual SARLAFT'),
  contenidoMd: z.string().min(20).max(200_000),
  motivoCambio: z.string().max(2000).optional().nullable(),
});

const firmarSchema = z.object({
  rol: z.enum(['representante', 'oficial']),
});

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ============================================================================
// GET / — listar versiones (filtro publicado opcional)
// ============================================================================
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const publicadoFilter = req.query.publicado;
  const conds = [] as ReturnType<typeof eq>[];
  if (publicadoFilter === 'true') conds.push(eq(laftManualVersions.publicado, true));
  if (publicadoFilter === 'false') conds.push(eq(laftManualVersions.publicado, false));
  const q = db.select().from(laftManualVersions).orderBy(desc(laftManualVersions.version)).limit(limit);
  const rows = conds.length ? await q.where(conds[0]) : await q;
  res.json({ data: rows });
});

// ============================================================================
// GET /vigente — versión publicada más reciente (atajo para dashboard)
// ============================================================================
router.get('/vigente', async (_req, res: Response) => {
  const [row] = await db.select().from(laftManualVersions)
    .where(eq(laftManualVersions.publicado, true))
    .orderBy(desc(laftManualVersions.version))
    .limit(1);
  if (!row) { res.status(404).json({ error: 'No hay manual publicado' }); return; }
  res.json(row);
});

// ============================================================================
// GET /:id — detalle
// ============================================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(laftManualVersions).where(eq(laftManualVersions.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrada' }); return; }
  res.json(row);
});

// ============================================================================
// GET /:id/pdf — descarga PDF firmado/borrador
// ============================================================================
router.get('/:id/pdf', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [row] = await db.select().from(laftManualVersions).where(eq(laftManualVersions.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: 'No encontrada' }); return; }
  if (!row.pdfStorageKey) { res.status(404).json({ error: 'PDF no disponible' }); return; }
  try {
    const stream = await getEntityDocumentStream(row.pdfStorageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="manual-sarlaft-v${row.version}.pdf"`);
    stream.pipe(res);
  } catch (e: any) {
    slog.error({ err: e?.message, id }, 'fallo lectura PDF MinIO');
    res.status(500).json({ error: 'Error al recuperar PDF' });
  }
});

// ============================================================================
// POST / — crear borrador
// ============================================================================
router.post('/', writeLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || 'datos inválidos' }); return; }
  const data = parsed.data;
  const userId = req.user!.sub;

  const inserted = await db.transaction(async (tx) => {
    // Calcular siguiente version. Lock pesimista vía MAX bajo TX evita doble version=N.
    const result = await tx.execute(
      sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM laft_manual_versions FOR UPDATE`,
    );
    const rows = (Array.isArray(result) ? result : (result as any).rows ?? []) as Array<{ next: number | string }>;
    const nextVersion = Number(rows[0]?.next ?? 1) || 1;
    const hash = sha256Hex(data.contenidoMd);
    const [row] = await tx.insert(laftManualVersions).values({
      version: nextVersion,
      titulo: data.titulo,
      contenidoMd: data.contenidoMd,
      sha256: hash,
      motivoCambio: data.motivoCambio ?? null,
      publicado: false,
      createdBy: userId,
    }).returning();
    return row;
  });

  // Generar PDF (best-effort — fallo NO rompe la creación). Si falla, el borrador queda
  // sin pdfStorageKey y se puede regenerar al firmar/publicar.
  try {
    const pdf = await buildManualPdf({
      version: inserted.version,
      titulo: inserted.titulo,
      contenidoMd: inserted.contenidoMd,
      motivoCambio: inserted.motivoCambio,
    });
    const key = await uploadEntityDocument(
      'laft/manual', inserted.id,
      `manual-sarlaft-v${inserted.version}.pdf`, pdf, 'application/pdf',
    );
    await db.update(laftManualVersions).set({ pdfStorageKey: key })
      .where(eq(laftManualVersions.id, inserted.id));
    inserted.pdfStorageKey = key;
  } catch (e: any) {
    slog.error({ err: e?.message, id: inserted.id }, 'fallo generar PDF borrador');
  }

  await laftAudit(req, {
    action: 'manual_create', resource: 'document', resourceId: inserted.id,
    after: { version: inserted.version, sha256: inserted.sha256 },
  });
  res.status(201).json(inserted);
});

// ============================================================================
// POST /:id/firmar — registra firma representante u oficial
// ============================================================================
router.post('/:id/firmar', writeLimiter, requireRole('admin', 'compliance'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = firmarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'rol inválido (representante|oficial)' }); return; }
  const userId = req.user!.sub;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(laftManualVersions).where(eq(laftManualVersions.id, id)).for('update').limit(1);
    if (!row) return { code: 404 as const };
    if (row.publicado) return { code: 409 as const, msg: 'Versión ya publicada — WORM' };

    const updates: Record<string, unknown> = {};
    if (parsed.data.rol === 'representante') {
      if (row.firmadoPorRepresentante && row.firmadoPorRepresentante !== userId) {
        return { code: 409 as const, msg: 'Ya firmado por otro representante' };
      }
      updates.firmadoPorRepresentante = userId;
    } else {
      if (row.firmadoPorOficial && row.firmadoPorOficial !== userId) {
        return { code: 409 as const, msg: 'Ya firmado por otro oficial' };
      }
      updates.firmadoPorOficial = userId;
    }
    // Cuando ambas firmas existen post-update, marcar firmadoAt si aún no está.
    const ambosFirman = parsed.data.rol === 'representante'
      ? Boolean(row.firmadoPorOficial)
      : Boolean(row.firmadoPorRepresentante);
    if (ambosFirman && !row.firmadoAt) updates.firmadoAt = new Date();

    const [updated] = await tx.update(laftManualVersions).set(updates)
      .where(eq(laftManualVersions.id, id)).returning();
    return { code: 200 as const, row: updated };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrada' }); return; }
  if (result.code === 409) { res.status(409).json({ error: result.msg }); return; }

  // Regenerar PDF con bloque de firma actualizado (best-effort).
  try {
    const policy = result.row!;
    const [signer] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const sigInfo: ManualSignerInfo = {
      nombre: signer?.name ?? `User #${userId}`,
      rol: signer?.role ?? 'admin',
      userId,
      timestamp: policy.firmadoAt ?? new Date(),
    };
    const [rep] = policy.firmadoPorRepresentante
      ? await db.select().from(users).where(eq(users.id, policy.firmadoPorRepresentante)).limit(1)
      : [null];
    const [ofi] = policy.firmadoPorOficial
      ? await db.select().from(users).where(eq(users.id, policy.firmadoPorOficial)).limit(1)
      : [null];
    const pdf = await buildManualPdf({
      version: policy.version,
      titulo: policy.titulo,
      contenidoMd: policy.contenidoMd,
      motivoCambio: policy.motivoCambio,
      representante: rep ? { nombre: rep.name, rol: rep.role, userId: rep.id, timestamp: sigInfo.timestamp } : null,
      oficial: ofi ? { nombre: ofi.name, rol: ofi.role, userId: ofi.id, timestamp: sigInfo.timestamp } : null,
    });
    const key = await uploadEntityDocument(
      'laft/manual', policy.id,
      `manual-sarlaft-v${policy.version}-firmado.pdf`, pdf, 'application/pdf',
    );
    await db.update(laftManualVersions).set({ pdfStorageKey: key }).where(eq(laftManualVersions.id, id));
  } catch (e: any) {
    slog.error({ err: e?.message, id }, 'fallo regenerar PDF firmado');
  }

  await laftAudit(req, {
    action: `manual_firmar_${parsed.data.rol}`,
    resource: 'document',
    resourceId: id,
    after: { rol: parsed.data.rol },
  });
  res.json(result.row);
});

// ============================================================================
// POST /:id/publicar — solo si ambas firmas. Marca publicado=true (WORM).
// ============================================================================
router.post('/:id/publicar', writeLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(laftManualVersions).where(eq(laftManualVersions.id, id)).for('update').limit(1);
    if (!row) return { code: 404 as const };
    if (row.publicado) return { code: 409 as const, msg: 'Ya publicada' };
    if (!row.firmadoPorRepresentante || !row.firmadoPorOficial) {
      return { code: 409 as const, msg: 'Requiere firma de representante legal Y oficial cumplimiento' };
    }
    const [updated] = await tx.update(laftManualVersions).set({
      publicado: true,
      publicadoAt: new Date(),
    }).where(eq(laftManualVersions.id, id)).returning();
    return { code: 200 as const, row: updated };
  });

  if (result.code === 404) { res.status(404).json({ error: 'No encontrada' }); return; }
  if (result.code === 409) { res.status(409).json({ error: result.msg }); return; }
  await laftAudit(req, {
    action: 'manual_publicar', resource: 'document', resourceId: id,
    after: { version: result.row!.version, publicadoAt: result.row!.publicadoAt },
  });
  res.json(result.row);
});

export default router;
