// PESV Auto-diagnóstico · Evidencias documentales por estándar.
//
// Endpoints separados del router principal (BICHO A1, A6) para respetar el
// presupuesto de 400 líneas. Montados en `diagnostico.routes.ts` con prefijo
// común `/pesv/diagnostico`.
//
// Reglas críticas:
//   - El frontend NUNCA ve la storageKey real (mitiga path traversal + enumeración).
//     Manejamos un `keyHash = sha256(storageKey).slice(0,16)` — ADR-PESV-001.
//   - Concurrencia: el array `evidencia_keys` se actualiza con `FOR UPDATE` en
//     transacción (BICHO R10).
//   - WORM: cualquier mutación en diagnóstico cerrado retorna 409.
//   - Presigned URLs TTL 300s (ADR-PESV-002) + Cache-Control: no-store (R12).
//   - Audit + pii_access_log SIEMPRE antes de emitir la URL.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pesvDiagnosticos } from '../../db/schema.js';
import { requireRole } from '../../shared/middleware/auth.js';
import { pesvUploadLimiter } from '../../shared/middleware/rateLimiter.js';
import { audit } from '../../shared/middleware/audit.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { loggerFor } from '../../shared/logger.js';
import {
  uploadEntityDocument,
  deleteEntityDocument,
  presignedGetEntityDocument,
  statEntityDocument,
} from '../../services/storage.js';
import { checkMagicNumber } from './magic-number.js';
import {
  pesvEvidenciaUploadTotal,
  pesvEvidenciaUploadSizeBytes,
  pesvEvidenciaUploadInflight,
} from '../../shared/metrics.js';

const log = loggerFor('pesv.evidencias');
const router = Router();

const ALLOWED_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
type AllowedMime = typeof ALLOWED_MIMES[number];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20 MB
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hashKey(storageKey: string): string {
  return crypto.createHash('sha256').update(storageKey).digest('hex').slice(0, 16);
}

function decodeFilename(storageKey: string): string {
  return storageKey.split('/').pop()?.replace(/^\d+_[0-9a-f]+_/, '') ?? 'archivo';
}

// ----------------------------------------------------------------------------
// POST /:id/items/:estandarId/evidencias — upload multipart
// ----------------------------------------------------------------------------
router.post(
  '/:id/items/:estandarId/evidencias',
  pesvUploadLimiter,  // BELK B3: 50 uploads/15min por usuario (contención cuenta comprometida)
  requireRole('admin', 'lider_pesv'),
  upload.single('archivo'),
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const estandarId = parseId(req.params.estandarId);
    if (!id || !estandarId) { res.status(400).json({ error: 'parámetros inválidos' }); return; }
    if (!req.file) { res.status(400).json({ error: 'archivo requerido (multipart field "archivo")' }); return; }

    const mime = req.file.mimetype as AllowedMime;
    const filename = req.file.originalname || 'archivo';
    const buf = req.file.buffer;

    // PESV-07: gauge de concurrencia. dec() en 'finish' cubre todos los caminos
    // (éxito, rechazo o error → errorHandler) sin envolver el handler en try/finally.
    pesvEvidenciaUploadInflight.inc();
    res.on('finish', () => pesvEvidenciaUploadInflight.dec());

    // BELK B1 (PESV-01): validación magic-number ANTES de cualquier I/O. El mime
    // declarado por el navegador no es confiable (un .exe renombrado a .pdf lo
    // reporta como application/pdf y pasa el fileFilter). Rechazamos por contenido.
    const magicError = await checkMagicNumber(buf, mime, ALLOWED_MIMES);
    if (magicError) {
      pesvEvidenciaUploadTotal.inc({ result: 'rejected_magic', mime });
      res.status(400).json({ error: magicError }); return;
    }

    // Validar estado del diagnóstico ANTES de tocar MinIO.
    const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
    if (!diag) {
      pesvEvidenciaUploadTotal.inc({ result: 'rejected_notfound', mime });
      res.status(404).json({ error: 'diagnóstico no encontrado' }); return;
    }
    if (diag.estado === 'cerrado') {
      pesvEvidenciaUploadTotal.inc({ result: 'rejected_worm', mime });
      res.status(409).json({ error: 'diagnóstico cerrado (WORM)' }); return;
    }

    // Upload primero (idempotencia por contenido — defer dedupe por sha256(buf) a sprint 2).
    const storageKey = await uploadEntityDocument('pesv/diagnostico-evidencia', id, filename, buf, mime);
    const keyHash = hashKey(storageKey);

    // Append transaccional al array. FOR UPDATE evita race con otro PATCH/POST simultáneo.
    try {
      const updatedItem = await db.transaction(async (tx) => {
        const lock = await tx.execute(sql`
          SELECT i.diagnostico_id, i.estandar_id, i.score_pct, i.nivel_rubrica,
                 i.evidencia_keys, i.comentarios, i.updated_at,
                 c.codigo, c.paso, c.fase, c.nombre, c.descripcion, c.peso, c.orden
            FROM pesv_diagnostico_items i
            JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
           WHERE i.diagnostico_id = ${id} AND i.estandar_id = ${estandarId}
           FOR UPDATE OF i
        ` as any) as any;
        const lockRow = (lock?.rows?.[0] ?? lock?.[0]) as any;
        if (!lockRow) throw new Error('item_not_found');

        await tx.execute(sql`
          UPDATE pesv_diagnostico_items
             SET evidencia_keys = array_append(evidencia_keys, ${storageKey}),
                 updated_at = NOW()
           WHERE diagnostico_id = ${id} AND estandar_id = ${estandarId}
        ` as any);

        const refreshed = await tx.execute(sql`
          SELECT i.diagnostico_id, i.estandar_id, i.score_pct, i.nivel_rubrica,
                 i.evidencia_keys, i.comentarios, i.updated_at,
                 c.codigo, c.paso, c.fase, c.nombre, c.descripcion, c.peso, c.orden
            FROM pesv_diagnostico_items i
            JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
           WHERE i.diagnostico_id = ${id} AND i.estandar_id = ${estandarId}
        ` as any) as any;
        return (refreshed?.rows?.[0] ?? refreshed?.[0]) as any;
      });

      const evidencias = ((updatedItem.evidencia_keys ?? []) as string[]).map((k) => ({
        keyHash: hashKey(k),
        filename: decodeFilename(k),
        sizeBytes: 0,
        mime: mime,
        uploadedAt: updatedItem.updated_at instanceof Date ? updatedItem.updated_at.toISOString() : String(updatedItem.updated_at),
        uploadedBy: req.user!.sub,
      }));

      await audit(req, {
        action: 'upload', resource: 'pesv_evidence',
        resourceId: `${id}/${estandarId}/${keyHash}`,
        detail: `filename=${filename} size=${buf.length} mime=${mime}`,
      });

      pesvEvidenciaUploadTotal.inc({ result: 'success', mime });
      pesvEvidenciaUploadSizeBytes.observe(buf.length);

      res.status(201).json({
        keyHash,
        filename,
        sizeBytes: buf.length,
        mime,
        uploadedAt: new Date().toISOString(),
        item: {
          diagnosticoId: updatedItem.diagnostico_id,
          estandarId: updatedItem.estandar_id,
          codigo: updatedItem.codigo,
          paso: updatedItem.paso,
          fase: updatedItem.fase,
          nombre: updatedItem.nombre,
          descripcion: updatedItem.descripcion,
          peso: String(updatedItem.peso),
          orden: updatedItem.orden,
          scorePct: String(updatedItem.score_pct),
          nivelRubrica: updatedItem.nivel_rubrica,
          comentarios: updatedItem.comentarios,
          evidencias,
          updatedAt: updatedItem.updated_at instanceof Date ? updatedItem.updated_at.toISOString() : String(updatedItem.updated_at),
        },
      });
    } catch (e: any) {
      log.error({ err: e?.message, id, estandarId, storageKey }, 'append evidencia falló — limpiando MinIO');
      // Rollback best-effort: si no logramos persistir la key, eliminamos el objeto.
      await deleteEntityDocument(storageKey).catch(() => undefined);
      if (e?.message === 'item_not_found') {
        pesvEvidenciaUploadTotal.inc({ result: 'rejected_notfound', mime });
        res.status(404).json({ error: 'ítem no encontrado' }); return;
      }
      pesvEvidenciaUploadTotal.inc({ result: 'error', mime });
      throw e;
    }
  },
);

// ----------------------------------------------------------------------------
// DELETE /:id/items/:estandarId/evidencias/:keyHash — solo en borrador
// ----------------------------------------------------------------------------
router.delete(
  '/:id/items/:estandarId/evidencias/:keyHash',
  requireRole('admin', 'lider_pesv'),
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const estandarId = parseId(req.params.estandarId);
    const keyHash = String(req.params.keyHash || '');
    if (!id || !estandarId || keyHash.length !== 16) { res.status(400).json({ error: 'parámetros inválidos' }); return; }

    const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
    if (!diag) { res.status(404).json({ error: 'diagnóstico no encontrado' }); return; }
    if (diag.estado === 'cerrado') { res.status(409).json({ error: 'diagnóstico cerrado (WORM)' }); return; }

    let storageKey: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const lock = await tx.execute(sql`
          SELECT evidencia_keys FROM pesv_diagnostico_items
           WHERE diagnostico_id = ${id} AND estandar_id = ${estandarId}
           FOR UPDATE
        ` as any) as any;
        const lockRow = (lock?.rows?.[0] ?? lock?.[0]) as any;
        if (!lockRow) throw new Error('item_not_found');

        const keys = (lockRow.evidencia_keys ?? []) as string[];
        storageKey = keys.find((k) => hashKey(k) === keyHash) ?? null;
        if (!storageKey) throw new Error('key_not_found');

        await tx.execute(sql`
          UPDATE pesv_diagnostico_items
             SET evidencia_keys = array_remove(evidencia_keys, ${storageKey}),
                 updated_at = NOW()
           WHERE diagnostico_id = ${id} AND estandar_id = ${estandarId}
        ` as any);
      });
    } catch (e: any) {
      if (e?.message === 'item_not_found') { res.status(404).json({ error: 'ítem no encontrado' }); return; }
      if (e?.message === 'key_not_found') { res.status(404).json({ error: 'evidencia no encontrada' }); return; }
      throw e;
    }

    // Eliminar de MinIO fuera de la tx (idempotente).
    await deleteEntityDocument(storageKey!).catch((e) => {
      log.warn({ err: e?.message, storageKey, id, estandarId }, 'MinIO removeObject falló — key removida del array igual');
    });

    await audit(req, {
      action: 'delete', resource: 'pesv_evidence',
      resourceId: `${id}/${estandarId}/${keyHash}`,
    });
    res.status(204).end();
  },
);

// ----------------------------------------------------------------------------
// GET /:id/items/:estandarId/evidencias/:keyHash — presigned URL temporal
// ----------------------------------------------------------------------------
router.get(
  '/:id/items/:estandarId/evidencias/:keyHash',
  requireRole('admin', 'lider_pesv', 'compliance'),
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const estandarId = parseId(req.params.estandarId);
    const keyHash = String(req.params.keyHash || '');
    if (!id || !estandarId || keyHash.length !== 16) { res.status(400).json({ error: 'parámetros inválidos' }); return; }

    const rows = await db.execute(sql`
      SELECT evidencia_keys FROM pesv_diagnostico_items
       WHERE diagnostico_id = ${id} AND estandar_id = ${estandarId}
    ` as any) as any;
    const row = (rows?.rows?.[0] ?? rows?.[0]) as any;
    if (!row) { res.status(404).json({ error: 'ítem no encontrado' }); return; }

    const keys = (row.evidencia_keys ?? []) as string[];
    const storageKey = keys.find((k) => hashKey(k) === keyHash) ?? null;
    if (!storageKey) { res.status(404).json({ error: 'evidencia no encontrada' }); return; }

    const stat = await statEntityDocument(storageKey);

    // Audit + pii_access_log ANTES de emitir la URL (ADR-PESV-002).
    await audit(req, {
      action: 'view', resource: 'pesv_evidence',
      resourceId: `${id}/${estandarId}/${keyHash}`,
      detail: `presigned ttl=300s`,
    });
    await logPiiAccess(req, {
      resourceTipo: 'pesv_evidence',
      resourceId: id,
      accion: 'read',
      camposAccedidos: ['evidencia_documental'],
      motivo: `pesv_diag=${id} estandar=${estandarId}`,
    });

    const url = await presignedGetEntityDocument(storageKey, 300);
    const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();

    // R12 — no cachear la respuesta para evitar leakage.
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      url,
      expiresAt,
      filename: decodeFilename(storageKey),
      mime: stat?.contentType ?? 'application/octet-stream',
      sizeBytes: stat?.size ?? 0,
    });
  },
);

export default router;
