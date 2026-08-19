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
import { historialDe } from '../../shared/historial/estado-historial.js';
import { soportesDeSoat } from '../../shared/soportes/soportes-consulta.js';
import { EstadoSoat } from '@operaciones/shared-types';
import {
  asumirEnOperaciones, cambiarProveedor, cargarFactura, cargarFacturasMasivo, cola, contextoSoat,
  devolverAlGestor, facetasCola, detalle, enviarAlGestor,
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

// Helpers de parseo. Filosofía: un valor desconocido se IGNORA, no devuelve 400 — un filtro roto
// no debe tumbar la pantalla de quien está trabajando.
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
const numeros = (v: unknown): number[] | undefined => {
  const l = lista(v)?.map(Number).filter((n) => Number.isFinite(n));
  return l?.length ? l : undefined;
};
/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const fecha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

// GET / — cola con las 3 fronteras, filtrada y paginada.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const estados = lista(req.query.estado)
    ?.filter((s): s is EstadoSoat => (ESTADOS as readonly string[]).includes(s));
  res.json(await cola(ctx, {
    estados, buscar: str(req.query.buscar),
    companias: numeros(req.query.companias),
    organismos: lista(req.query.organismos),
    proveedores: lista(req.query.proveedores),
    // Un valor desconocido se ignora, como el resto de filtros: un filtro roto no tumba la pantalla.
    gestion: req.query.gestion === 'operaciones' || req.query.gestion === 'proveedor' ? req.query.gestion : undefined,
    solicitadoDesde: fecha(req.query.solicitadoDesde), solicitadoHasta: fecha(req.query.solicitadoHasta),
    pagadoDesde: fecha(req.query.pagadoDesde), pagadoHasta: fecha(req.query.pagadoHasta),
    estancado: req.query.estancado === 'si',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  }));
});

// GET /facetas — valores disponibles para los filtros, acotados a lo que el usuario puede ver.
// Va antes de `/:id` para que «facetas» no se interprete como un identificador.
router.get('/facetas', LECTURA, async (req: Request, res: Response) => {
  res.json(await facetasCola(await contextoSoat(req.user!)));
});

// GET /:id — detalle (404-no-403 para el gestor ajeno)
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  res.json(d);
});

// GET /:id/historial — cambios de estado, del más reciente al más antiguo.
//
// Pasa por `detalle()` antes de leer el historial y no directo a la tabla: es lo que aplica la
// frontera del gestor. Sin ese paso, un proveedor podría leer la historia de un SOAT de otro
// consultando su id, que es exactamente lo que el 404-no-403 del detalle evita.
router.get('/:id/historial', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  res.json(await historialDe('soat', req.params.id));
});

/**
 * GET /:id/soportes — los comprobantes cargados de este SOAT, con su enlace firmado.
 *
 * Quien mira un SOAT pagado quiere ver la factura que lo pagó sin salir del detalle: hasta ahora
 * el archivo se cargaba desde aquí y solo se podía consultar desde el reporte de costos, al que
 * el gestor del proveedor ni siquiera entra.
 *
 * Pasa por `detalle()` antes de leer los soportes, por lo mismo que el historial: es ese paso el
 * que aplica la frontera del gestor, y sin él un proveedor podría leer los documentos de un SOAT
 * ajeno consultando su id.
 */
router.get('/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  // Sin caché: una factura cargada hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(await soportesDeSoat(req.params.id));
});

// POST /enviar — Pendiente → En adquisición, atómico (CA-04). Solo Operaciones.
//
// Hay que nombrar un destino, y solo uno: un proveedor, o Operaciones. El proveedor se volvió
// obligatorio en la HU #10979 porque omitirlo dejaba el SOAT en la cola de nadie y sin ANS con el
// que medirlo. Ese riesgo sigue vigente, así que la contingencia (HU #11152) no relaja la regla:
// añade el otro destino, también explícito. Marcar los dos —o ninguno— es un 400, porque un envío
// sin dueño claro es justo lo que ninguna de las dos HU quiere.
const enviarSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  proveedorSoatId: z.string().uuid().optional(),
  gestionOperaciones: z.boolean().optional(),
}).refine(
  (d) => Boolean(d.proveedorSoatId) !== Boolean(d.gestionOperaciones),
  { message: 'Elige el proveedor al que se envía, o marca que lo gestiona Operaciones. Una de las dos, no ambas.' },
);
router.post('/enviar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { ids, proveedorSoatId, gestionOperaciones } = parsed.data;
  const ctx = await contextoSoat(req.user!);
  const resultado = await enviarAlGestor(ids, ctx, { proveedorSoatId, gestionOperaciones });
  if (resultado.enviados.length > 0) {
    const destino = gestionOperaciones ? 'gestión de Operaciones' : `proveedor ${proveedorSoatId}`;
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: resultado.enviados.join(','), detail: `Enviados a ${destino}: ${resultado.enviados.length} (pendiente→en_adquisicion)` });
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
    const soat = await reactivar(req.params.id, parsed.data.motivo, ctx);
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
    const soat = await reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctx);
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

// POST /:id/asumir-operaciones y POST /:id/devolver-gestor — traspaso de gestión por contingencia
// (HU #11153). Solo Operaciones, motivo ≥5 como en la reversa: es la misma clase de decisión, una
// excepción que alguien tendrá que poder explicar después.
//
// Son el ÚNICO camino sancionado para la contingencia sobre un SOAT ya enviado. `/:id/proveedor`
// sigue prohibiendo el salto de proveedor a proveedor En adquisición (RN-05) y no se toca: aquello
// reasigna entre terceros, esto retira el caso de los terceros.
const traspasoSchema = z.object({
  motivo: z.string().min(5, 'El traspaso de gestión exige un motivo que explique el porqué'),
});
router.post('/:id/asumir-operaciones', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = traspasoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await asumirEnOperaciones(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Gestión asumida por Operaciones (proveedor de origen ${soat.proveedorSoatId ?? '—'}): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

const devolverSchema = traspasoSchema.extend({ proveedorSoatId: z.string().uuid() });
router.post('/:id/devolver-gestor', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = devolverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await devolverAlGestor(req.params.id, parsed.data.proveedorSoatId, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Gestión devuelta al proveedor ${parsed.data.proveedorSoatId}: ${parsed.data.motivo.trim()}` });
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
