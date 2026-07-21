// FLITO Impuestos (HTTP). Porta packages/server/src/impuestos/impuestos.controlador.ts. Montado en
// /api/flito/impuestos; coexiste con /api/tramites del grande.
//
// Fase 4 P1: factura de venta (precondición del envío). Cola/envío (P2) y recibos (P3) llegan después.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { EstadoImpuesto } from '@operaciones/shared-types';
import {
  cargarFacturaVentaIndividual, cargarFacturasVentaMasivo, ImpuestoError,
  type ArchivoSubido, type ImpuestoCtx,
} from './flito-factura-venta.service.js';
import {
  colaImpuestos, detalleImpuesto, enviarAlGestor, reactivar, rechazar, reversar,
} from './flito-impuestos.service.js';
import { cargarRecibos } from './flito-recibos.service.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin', 'operaciones');
const LECTURA = requireRole('admin', 'operaciones', 'gestor_impuestos', 'auditor');
const OPS_O_GESTOR = requireRole('admin', 'operaciones', 'gestor_impuestos');
const ESTADOS = ['sin_factura', 'retenido', 'pendiente', 'en_gestion', 'pagado', 'rechazado', 'no_aplica'] as const;

const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true); else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoSubido => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size });

/**
 * Contexto del gestor de impuestos: la atadura de visibilidad por organismo vive en
 * users.transito_codigo (§9.3), leída de BD, no del JWT. Para el resto de roles es null.
 */
async function contextoImpuesto(user: { sub: number; username: string; role: string }): Promise<ImpuestoCtx> {
  let transitoCodigo: string | null = null;
  if (user.role === 'gestor_impuestos') {
    const [u] = await db.select({ t: users.transitoCodigo }).from(users).where(eq(users.id, user.sub)).limit(1);
    transitoCodigo = u?.t ?? null;
  }
  return { userId: user.sub, username: user.username, role: user.role, transitoCodigo };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// POST /:id/factura-venta — carga la factura de venta de UN impuesto (precondición). Solo Operaciones.
router.post('/:id/factura-venta', OPERACIONES, upload.single('archivo'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Falta el archivo de la factura de venta' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    await cargarFacturaVentaIndividual(req.params.id, aArchivo(req.file), ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', resourceId: req.params.id, detail: `Factura de venta: ${req.file.originalname}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// POST /facturas-venta — carga MASIVA de facturas de venta (varios archivos o ZIP). Solo Operaciones.
router.post('/facturas-venta', OPERACIONES, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const resultado = await cargarFacturasVentaMasivo(files.map(aArchivo), ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', detail: `Carga masiva facturas de venta: ${resultado.conciliados.length} conciliadas, ${resultado.enRevision.length} en revisión, ${resultado.duplicados.length} duplicadas, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

// Tras una mutación devolvemos el detalle; si el actor ya no puede verlo, confirmación mínima.
async function responderDetalle(res: Response, ctx: ImpuestoCtx, imp: { id: string; estado: string; motivoRechazo: string | null }): Promise<void> {
  const d = await detalleImpuesto(imp.id, ctx);
  res.json(d ?? { id: imp.id, estado: imp.estado, motivoRechazo: imp.motivoRechazo });
}

// GET / — cola con las 2 fronteras (?estado=a,b&buscar=)
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const estadoRaw = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const estados = estadoRaw
    ? estadoRaw.split(',').map((s) => s.trim()).filter((s): s is EstadoImpuesto => (ESTADOS as readonly string[]).includes(s))
    : undefined;
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar : undefined;
  res.json(await colaImpuestos(ctx, estados, buscar));
});

// GET /:id — detalle (404-no-403 para el gestor ajeno)
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const d = await detalleImpuesto(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El impuesto no existe' }); return; }
  res.json(d);
});

// POST /enviar — Pendiente → En gestión, atómico (CA-04). Solo Operaciones.
const enviarSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
router.post('/enviar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const ctx = await contextoImpuesto(req.user!);
  const resultado = await enviarAlGestor(parsed.data.ids, ctx);
  if (resultado.enviados.length > 0) {
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: resultado.enviados.join(','), detail: `Enviados al gestor: ${resultado.enviados.length} (pendiente→en_gestion)` });
  }
  res.json(resultado);
});

const motivoSchema = z.object({ motivo: z.string().min(1, 'El motivo es obligatorio') });

// POST /:id/rechazar — rechazo del gestor. Operaciones o gestor.
router.post('/:id/rechazar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await rechazar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Rechazo: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reactivar — Rechazado → Pendiente. Solo Operaciones.
router.post('/:id/reactivar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await reactivar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Reactivación (rechazado→pendiente): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reversar — reversa manual. Solo Operaciones, motivo ≥5.
const reversarSchema = z.object({
  estadoDestino: z.enum([EstadoImpuesto.SIN_FACTURA, EstadoImpuesto.RETENIDO, EstadoImpuesto.PENDIENTE, EstadoImpuesto.EN_GESTION, EstadoImpuesto.PAGADO, EstadoImpuesto.RECHAZADO, EstadoImpuesto.NO_APLICA]),
  motivo: z.string().min(5, 'La reversa exige un motivo que explique el porqué'),
});
router.post('/:id/reversar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Reversa → ${parsed.data.estadoDestino}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /recibos — carga MASIVA de recibos de pago → Pagado (con/sin marca de agua). Operaciones o
// gestor. `sinMarcaDeAgua` (campo del form) es el defecto para archivos sueltos; en ZIP la copia se
// deduce de la carpeta.
router.post('/recibos', OPS_O_GESTOR, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  const sinMarca = req.body?.sinMarcaDeAgua === 'true' || req.body?.sinMarcaDeAgua === true;
  try {
    const ctx = await contextoImpuesto(req.user!);
    const resultado = await cargarRecibos(files.map(aArchivo), sinMarca, ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', detail: `Carga masiva recibos: ${resultado.conciliados.length} conciliados, ${resultado.enRevision.length} en revisión, ${resultado.complementos.length} complementos, ${resultado.duplicados.length} duplicados, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

export default router;
