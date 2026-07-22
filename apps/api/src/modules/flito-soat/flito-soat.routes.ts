// FLITO — SOAT (HTTP). Portado de packages/server/src/soat/soat.controlador.ts. Opera sobre
// flito_soat; coexiste con el módulo legacy /api/soat (soat_requests). Montado en /api/flito/soat.
//
// Fase 3: carga de factura (POST /:id/factura, POST /facturas) — única vía a Pagado (RN-03),
// sobre el motor OCR Anthropic (modules/flito-ocr) y storage S3.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { EstadoSoat } from '@operaciones/shared-types';
import {
  cambiarProveedor, cargarFactura, cargarFacturasMasivo, cola, contextoSoat, detalle, enviarAlGestor,
  reactivar, rechazar, reversar, SoatError, type ArchivoSubido,
} from './flito-soat.service.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';

const router = Router();
router.use(authMiddleware);

const MIMES_FACTURA = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    // Un ZIP puede venir con mimetype genérico; se acepta por extensión y se valida su contenido al expandir.
    const ok = MIMES_FACTURA.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoSubido => ({
  originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size,
});

const LECTURA = requireRole('admin', 'proveedor', 'auditor');
const OPERACIONES = requireRole('admin');
const OPS_O_GESTOR = requireRole('admin', 'proveedor');

const ESTADOS = [EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD] as const;

function handleError(res: Response, e: unknown): void {
  if (e instanceof SoatError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// Tras una mutación devolvemos el detalle; si el actor ya no puede verlo (p.ej. el gestor tras
// rechazar: el registro sale de su bandeja), devolvemos una confirmación mínima en vez de null.
async function responderDetalle(res: Response, ctx: Awaited<ReturnType<typeof contextoSoat>>, soat: { id: string; estado: string; motivoRechazo: string | null }): Promise<void> {
  const d = await detalle(soat.id, ctx);
  res.json(d ?? { id: soat.id, estado: soat.estado, motivoRechazo: soat.motivoRechazo });
}

// GET / — cola con las 3 fronteras (?estado=a,b&buscar=)
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const estadoRaw = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const estados = estadoRaw
    ? estadoRaw.split(',').map((s) => s.trim()).filter((s): s is EstadoSoat => (ESTADOS as readonly string[]).includes(s))
    : undefined;
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar : undefined;
  res.json(await cola(ctx, estados, buscar));
});

// GET /:id — detalle (404-no-403 para el gestor ajeno)
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  res.json(d);
});

// POST /enviar — Pendiente → En adquisición, atómico (CA-04). Solo Operaciones.
const enviarSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  proveedorSoatId: z.string().uuid().optional(),
});
router.post('/enviar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const ctx = await contextoSoat(req.user!);
  const resultado = await enviarAlGestor(parsed.data.ids, ctx, parsed.data.proveedorSoatId);
  if (resultado.enviados.length > 0) {
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: resultado.enviados.join(','), detail: `Enviados al gestor: ${resultado.enviados.length} (pendiente→en_adquisicion)` });
  }
  res.json(resultado);
});

const motivoSchema = z.object({ motivo: z.string().min(1, 'El motivo es obligatorio') });

// POST /:id/rechazar — rechazo del proveedor (CA-08). Operaciones o gestor.
router.post('/:id/rechazar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await rechazar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Rechazo: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reactivar — Rechazado → Pendiente (CA-08). Solo Operaciones.
router.post('/:id/reactivar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await reactivar(req.params.id, parsed.data.motivo);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Reactivación (rechazado→pendiente): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reversar — reversa manual (RN-06). Solo Operaciones, motivo ≥5.
const reversarSchema = z.object({
  estadoDestino: z.enum([EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD]),
  motivo: z.string().min(5, 'La reversa exige un motivo que explique el porqué'),
});
router.post('/:id/reversar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Reversa → ${parsed.data.estadoDestino}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/proveedor — cambio de proveedor (RN-05). Solo Operaciones.
const cambiarProveedorSchema = z.object({ proveedorSoatId: z.string().uuid(), motivo: z.string().min(1) });
router.post('/:id/proveedor', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = cambiarProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const { soat, anterior } = await cambiarProveedor(req.params.id, parsed.data.proveedorSoatId, parsed.data.motivo);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Cambio de proveedor ${anterior ?? '—'} → ${parsed.data.proveedorSoatId}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/factura — carga de UNA factura de un SOAT puntual. Única vía a Pagado (RN-03).
// Operaciones o el gestor del proveedor. Campo de archivo: "archivo".
router.post('/:id/factura', OPS_O_GESTOR, upload.single('archivo'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Falta el archivo de la factura' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const d = await cargarFactura(req.params.id, aArchivo(req.file), ctx);
    await audit(req, { action: 'upload', resource: 'flito_soat', resourceId: req.params.id, detail: `Carga de factura SOAT: ${req.file.originalname}` });
    res.json(d ?? { id: req.params.id });
  } catch (e) { handleError(res, e); }
});

// POST /facturas — carga MASIVA (varios archivos o un ZIP). El OCR enruta cada comprobante a un SOAT
// en adquisición; los que cruzan y superan el umbral se pagan, el resto va a revisión (CA-06).
router.post('/facturas', OPS_O_GESTOR, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const resultado = await cargarFacturasMasivo(files.map(aArchivo), ctx);
    await audit(req, { action: 'upload', resource: 'flito_soat', detail: `Carga masiva SOAT: ${resultado.pagados.length} pagados, ${resultado.enRevision.length} en revisión, ${resultado.duplicados.length} duplicados, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

export default router;
