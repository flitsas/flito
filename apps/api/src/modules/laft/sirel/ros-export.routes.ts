// Endpoints de export ROS para SIREL (data-entry humano).
//
// Genera PDF (BORRADOR con watermark) + CSV (UTF-8 BOM) y los persiste en MinIO.
// El SHA-256 del CSV se persiste en la BD para detectar regeneraciones y para que el
// oficial pueda verificar integridad del PDF (que imprime el mismo hash al pie).
//
// Idempotencia: regenerar (segunda llamada a POST /export) es seguro — sobrescribe
// los blobs S3 con la misma key estable y vuelve a calcular el SHA. Este patrón es
// deliberado: si el oficial agrega notas o regenera tras corregir un signal, el sistema
// debe reflejar el último estado, no acumular versiones huérfanas.
//
// Rate limit: 20 ops/min (mismo bucket que ros.routes.ts) — generar PDF es costoso.

import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../../db/client.js';
import { laftRosDrafts, laftUnusualOperations, laftCounterparties, users } from '../../../db/schema.js';
import { authMiddleware, requireRole } from '../../../shared/middleware/auth.js';
import { userOrIpKey } from '../../../shared/middleware/rateLimiter.js';
import { laftAudit } from '../audit.service.js';
import { buildRosExport } from './sirel-export.builder.js';
import { putRosExportObject, getRosExportStream, rosExportKey } from './sirel-storage.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-ros-export');

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));

const writeLimiter = rateLimit({
  windowMs: 60_000, max: 20,
  keyGenerator: userOrIpKey('laft-ros-export'),
  message: { error: 'Demasiadas operaciones, espere 1 minuto' },
});

// POST /:id/export — genera PDF + CSV, sube a MinIO, persiste storage_keys + sha256.
router.post('/:id/export', writeLimiter, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const idempKey = req.header('Idempotency-Key');
  if (!idempKey || idempKey.length < 8 || idempKey.length > 80) {
    res.status(400).json({ error: 'Idempotency-Key requerido (8-80 chars)' });
    return;
  }

  const [ros] = await db.select().from(laftRosDrafts).where(eq(laftRosDrafts.id, id));
  if (!ros) { res.status(404).json({ error: 'ROS no encontrado' }); return; }

  // Cargar contraparte vía operación.
  const [op] = await db.select().from(laftUnusualOperations).where(eq(laftUnusualOperations.id, ros.operationId));
  const cp = op?.counterpartyId
    ? (await db.select().from(laftCounterparties).where(eq(laftCounterparties.id, op.counterpartyId)))[0]
    : null;

  // Cargar nombre del oficial firmante (req.user solo trae sub+username+role).
  const userRow = (await db.select({ name: users.name, email: users.email })
    .from(users).where(eq(users.id, req.user!.sub)))[0];

  const { pdf, csv, sha256 } = await buildRosExport({
    ros,
    counterparty: cp ?? null,
    signer: {
      nombre: userRow?.name ?? req.user!.username,
      rol: req.user!.role ?? 'compliance',
      userId: req.user!.sub,
      timestamp: new Date(),
    },
  });

  const pdfKey = rosExportKey(id, 'pdf');
  const csvKey = rosExportKey(id, 'csv');

  try {
    await Promise.all([
      putRosExportObject(pdfKey, pdf, 'application/pdf'),
      putRosExportObject(csvKey, csv, 'text/csv; charset=utf-8'),
    ]);
  } catch (err) {
    log.error({ err, rosId: id }, 'falla subida MinIO export ROS');
    res.status(503).json({ error: 'No se pudo guardar el export en almacenamiento' });
    return;
  }

  const [updated] = await db.update(laftRosDrafts).set({
    exportPdfStorageKey: pdfKey,
    exportCsvStorageKey: csvKey,
    exportSha256: sha256,
  }).where(eq(laftRosDrafts.id, id)).returning();

  await laftAudit(req, {
    action: 'ros_export_generado', resource: 'document', resourceId: id,
    after: { pdfKey, csvKey, sha256 },
  });

  res.json({
    id,
    exportPdfStorageKey: updated.exportPdfStorageKey,
    exportCsvStorageKey: updated.exportCsvStorageKey,
    exportSha256: updated.exportSha256,
  });
});

// GET /:id/export/pdf — descarga PDF firmado.
router.get('/:id/export/pdf', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [ros] = await db.select({ key: laftRosDrafts.exportPdfStorageKey }).from(laftRosDrafts).where(eq(laftRosDrafts.id, id));
  if (!ros?.key) { res.status(404).json({ error: 'Export PDF no generado todavía' }); return; }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ROS-${id}-borrador-sirel.pdf"`);
  try {
    const stream = await getRosExportStream(ros.key);
    stream.pipe(res);
  } catch (err) {
    log.error({ err, rosId: id }, 'falla lectura PDF MinIO');
    if (!res.headersSent) res.status(503).json({ error: 'No se pudo leer el PDF' });
  }
});

// GET /:id/export/csv — descarga CSV.
router.get('/:id/export/csv', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [ros] = await db.select({ key: laftRosDrafts.exportCsvStorageKey }).from(laftRosDrafts).where(eq(laftRosDrafts.id, id));
  if (!ros?.key) { res.status(404).json({ error: 'Export CSV no generado todavía' }); return; }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ROS-${id}-borrador-sirel.csv"`);
  try {
    const stream = await getRosExportStream(ros.key);
    stream.pipe(res);
  } catch (err) {
    log.error({ err, rosId: id }, 'falla lectura CSV MinIO');
    if (!res.headersSent) res.status(503).json({ error: 'No se pudo leer el CSV' });
  }
});

export default router;
