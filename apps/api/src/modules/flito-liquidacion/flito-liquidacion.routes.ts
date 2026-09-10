// FLITO — liquidación del trámite (HTTP). Montado en /api/flito/liquidacion.
//
// Liquidar y facturar son actos contables: los ejecutan Operaciones y el área financiera. Auditoría
// lee. Reversar es más restringido —deshace un sellado— y queda solo en manos de un administrador.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  calcular, eventosDe, facturar, liquidacionDe, liquidar, liquidarLote, LiquidacionBloqueadaError,
  LiquidacionError, reversar,
} from './flito-liquidacion.service.js';

const router = Router();
router.use(authMiddleware);

// Quién puede liquidar y facturar lo decide el motor (`exigirFuncion`, HU #12083) con el reparto
// sembrado: de partida, `admin` y `financiera` (`liquidacion.liquidacion.liquidar`, `.facturar`) y
// solo `admin` para deshacer un sellado (`.reversar`). La emisión electrónica (HU #11328) hereda de
// «facturar»: `siigo-facturacion.routes.test.ts` compara `ROLES_POR_ACCION.emitir` con los roles de
// partida de `liquidacion.liquidacion.facturar` en la foto, para que las dos definiciones no se
// separen en silencio.

/**
 * LiquidacionError es de negocio (400); lo demás sube al error handler.
 *
 * 422 = la petición es válida pero el trámite no es procesable en este estado: le falta un valor
 * (una tarifa sin vigencia en su fecha de aprobación, AC9 de la HU #12374). Mismo cuerpo
 * `{ error, faltantes }` que el 400 (precedente de 422 por estado: LAFT `aros.routes.ts`).
 */
function fallo(res: Response, e: unknown): void {
  if (e instanceof LiquidacionBloqueadaError) {
    res.status(422).json({ error: e.message, faltantes: e.faltantes });
    return;
  }
  if (e instanceof LiquidacionError) {
    res.status(400).json({ error: e.message, faltantes: e.faltantes });
    return;
  }
  throw e;
}

// GET /:tramiteId — liquidación vigente, o el cálculo previsualizado si aún no está sellada.
router.get('/:tramiteId', exigirFuncion('liquidacion.liquidacion.ver'), async (req: Request, res: Response) => {
  try {
    const sellada = await liquidacionDe(req.params.tramiteId);
    if (sellada) { res.json({ sellada: true, liquidacion: sellada }); return; }
    res.json({ sellada: false, calculo: await calcular(req.params.tramiteId) });
  } catch (e) { fallo(res, e); }
});

// GET /:tramiteId/eventos — bitácora de liquidar/reversar/facturar.
router.get('/:tramiteId/eventos', exigirFuncion('liquidacion.liquidacion.ver_eventos'), async (req: Request, res: Response) => {
  res.json(await eventosDe(req.params.tramiteId));
});

// POST /:tramiteId/liquidar — sella los valores.
router.post('/:tramiteId/liquidar', exigirFuncion('liquidacion.liquidacion.liquidar'), async (req: Request, res: Response) => {
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
router.post('/lote/liquidar', exigirFuncion('liquidacion.liquidacion.liquidar_lote'), async (req: Request, res: Response) => {
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
router.post('/:tramiteId/reversar', exigirFuncion('liquidacion.liquidacion.reversar'), async (req: Request, res: Response) => {
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
router.post('/:tramiteId/facturar', exigirFuncion('liquidacion.liquidacion.facturar'), async (req: Request, res: Response) => {
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
