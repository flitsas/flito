import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, desc, isNotNull, lte, asc, ne, inArray } from 'drizzle-orm';
import multer from 'multer';
import { db } from '../../db/client.js';
import { vehicles, vehicleDocuments, documentTypes, alertsSent } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { uploadFleetDocument, getFleetDocumentStream, deleteFleetDocument } from '../../services/storage.js';

const router = Router();
router.use(authMiddleware, requirePage('fleet'));

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ------ Catálogo de tipos de documento ------

router.get('/types', async (_req, res: Response) => {
  const rows = await db.select().from(documentTypes)
    .where(eq(documentTypes.activo, true))
    .orderBy(asc(documentTypes.orden));
  res.json({ data: rows });
});

const typeSchema = z.object({
  codigo: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/),
  nombre: z.string().min(1).max(120),
  requiereVigencia: z.boolean().default(true),
  diasAlerta: z.array(z.number().int().min(0).max(365)).max(10).default([30, 15, 7, 0]),
  destinatariosDefault: z.array(z.string().email()).max(20).default([]),
  orden: z.number().int().min(0).max(9999).default(100),
});

router.post('/types', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [created] = await db.insert(documentTypes).values(parsed.data).returning();
  await audit(req, { action: 'create', resource: 'fleet_document_type', resourceId: String(created.id), detail: created.codigo });
  res.status(201).json({ data: created });
});

router.patch('/types/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = typeSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const [updated] = await db.update(documentTypes).set(parsed.data).where(eq(documentTypes.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'fleet_document_type', resourceId: String(id) });
  res.json({ data: updated });
});

// ------ Documentos por vehículo ------

router.get('/vehicle/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const rows = await db.select({
    id: vehicleDocuments.id,
    tipoId: vehicleDocuments.tipoId,
    tipoCodigo: documentTypes.codigo,
    tipoNombre: documentTypes.nombre,
    numero: vehicleDocuments.numero,
    vigenciaDesde: vehicleDocuments.vigenciaDesde,
    vigenciaHasta: vehicleDocuments.vigenciaHasta,
    estado: vehicleDocuments.estado,
    archivoFilename: vehicleDocuments.archivoFilename,
    archivoSize: vehicleDocuments.archivoSize,
    notas: vehicleDocuments.notas,
    destinatariosExtra: vehicleDocuments.destinatariosExtra,
    createdAt: vehicleDocuments.createdAt,
  })
    .from(vehicleDocuments)
    .leftJoin(documentTypes, eq(documentTypes.id, vehicleDocuments.tipoId))
    .where(and(eq(vehicleDocuments.vehicleId, id), ne(vehicleDocuments.estado, 'archivado')))
    .orderBy(asc(documentTypes.orden));
  res.json({ data: rows });
});

const docSchema = z.object({
  vehicleId: z.coerce.number().int().positive(),
  tipoId: z.coerce.number().int().positive(),
  numero: z.string().max(80).optional().nullable(),
  vigenciaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  vigenciaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  destinatariosExtra: z.preprocess(
    (v) => typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v,
    z.array(z.string().email()).max(20).default([]),
  ),
  notas: z.string().max(1000).optional().nullable(),
});

router.post('/', requireRole('admin'), upload.single('archivo'), async (req: Request, res: Response) => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const [vehicle] = await db.select({ id: vehicles.id, esFlota: vehicles.esFlotaPropia })
    .from(vehicles).where(eq(vehicles.id, data.vehicleId)).limit(1);
  if (!vehicle || !vehicle.esFlota) { res.status(404).json({ error: 'Vehículo de flota no encontrado' }); return; }

  let storageKey: string | null = null;
  let filename: string | null = null;
  let size: number | null = null;
  let mime: string | null = null;
  if (req.file) {
    storageKey = await uploadFleetDocument(data.vehicleId, req.file.originalname, req.file.buffer, req.file.mimetype);
    filename = req.file.originalname.slice(0, 300);
    size = req.file.size;
    mime = req.file.mimetype;
  }

  const [created] = await db.insert(vehicleDocuments).values({
    vehicleId: data.vehicleId,
    tipoId: data.tipoId,
    numero: data.numero ?? null,
    vigenciaDesde: data.vigenciaDesde ?? null,
    vigenciaHasta: data.vigenciaHasta ?? null,
    archivoStorageKey: storageKey,
    archivoFilename: filename,
    archivoSize: size,
    archivoMime: mime,
    destinatariosExtra: data.destinatariosExtra,
    notas: data.notas ?? null,
    subidoPor: req.user?.sub ?? null,
  } as any).returning();

  await audit(req, {
    action: 'upload',
    resource: 'fleet_document',
    resourceId: String(created.id),
    detail: `vehicle=${data.vehicleId} tipo=${data.tipoId}`,
  });
  res.status(201).json({ data: created });
});

const patchSchema = docSchema.omit({ vehicleId: true, tipoId: true }).partial();

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }

  // Si cambia la vigencia, reiniciar las alertas para que el cron pueda volver a disparar.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(vehicleDocuments)
      .set({ ...parsed.data, updatedAt: new Date() } as any)
      .where(eq(vehicleDocuments.id, id))
      .returning();
    if (row && parsed.data.vigenciaHasta !== undefined) {
      await tx.delete(alertsSent).where(eq(alertsSent.documentoId, id));
    }
    return row;
  });

  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'fleet_document', resourceId: String(id) });
  res.json({ data: updated });
});

router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [doc] = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.id, id)).limit(1);
  if (!doc) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (doc.archivoStorageKey) await deleteFleetDocument(doc.archivoStorageKey);
  await db.update(vehicleDocuments).set({ estado: 'archivado', updatedAt: new Date() }).where(eq(vehicleDocuments.id, id));
  await audit(req, { action: 'delete', resource: 'fleet_document', resourceId: String(id) });
  res.json({ ok: true });
});

// Descarga del archivo
router.get('/:id/download', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [doc] = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.id, id)).limit(1);
  if (!doc || !doc.archivoStorageKey) { res.status(404).json({ error: 'Archivo no encontrado' }); return; }
  const stream = await getFleetDocumentStream(doc.archivoStorageKey);
  res.setHeader('Content-Type', doc.archivoMime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.archivoFilename ?? 'documento'}"`);
  stream.pipe(res);
});

// Listado de documentos por vencer (para badges del sidebar y listado global)
router.get('/expiring', async (req: Request, res: Response) => {
  const dias = Math.min(Math.max(parseInt(req.query.dias as string) || 30, 0), 365);
  const limite = new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({
    id: vehicleDocuments.id,
    vehicleId: vehicleDocuments.vehicleId,
    plate: vehicles.plate,
    alias: vehicles.alias,
    tipoNombre: documentTypes.nombre,
    vigenciaHasta: vehicleDocuments.vigenciaHasta,
    estado: vehicleDocuments.estado,
  })
    .from(vehicleDocuments)
    .leftJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
    .leftJoin(documentTypes, eq(documentTypes.id, vehicleDocuments.tipoId))
    .where(and(
      eq(vehicles.esFlotaPropia, true),
      isNotNull(vehicleDocuments.vigenciaHasta),
      inArray(vehicleDocuments.estado, ['vigente', 'por_vencer', 'vencido']),
      lte(vehicleDocuments.vigenciaHasta, limite),
    ))
    .orderBy(asc(vehicleDocuments.vigenciaHasta));
  res.json({ data: rows, count: rows.length });
});

export default router;
