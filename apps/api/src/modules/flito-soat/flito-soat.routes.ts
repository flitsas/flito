// FLITO — SOAT (HTTP). Portado de packages/server/src/soat/soat.controlador.ts. Opera sobre
// flito_soat; coexiste con el módulo legacy /api/soat (soat_requests). Montado en /api/flito/soat.
//
// Fase 2: workflow. Las rutas de carga de factura (POST /facturas, POST /:id/factura) — única
// vía a Pagado (RN-03) — dependen del OCR y se agregan en la Fase 3.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { EstadoSoat } from '@operaciones/shared-types';
import {
  cambiarProveedor, cola, contextoSoat, detalle, enviarAlGestor,
  reactivar, rechazar, reversar, SoatError,
} from './flito-soat.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('operaciones', 'proveedor', 'auditor');
const OPERACIONES = requireRole('operaciones');
const OPS_O_GESTOR = requireRole('operaciones', 'proveedor');

const ESTADOS = [EstadoSoat.PENDIENTE, EstadoSoat.EN_ADQUISICION, EstadoSoat.PAGADO, EstadoSoat.RECHAZADO] as const;

function handleError(res: Response, e: unknown): void {
  if (e instanceof SoatError) { res.status(e.status).json({ error: e.message }); return; }
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
  estadoDestino: z.enum([EstadoSoat.PENDIENTE, EstadoSoat.EN_ADQUISICION, EstadoSoat.PAGADO, EstadoSoat.RECHAZADO]),
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

export default router;
