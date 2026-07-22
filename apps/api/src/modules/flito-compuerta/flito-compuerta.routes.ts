// FLITO Compuerta (HTTP). Porta packages/server/src/compuerta/compuerta.modulo.ts. Montado en
// /api/flito/compuerta. Lectura para Operaciones y Auditoría; entregar solo Operaciones.

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { entregar, evaluar, listar, CompuertaError, type CompuertaCtx } from './flito-compuerta.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('operaciones');
const LECTURA = requireRole('operaciones', 'auditor');

function ctxDe(user: { sub: number; username: string; role: string }): CompuertaCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof CompuertaError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// GET / — trámites en Asignado con veredicto (?soloHabilitados=true filtra a los listos).
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const soloHabilitados = req.query.soloHabilitados === 'true';
  res.json(await listar(soloHabilitados));
});

// GET /:tramiteId — veredicto de un trámite (no escribe).
router.get('/:tramiteId', LECTURA, async (req: Request, res: Response) => {
  try {
    res.json(await evaluar(req.params.tramiteId));
  } catch (e) { handleError(res, e); }
});

// POST /:tramiteId/entregar — Asignado → Entregado, revalidando. Solo Operaciones.
router.post('/:tramiteId/entregar', OPERACIONES, async (req: Request, res: Response) => {
  try {
    const dto = await entregar(req.params.tramiteId, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_tramite', resourceId: req.params.tramiteId, detail: `Entrega confirmada (compuerta). FLIT ${dto.idFlit}.` });
    res.json(dto);
  } catch (e) { handleError(res, e); }
});

export default router;
