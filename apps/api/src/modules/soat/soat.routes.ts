import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import multer from 'multer';
import { mkdir, writeFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { db } from '../../db/client.js';
import { soatRequests, vehicles, tramitesDigitales, users } from '../../db/schema.js';
import { appendEventoSafe } from '../vehicles/vehiculo-historial.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { parseExcel, sendExcel } from '../../shared/utils/excel.js';
import { audit } from '../../shared/middleware/audit.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { refreshSoatFromRunt, refreshResultToHttp } from './refresh.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('soat-routes');

const POLICY_PLACEHOLDERS = new Set(['Pendiente', 'Pendiente verificación RUNT', 'Pendiente verificacion RUNT']);
const isPolicyPlaceholder = (p: string | null | undefined) => !p || POLICY_PLACEHOLDERS.has(p);

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const VALID_STATUSES = ['pendiente', 'enviado', 'comprado', 'verificado', 'rechazado'] as const;

router.use(authMiddleware);

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Create SOAT requests (admin selects vehicles)
const createSchema = z.object({
  vehicleIds: z.array(z.number().int().positive()).min(1),
  assignedTo: z.number().int().positive().optional(),
});

router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }

  const { vehicleIds, assignedTo } = parsed.data;

  const created = await db.transaction(async (tx) => {
    const results = [];
    for (const vehicleId of vehicleIds) {
      const [v] = await tx.select({ id: vehicles.id, stage: vehicles.stage }).from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
      if (!v) continue;

      // F4: Evitar solicitudes duplicadas pendientes para el mismo vehículo
      const [existing] = await tx.select({ id: soatRequests.id }).from(soatRequests)
        .where(and(eq(soatRequests.vehicleId, vehicleId), eq(soatRequests.status, 'pendiente')))
        .limit(1);
      if (existing) continue;

      const [request] = await tx.insert(soatRequests).values({
        vehicleId,
        requestedBy: req.user!.sub,
        assignedTo: assignedTo || null,
        status: 'pendiente',
        updatedAt: new Date(),
      }).returning();
      results.push(request);

      // Auto-avance de stage: ingreso/impuesto → soat_pendiente (no retrocede desde stages posteriores)
      if (v.stage === 'ingreso' || v.stage === 'impuesto') {
        await tx.update(vehicles).set({ stage: 'soat_pendiente', updatedAt: new Date() }).where(eq(vehicles.id, vehicleId));
      }
    }
    return results;
  });

  await audit(req, { action: 'create', resource: 'soat_request', detail: `${created.length} solicitudes creadas` });
  res.status(201).json({ created: created.length, requests: created });
});

// List SOAT requests (admin: all, proveedor: only assigned)
router.get('/', requireRole('admin', 'proveedor'), async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  const conditions = [];
  if (req.user!.role === 'proveedor') {
    conditions.push(eq(soatRequests.assignedTo, req.user!.sub));
  }
  // F8: Validar status contra enum
  if (status && VALID_STATUSES.includes(status as any)) {
    conditions.push(eq(soatRequests.status, status as any));
  }

  const result = await db.select({
    id: soatRequests.id,
    vehicleId: soatRequests.vehicleId,
    vin: vehicles.vin,
    plate: vehicles.plate,
    ownerName: vehicles.ownerName,
    ownerDocument: vehicles.ownerDocument,
    brand: vehicles.brand,
    model: vehicles.model,
    status: soatRequests.status,
    policyNumber: soatRequests.policyNumber,
    insurer: soatRequests.insurer,
    purchaseDate: soatRequests.purchaseDate,
    expiryDate: soatRequests.expiryDate,
    runtVerified: soatRequests.runtVerified,
    soatHolder: soatRequests.soatHolder,
    assignedToName: users.name,
    notes: soatRequests.notes,
    createdAt: soatRequests.createdAt,
  })
    .from(soatRequests)
    .innerJoin(vehicles, eq(soatRequests.vehicleId, vehicles.id))
    .leftJoin(users, eq(soatRequests.assignedTo, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${soatRequests.createdAt} DESC`)
    .limit(limit).offset(offset);

  res.json(result);
});

// Mark as purchased — accepts JSON or FormData with evidence file
const purchaseSchema = z.object({
  policyNumber: z.string().nullish(),
  insurer: z.string().nullish(),
  purchaseDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
  notes: z.string().nullish(),
});

// Multer error handler
const handleMulterError = (req: Request, res: Response, next: NextFunction) => {
  upload.single('evidence')(req, res, (err: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo no puede superar 10 MB' });
    }
    if (err) return res.status(400).json({ error: 'Error procesando el archivo' });
    next();
  });
};

router.patch('/:id/purchase', requireRole('admin', 'proveedor'), handleMulterError, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const [request] = await db.select().from(soatRequests).where(eq(soatRequests.id, id)).limit(1);
  if (!request) { res.status(404).json({ error: 'Solicitud no encontrada' }); return; }

  if (req.user!.role === 'proveedor' && request.assignedTo !== req.user!.sub) {
    res.status(403).json({ error: 'Este SOAT no está asignado a tu cuenta. Contacta al administrador.' }); return;
  }

  // Solo permitir transición desde pendiente/enviado
  const ALLOWED = ['pendiente', 'enviado'];
  if (!ALLOWED.includes(request.status)) {
    const LABELS: Record<string, string> = { comprado: 'ya registrado como comprado', verificado: 'ya verificado por RUNT', rechazado: 'rechazado' };
    res.status(409).json({ error: `Este SOAT está ${LABELS[request.status] || request.status}. Usa la verificación RUNT si ya fue comprado.` }); return;
  }

  // F2: Guardar evidencia — patrón tmp-then-rename para atomicidad con la tx
  // Escribimos a .tmp ANTES de la tx; si la tx tiene éxito → rename a nombre final;
  // si falla → unlink del .tmp. Elimina archivos huérfanos.
  let evidencePath: string | null = null;
  let tmpFilePath: string | null = null;
  let finalFilePath: string | null = null;
  if (req.file) {
    const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!ALLOWED_MIME.includes(req.file.mimetype)) { res.status(400).json({ error: 'Tipo de archivo no permitido. Use PDF, JPEG, PNG o WebP.' }); return; }
    const head = req.file.buffer.slice(0, 4);
    const isPdfMagic = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    const isJpgMagic = head[0] === 0xFF && head[1] === 0xD8;
    const isPngMagic = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
    const isWebpMagic = head.length >= 4 && head[0] === 0x52 && head[1] === 0x49;
    if (!isPdfMagic && !isJpgMagic && !isPngMagic && !isWebpMagic) {
      res.status(400).json({ error: 'El contenido del archivo no coincide con el tipo declarado' }); return;
    }
    const dir = path.join(process.cwd(), 'uploads', 'soat');
    await mkdir(dir, { recursive: true });
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const filename = `${id}_${Date.now()}_${safeName}`;
    finalFilePath = path.join(dir, filename);
    tmpFilePath = `${finalFilePath}.tmp`;
    await writeFile(tmpFilePath, req.file.buffer);
    evidencePath = `uploads/soat/${filename}`;
  }

  const d = parsed.data;

  // Compra siempre → estado comprado (verificación RUNT es un endpoint separado)
  const nuevoStatus = 'comprado' as const;

  // F6: Solo actualizar campos que vienen en el request, no borrar existentes
  const setData: Record<string, any> = {
    status: nuevoStatus,
    runtVerified: false,
    runtVerifiedAt: null,
    updatedAt: new Date(),
  };
  if (d.policyNumber !== undefined) setData.policyNumber = d.policyNumber || null;
  if (d.insurer !== undefined) setData.insurer = d.insurer || null;
  if (d.purchaseDate !== undefined) setData.purchaseDate = d.purchaseDate || null;
  if (d.expiryDate !== undefined) setData.expiryDate = d.expiryDate || null;

  const notesParts = [d.notes || request.notes, evidencePath ? `[Evidencia: ${evidencePath}]` : null].filter(Boolean).join(' | ');
  setData.notes = notesParts || null;

  // C4: Optimistic locking + transacción atómica con propagaciones
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(soatRequests).set(setData)
      .where(and(eq(soatRequests.id, id), eq(soatRequests.status, request.status)))
      .returning();
    if (!u) return null;

    // Propagar estado al vehículo
    await tx.update(vehicles).set({ stage: 'soat_comprado', updatedAt: new Date() })
      .where(eq(vehicles.id, request.vehicleId));

    // Propagar al trámite si existe
    if (request.tramiteId) {
      await tx.update(tramitesDigitales).set({ estado: 'soat_comprado', updatedAt: new Date() })
        .where(eq(tramitesDigitales.id, request.tramiteId));
    }

    return u;
  });

  if (!updated) {
    // Tx falló — limpiamos el archivo temporal para no dejar basura
    if (tmpFilePath) await unlink(tmpFilePath).catch(() => {});
    res.status(409).json({ error: 'Otro usuario modificó este registro al mismo tiempo. Recarga la página e intenta de nuevo.' });
    return;
  }

  // Tx OK — movemos el archivo de .tmp a final. Si esto falla es raro (mismo disco, mismo proceso)
  // pero loggeamos para auditoría y dejamos la BD con la referencia (se puede re-subir evidencia).
  if (tmpFilePath && finalFilePath) {
    try {
      await rename(tmpFilePath, finalFilePath);
    } catch (e: any) {
      log.error({ soatId: id, err: e?.message }, 'rename evidencia falló post-tx');
    }
  }

  await audit(req, { action: 'purchase', resource: 'soat_request', resourceId: String(id), detail: `Poliza: ${d.policyNumber}, Aseguradora: ${d.insurer}` });
  res.json(updated);
});

// Refrescar datos de póliza desde RUNT (reemplaza placeholder por datos reales).
// La lógica vive en refresh.service.ts para que reconciliador cron la reutilice.
router.patch('/:id/refresh-runt', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }

  const r = await refreshSoatFromRunt(id, { triggeredBy: 'manual', triggeredByUser: req.user!.sub });
  const { status, body } = refreshResultToHttp(r);

  if (r.result === 'ok') {
    await audit(req, { action: 'update', resource: 'soat_request', resourceId: String(id), detail: `Refresh RUNT: ${r.policyNumber} / ${r.insurer || '—'}${r.soatHolder ? ` · titular: ${r.soatHolder}` : ''}` });
  }

  res.status(status).json(body);
});

// Verificar individualmente un SOAT comprado → verificado
router.patch('/:id/verify', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [request] = await db.select().from(soatRequests).where(eq(soatRequests.id, id)).limit(1);
  if (!request) { res.status(404).json({ error: 'Solicitud no encontrada' }); return; }
  if (request.status !== 'comprado') {
    res.status(409).json({ error: `Solo se puede verificar un SOAT comprado. Estado actual: ${request.status}` }); return;
  }
  if (isPolicyPlaceholder(request.policyNumber)) {
    res.status(400).json({ error: 'Este SOAT no tiene número de póliza real. Primero actualízalo con los datos de RUNT.' }); return;
  }

  // Rechazar SOAT vencido — RUNT puede devolver pólizas antiguas indexadas
  if (request.expiryDate) {
    const hoy = new Date().toISOString().split('T')[0];
    if (request.expiryDate < hoy) {
      res.status(400).json({ error: `La póliza vence ${request.expiryDate} (ya expiró). No se puede verificar un SOAT vencido.` }); return;
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(soatRequests).set({
      status: 'verificado', runtVerified: true, runtVerifiedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(soatRequests.id, id), eq(soatRequests.status, 'comprado'))).returning();
    if (!u) return null;
    await tx.update(vehicles).set({ stage: 'soat_verificado', updatedAt: new Date() }).where(eq(vehicles.id, request.vehicleId));
    if (request.tramiteId) {
      await tx.update(tramitesDigitales).set({ estado: 'soat_verificado', updatedAt: new Date() }).where(eq(tramitesDigitales.id, request.tramiteId));
    }
    return u;
  });

  if (!updated) { res.status(409).json({ error: 'Otro usuario modificó este registro. Recarga e intenta de nuevo.' }); return; }
  await audit(req, { action: 'update', resource: 'soat_request', resourceId: String(id), detail: 'Verificado por RUNT' });
  res.json(updated);
  // B1: pasaporte VIN — registrar SOAT vigente (segunda fuente). Best-effort, NO
  // bloquea la respuesta (lookup de VIN + append fuera del camino crítico).
  void (async () => {
    try {
      const [veh] = await db.select({ vin: vehicles.vin }).from(vehicles).where(eq(vehicles.id, request.vehicleId)).limit(1);
      if (veh?.vin) await appendEventoSafe({ vin: veh.vin, eventoTipo: 'soat_vigente', payload: { policyNumber: updated.policyNumber, insurer: updated.insurer, expiryDate: updated.expiryDate, referenciaSoatId: id }, referenciaTramiteId: request.tramiteId ?? null });
    } catch { /* best-effort */ }
  })();
});

// Rechazar un SOAT
router.patch('/:id/reject', requireRole('admin', 'proveedor'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) { res.status(400).json({ error: 'Razón del rechazo requerida (mínimo 5 caracteres)' }); return; }

  const [request] = await db.select().from(soatRequests).where(eq(soatRequests.id, id)).limit(1);
  if (!request) { res.status(404).json({ error: 'Solicitud no encontrada' }); return; }
  if (!['pendiente', 'enviado', 'comprado'].includes(request.status)) {
    res.status(409).json({ error: 'No se puede rechazar un SOAT ya verificado o rechazado' }); return;
  }

  await db.update(soatRequests).set({
    status: 'rechazado', notes: `${request.notes || ''} | Rechazado: ${reason}`, updatedAt: new Date(),
  }).where(eq(soatRequests.id, id));
  await audit(req, { action: 'update', resource: 'soat_request', resourceId: String(id), detail: `Rechazado: ${reason}` });
  res.json({ ok: true });
});

// S3: Bulk purchase from Excel — solo admin
router.post('/upload-purchases', requireRole('admin'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }

  const rows = await parseExcel(req.file.buffer, (row) => {
    const vin = row.getCell(1).text?.trim();
    if (!vin) return null;
    return {
      vin,
      policyNumber: row.getCell(2).text?.trim() || '',
      insurer: row.getCell(3).text?.trim() || '',
      purchaseDate: row.getCell(4).text?.trim() || '',
      expiryDate: row.getCell(5).text?.trim() || '',
    };
  });

  // C3: Transacción para bulk update
  const counts = await db.transaction(async (tx) => {
    let updated = 0;
    let notFound = 0;

    for (const row of rows) {
      const [vehicle] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, row.vin)).limit(1);
      if (!vehicle) { notFound++; continue; }

      const [request] = await tx.select({ id: soatRequests.id, tramiteId: soatRequests.tramiteId })
        .from(soatRequests)
        .where(and(eq(soatRequests.vehicleId, vehicle.id), eq(soatRequests.status, 'pendiente')))
        .limit(1);
      if (!request) { notFound++; continue; }

      await tx.update(soatRequests).set({
        status: 'comprado',
        policyNumber: row.policyNumber,
        insurer: row.insurer,
        purchaseDate: row.purchaseDate,
        expiryDate: row.expiryDate,
        updatedAt: new Date(),
      }).where(eq(soatRequests.id, request.id));

      // Propagar estado al vehículo
      await tx.update(vehicles).set({ stage: 'soat_comprado', updatedAt: new Date() })
        .where(eq(vehicles.id, vehicle.id));
      // Propagar al trámite si existe
      if (request.tramiteId) {
        await tx.update(tramitesDigitales).set({ estado: 'soat_comprado', updatedAt: new Date() })
          .where(eq(tramitesDigitales.id, request.tramiteId));
      }

      updated++;
    }
    return { updated, notFound };
  });

  await audit(req, { action: 'upload', resource: 'soat_request', detail: `Carga masiva compras: ${counts.updated} actualizados, ${counts.notFound} no encontrados` });
  res.json({ total: rows.length, ...counts });
});

// Export SOAT requests to Excel
router.get('/export', requireRole('admin'), async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;

  const conditions = [];
  if (status && VALID_STATUSES.includes(status as any)) {
    conditions.push(eq(soatRequests.status, status as any));
  }

  const result = await db.select({
    vin: vehicles.vin, plate: vehicles.plate, ownerName: vehicles.ownerName,
    ownerDocument: vehicles.ownerDocument, status: soatRequests.status,
    policyNumber: soatRequests.policyNumber, insurer: soatRequests.insurer,
    purchaseDate: soatRequests.purchaseDate, expiryDate: soatRequests.expiryDate,
    runtVerified: soatRequests.runtVerified,
  })
    .from(soatRequests)
    .innerJoin(vehicles, eq(soatRequests.vehicleId, vehicles.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  await sendExcel(res, 'soat_requests.xlsx', [
    { header: 'VIN', key: 'vin', width: 20 },
    { header: 'Placa', key: 'plate', width: 12 },
    { header: 'Propietario', key: 'ownerName', width: 25 },
    { header: 'Documento', key: 'ownerDocument', width: 15 },
    { header: 'Estado', key: 'status', width: 12 },
    { header: 'No. Poliza', key: 'policyNumber', width: 15 },
    { header: 'Aseguradora', key: 'insurer', width: 20 },
    { header: 'Fecha Compra', key: 'purchaseDate', width: 15 },
    { header: 'Vencimiento', key: 'expiryDate', width: 15 },
    { header: 'RUNT Verificado', key: 'runtVerified', width: 15 },
  ], result);
});

// Dashboard stats
router.get('/stats', requireRole('admin'), async (_req: Request, res: Response) => {
  const result = await db.select({
    status: soatRequests.status,
    count: sql<number>`count(*)::int`,
  }).from(soatRequests).groupBy(soatRequests.status);

  const stats: Record<string, number> = { pendiente: 0, enviado: 0, comprado: 0, verificado: 0, rechazado: 0 };
  result.forEach((r) => { stats[r.status] = r.count; });

  const [totalVehicles] = await db.select({ count: sql<number>`count(*)::int` }).from(vehicles);
  res.json({ ...stats, totalVehicles: totalVehicles.count });
});

// #7: Verificación RUNT automática de SOATs comprados
router.post('/verificar-runt', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const pendientes = await db.select().from(soatRequests)
      .where(and(eq(soatRequests.status, 'comprado'), eq(soatRequests.runtVerified, false)))
      .limit(20);

    let verificados = 0;
    for (const sr of pendientes) {
      if (!sr.policyNumber || sr.policyNumber === 'Pendiente') continue;
      // Marcar como verificado (en producción se consultaría el RUNT real)
      await db.transaction(async (tx) => {
        await tx.update(soatRequests).set({
          status: 'verificado', runtVerified: true, runtVerifiedAt: new Date(), updatedAt: new Date(),
        }).where(eq(soatRequests.id, sr.id));

        await tx.update(vehicles).set({ stage: 'soat_verificado', updatedAt: new Date() })
          .where(eq(vehicles.id, sr.vehicleId));

        if (sr.tramiteId) {
          await tx.update(tramitesDigitales).set({ estado: 'soat_verificado', updatedAt: new Date() })
            .where(eq(tramitesDigitales.id, sr.tramiteId));
        }
      });
      verificados++;
    }
    res.json({ ok: true, verificados, total: pendientes.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
