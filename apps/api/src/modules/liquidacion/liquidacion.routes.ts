// TRAM-INNOV-B5-MVP — API de liquidación/pago manual (admin). Montada en /api/liquidaciones.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { crearLiquidacion, listLiquidaciones, getLiquidacion, confirmarPago } from './liquidacion.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));

const itemSchema = z.object({
  descripcion: z.string().min(1).max(200),
  cantidad: z.number().positive().max(1_000_000),
  valorUnitario: z.number().min(0).max(1_000_000_000),
});

const crearSchema = z.object({
  woId: z.number().int().positive().optional(),
  tramiteId: z.number().int().positive().optional(),
  items: z.array(itemSchema).min(1).max(50),
  nota: z.string().max(500).optional(),
}).strict().refine((d) => d.woId || d.tramiteId, { message: 'Requiere woId o tramiteId' });

const pagoSchema = z.object({
  monto: z.number().positive().max(1_000_000_000),
  metodo: z.string().max(20).optional(),
  referencia: z.string().max(120).optional(),
  nota: z.string().max(500).optional(),
}).strict();

// POST / — crear liquidación (borrador) desde OT y/o trámite.
router.post('/', async (req: Request, res: Response) => {
  const parsed = crearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const liq = await crearLiquidacion({ ...parsed.data, userId: req.user!.sub });
    await audit(req, { action: 'create', resource: 'liquidacion', resourceId: String(liq.id), detail: `Liquidación creada (total ${liq.total})` });
    res.status(201).json(liq);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /?woId=&tramiteId= — listar liquidaciones de una OT o trámite.
router.get('/', async (req: Request, res: Response) => {
  const woId = req.query.woId ? Number(req.query.woId) : undefined;
  const tramiteId = req.query.tramiteId ? Number(req.query.tramiteId) : undefined;
  if (!woId && !tramiteId) { res.status(400).json({ error: 'Requiere woId o tramiteId' }); return; }
  try { res.json({ liquidaciones: await listLiquidaciones({ woId, tramiteId }) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /:id — detalle (items + pagos).
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    const liq = await getLiquidacion(id);
    if (!liq) { res.status(404).json({ error: 'Liquidación no encontrada' }); return; }
    res.json(liq);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /:id/confirmar-pago — registrar pago manual + marcar confirmada.
router.post('/:id/confirmar-pago', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = pagoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const r = await confirmarPago({ liquidacionId: id, ...parsed.data, userId: req.user!.sub });
    if (!r.ok) { res.status(r.code === 'not_found' ? 404 : 409).json({ error: r.code }); return; }
    await audit(req, { action: 'update', resource: 'liquidacion', resourceId: String(id), detail: `Pago manual confirmado (${parsed.data.monto})` });
    res.json(r.liquidacion);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
