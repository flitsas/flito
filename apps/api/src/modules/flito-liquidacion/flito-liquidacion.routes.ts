// FLITO — liquidación del trámite (HTTP). Montado en /api/flito/liquidacion.
//
// Liquidar y facturar son actos contables: los ejecutan Operaciones y el área financiera. Auditoría
// lee. Reversar es más restringido —deshace un sellado— y queda solo en manos de un administrador.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  calcular, eventosDe, facturar, liquidacionDe, liquidar, liquidarLote, LiquidacionError, reversar,
} from './flito-liquidacion.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'financiera', 'auditor');

/**
 * Quién puede liquidar y facturar.
 *
 * Se exporta la LISTA, no solo el middleware, porque la emisión electrónica (HU #11328) hereda de
 * aquí: facturar es el botón, emitir ante la DIAN es el paso siguiente, y no tendría sentido que
 * quien no puede lo primero pudiera lo segundo. Con la lista exportada, una prueba comprueba que
 * `ROLES_POR_ACCION.emitir` sigue coincidiendo con esta; sin ella, cambiar una y no la otra no
 * rompería nada y las dos definiciones se separarían en silencio.
 */
export const ROLES_LIQUIDACION_ESCRITURA = ['admin', 'financiera'] as const;
const ESCRITURA = requireRole(...ROLES_LIQUIDACION_ESCRITURA);
// Deshacer un sellado es más delicado que hacerlo: solo administración.
const REVERSO = requireRole('admin');

/** LiquidacionError es de negocio (400); lo demás sube al error handler. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof LiquidacionError) {
    res.status(400).json({ error: e.message, faltantes: e.faltantes });
    return;
  }
  throw e;
}

// GET /:tramiteId — liquidación vigente, o el cálculo previsualizado si aún no está sellada.
router.get('/:tramiteId', LECTURA, async (req: Request, res: Response) => {
  try {
    const sellada = await liquidacionDe(req.params.tramiteId);
    if (sellada) { res.json({ sellada: true, liquidacion: sellada }); return; }
    res.json({ sellada: false, calculo: await calcular(req.params.tramiteId) });
  } catch (e) { fallo(res, e); }
});

// GET /:tramiteId/eventos — bitácora de liquidar/reversar/facturar.
router.get('/:tramiteId/eventos', LECTURA, async (req: Request, res: Response) => {
  res.json(await eventosDe(req.params.tramiteId));
});

// POST /:tramiteId/liquidar — sella los valores.
router.post('/:tramiteId/liquidar', ESCRITURA, async (req: Request, res: Response) => {
  try {
    const l = await liquidar(req.params.tramiteId, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_liquidacion', resourceId: req.params.tramiteId,
      detail: `Liquidado ${l.idFlit}: total ${l.total} (GMF ${l.valorGmf} sobre base ${l.baseGmf})`,
    });
    res.status(201).json(l);
  } catch (e) { fallo(res, e); }
});

// POST /lote/liquidar — liquidación en lote. Nunca falla entera: reporta cada trámite por separado.
const loteSchema = z.object({ tramiteIds: z.array(z.string().uuid()).min(1).max(200) });
router.post('/lote/liquidar', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = loteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  const r = await liquidarLote(parsed.data.tramiteIds, req.user?.sub ?? null);
  await audit(req, {
    action: 'update', resource: 'flito_liquidacion',
    detail: `Liquidación en lote: ${r.liquidados.length} liquidados, ${r.fallidos.length} sin liquidar`,
  });
  res.json(r);
});

// POST /:tramiteId/reversar — deshace el sellado. Exige motivo y solo antes de facturar.
const reversarSchema = z.object({ motivo: z.string().trim().min(5) });
router.post('/:tramiteId/reversar', REVERSO, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Indica el motivo del reverso (mínimo 5 caracteres)' }); return; }
  try {
    await reversar(req.params.tramiteId, parsed.data.motivo, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_liquidacion', resourceId: req.params.tramiteId,
      detail: `Liquidación reversada: ${parsed.data.motivo}`,
    });
    res.status(204).end();
  } catch (e) { fallo(res, e); }
});

// POST /:tramiteId/facturar — congela definitivamente.
router.post('/:tramiteId/facturar', ESCRITURA, async (req: Request, res: Response) => {
  try {
    const l = await facturar(req.params.tramiteId, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_liquidacion', resourceId: req.params.tramiteId,
      detail: `Facturado ${l.idFlit}: total ${l.total}`,
    });
    res.json(l);
  } catch (e) { fallo(res, e); }
});

export default router;
