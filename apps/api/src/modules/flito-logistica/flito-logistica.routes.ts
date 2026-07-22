// FLITO Logística (HTTP). Montado en /api/flito/logistica. Consola de Operaciones (trazabilidad por
// documento, actas, despacho) + endpoints de campo que la PWA del mensajero consumirá en la Fase 2.
// Lectura: Operaciones/Auditoría. Escritura de Operaciones: admin. Campo: admin/mensajero (con scoping).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { EstadoDocumentoLogistica } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  actaDetalle, buscarIdempotencia, cerrarLote, despachar, documentoDetalle, entregar, facetas,
  guardarIdempotencia, listar, listarActas, LogisticaError, miRuta, recoger, registrarDevolucion,
  registrarNovedad, reversar, urlActaPdf, type FiltrosLogistica, type LogisticaCtx,
} from './flito-logistica.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');
const CAMPO = requireRole('admin', 'mensajero');
const LECTURA = requireRole('admin', 'auditor');

function ctxDe(user: { sub: number; username: string; role: string }): LogisticaCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};

/** Ejecuta la acción del servicio y traduce LogisticaError a su código HTTP; el resto es 500. */
async function ejecutar(res: Response, fn: () => Promise<unknown>): Promise<unknown | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LogisticaError) { res.status(error.status).json({ error: error.message, ...(error.extra ? { detalle: error.extra } : {}) }); return undefined; }
    throw error;
  }
}

/**
 * Envuelve una escritura de campo con idempotencia (RN-06/CA-06). Si la petición trae `Idempotency-Key`
 * y ya se procesó, devuelve la respuesta guardada sin re-ejecutar; así un reenvío offline no duplica.
 */
async function conIdempotencia(req: Request, res: Response, run: () => Promise<{ status?: number; body: unknown }>): Promise<void> {
  const key = req.header('Idempotency-Key') || undefined;
  if (key) {
    const prev = await buscarIdempotencia(key);
    if (prev) { res.status(prev.status).json(prev.body); return; }
  }
  try {
    const { status = 200, body } = await run();
    if (key) await guardarIdempotencia(key, status, body);
    res.status(status).json(body);
  } catch (error) {
    if (error instanceof LogisticaError) { res.status(error.status).json({ error: error.message, ...(error.extra ? { detalle: error.extra } : {}) }); return; }
    throw error;
  }
}

// GET / — listado paginado con filtros multiselect (CA-07).
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const q = req.query;
  const filtros: FiltrosLogistica = {
    buscar: str(q.buscar), estados: lista(q.estados), tipos: lista(q.tipos),
    empresas: lista(q.empresas), organismos: lista(q.organismos), actas: lista(q.actas),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
  res.json(await listar(filtros));
});

// GET /facetas — valores para los dropdowns de filtro, compañías cerrables y mensajeros.
router.get('/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

// GET /mi-ruta — ruta del mensajero (PWA): recogidas por organismo + entregas asignadas (CA-11).
router.get('/mi-ruta', CAMPO, async (req: Request, res: Response) => {
  res.json(await miRuta(ctxDe(req.user!)));
});

// GET /actas — panel de despacho/entrega (todas las actas con su estado y mensajero).
router.get('/actas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await listarActas());
});

// GET /actas/:id — detalle del acta: documentos + bitácora del despacho (CA-13).
router.get('/actas/:id', LECTURA, async (req: Request, res: Response) => {
  const r = await ejecutar(res, () => actaDetalle(req.params.id));
  if (r !== undefined) res.json(r);
});

// GET /actas/:id/pdf — URL prefirmada del PDF base del acta (se genera si falta).
router.get('/actas/:id/pdf', LECTURA, async (req: Request, res: Response) => {
  const url = await ejecutar(res, () => urlActaPdf(req.params.id));
  if (url !== undefined) res.json({ url });
});

// GET /:id — detalle del documento + bitácora completa (CA-07).
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const r = await ejecutar(res, () => documentoDetalle(req.params.id));
  if (r !== undefined) res.json(r);
});

// POST /recoger — verificación de recogida en campo (CA-02/CA-03).
const recogerSchema = z.object({ documentoIds: z.array(z.string().uuid()).min(1), lat: z.string().optional(), lng: z.string().optional() });
router.post('/recoger', CAMPO, async (req: Request, res: Response) => {
  const parsed = recogerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await recoger(parsed.data.documentoIds, { lat: parsed.data.lat, lng: parsed.data.lng }, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica', detail: `Recogida: ${JSON.stringify(r)}` });
    return { body: r };
  });
});

// POST /documentos/:id/novedad — motivo obligatorio; bloquea el avance (RN-04).
const motivoSchema = z.object({ motivo: z.string().trim().min(1) });
router.post('/documentos/:id/novedad', CAMPO, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await conIdempotencia(req, res, async () => {
    await registrarNovedad(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica', resourceId: req.params.id, detail: `Novedad: ${parsed.data.motivo}` });
    return { body: { ok: true } };
  });
});

// POST /cerrar-lote — genera el acta de una empresa con sus documentos clasificados (CA-04/08/09).
const cerrarLoteSchema = z.object({ companiaId: z.number().int().positive() });
router.post('/cerrar-lote', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = cerrarLoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await ejecutar(res, () => cerrarLote(parsed.data.companiaId, ctxDe(req.user!)));
  if (r === undefined) return;
  await audit(req, { action: 'create', resource: 'flito_logistica_acta', detail: `Acta generada para compañía ${parsed.data.companiaId}: ${JSON.stringify(r)}` });
  res.json(r);
});

// POST /actas/:id/despachar — asigna mensajero y pone los documentos en 'despachado' (CA-05).
const despacharSchema = z.object({ mensajeroId: z.number().int().positive() });
router.post('/actas/:id/despachar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = despacharSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await ejecutar(res, () => despachar(req.params.id, parsed.data.mensajeroId, ctxDe(req.user!)));
  if (r === undefined) return;
  await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Despacho a mensajero ${parsed.data.mensajeroId}` });
  res.json(r);
});

// POST /actas/:id/entregar — recepción del acta (RN-03: identidad del receptor). CA-11: mensajero solo la suya.
const entregarSchema = z.object({ receptorNombre: z.string().trim().min(1), receptorDocumento: z.string().trim().min(1), lat: z.string().optional(), lng: z.string().optional() });
router.post('/actas/:id/entregar', CAMPO, async (req: Request, res: Response) => {
  const parsed = entregarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await entregar(req.params.id, parsed.data, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Entrega a ${parsed.data.receptorNombre}` });
    return { body: r };
  });
});

// POST /actas/:id/devolucion — receptor ausente/rechazo; motivo obligatorio (CA-10).
router.post('/actas/:id/devolucion', CAMPO, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  await conIdempotencia(req, res, async () => {
    const r = await registrarDevolucion(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_logistica_acta', resourceId: req.params.id, detail: `Devolución: ${parsed.data.motivo}` });
    return { body: r };
  });
});

// POST /documentos/:id/reversar — reversa con justificación (RN-08). Solo Operaciones.
const reversarSchema = z.object({ estadoDestino: z.nativeEnum(EstadoDocumentoLogistica), motivo: z.string().trim().min(1) });
router.post('/documentos/:id/reversar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await ejecutar(res, () => reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctxDe(req.user!)));
  if (r === undefined && res.headersSent) return;
  await audit(req, { action: 'update', resource: 'flito_logistica', resourceId: req.params.id, detail: `Reversa a "${parsed.data.estadoDestino}": ${parsed.data.motivo}` });
  res.json({ ok: true });
});

export default router;
