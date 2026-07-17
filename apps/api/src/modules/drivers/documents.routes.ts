import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, asc, ne } from 'drizzle-orm';
import multer from 'multer';
import { db } from '../../db/client.js';
import { users, driverDocuments, driverDocumentTypes, driverAlertsSent } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';
import { audit } from '../../shared/middleware/audit.js';
import { uploadEntityDocument, getEntityDocumentStream, deleteEntityDocument } from '../../services/storage.js';

const router = Router();
router.use(authMiddleware, requirePage('pesv'));

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

router.get('/types', async (_req, res: Response) => {
  const rows = await db.select().from(driverDocumentTypes)
    .where(eq(driverDocumentTypes.activo, true))
    .orderBy(asc(driverDocumentTypes.orden));
  res.json({ data: rows });
});

router.get('/user/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const rows = await db.select({
    id: driverDocuments.id,
    tipoId: driverDocuments.tipoId,
    tipoCodigo: driverDocumentTypes.codigo,
    tipoNombre: driverDocumentTypes.nombre,
    numero: driverDocuments.numero,
    vigenciaDesde: driverDocuments.vigenciaDesde,
    vigenciaHasta: driverDocuments.vigenciaHasta,
    estado: driverDocuments.estado,
    archivoFilename: driverDocuments.archivoFilename,
    archivoSize: driverDocuments.archivoSize,
    notas: driverDocuments.notas,
    destinatariosExtra: driverDocuments.destinatariosExtra,
    createdAt: driverDocuments.createdAt,
  })
    .from(driverDocuments)
    .leftJoin(driverDocumentTypes, eq(driverDocumentTypes.id, driverDocuments.tipoId))
    .where(and(eq(driverDocuments.userId, id), ne(driverDocuments.estado, 'archivado')))
    .orderBy(asc(driverDocumentTypes.orden));
  res.json({ data: rows });
});

const docSchema = z.object({
  userId: z.coerce.number().int().positive(),
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

  const [user] = await db.select({ esConductor: users.esConductor }).from(users).where(eq(users.id, data.userId)).limit(1);
  if (!user || !user.esConductor) { res.status(404).json({ error: 'Conductor no encontrado' }); return; }

  let storageKey: string | null = null;
  let filename: string | null = null;
  let size: number | null = null;
  let mime: string | null = null;
  if (req.file) {
    storageKey = await uploadEntityDocument('drivers/documents', data.userId, req.file.originalname, req.file.buffer, req.file.mimetype);
    filename = req.file.originalname.slice(0, 300);
    size = req.file.size;
    mime = req.file.mimetype;
  }

  const [created] = await db.insert(driverDocuments).values({
    userId: data.userId,
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
    action: 'upload', resource: 'driver_document', resourceId: String(created.id),
    detail: `user=${data.userId} tipo=${data.tipoId}`,
  });
  res.status(201).json({ data: created });
});

const patchSchema = docSchema.omit({ userId: true, tipoId: true }).partial();

router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validación', details: parsed.error.flatten() }); return; }

  // Reset alertas si cambia vigencia.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(driverDocuments)
      .set({ ...parsed.data, updatedAt: new Date() } as any)
      .where(eq(driverDocuments.id, id))
      .returning();
    if (row && parsed.data.vigenciaHasta !== undefined) {
      await tx.delete(driverAlertsSent).where(eq(driverAlertsSent.documentoId, id));
    }
    return row;
  });

  if (!updated) { res.status(404).json({ error: 'No encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'driver_document', resourceId: String(id) });
  res.json({ data: updated });
});

router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [doc] = await db.select().from(driverDocuments).where(eq(driverDocuments.id, id)).limit(1);
  if (!doc) { res.status(404).json({ error: 'No encontrado' }); return; }
  if (doc.archivoStorageKey) await deleteEntityDocument(doc.archivoStorageKey);
  await db.update(driverDocuments).set({ estado: 'archivado', updatedAt: new Date() }).where(eq(driverDocuments.id, id));
  await audit(req, { action: 'delete', resource: 'driver_document', resourceId: String(id) });
  res.json({ ok: true });
});

router.get('/:id/download', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const [doc] = await db.select().from(driverDocuments).where(eq(driverDocuments.id, id)).limit(1);
  if (!doc || !doc.archivoStorageKey) { res.status(404).json({ error: 'Archivo no encontrado' }); return; }
  const stream = await getEntityDocumentStream(doc.archivoStorageKey);
  res.setHeader('Content-Type', doc.archivoMime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.archivoFilename ?? 'documento'}"`);
  stream.pipe(res);
});

export default router;
