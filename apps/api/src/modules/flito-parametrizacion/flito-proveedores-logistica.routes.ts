// HU #14103 — Lecturas de proveedores de logística: `/api/flito/parametrizacion/proveedores-logistica`.
// Conviven hasta F5: el selector de la compañía sigue leyendo de aquí. HU #14334: las escrituras se retiraron; alta, edición,
// estado y baja viven en `flito-proveedores.routes.ts` (ADR-0039 §7.1).
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { impactoProveedorLogistica } from './flito-proveedores-logistica-gestion.service.js';
import { ProveedorLogisticaNoEncontradoError, listarProveedoresLogistica, proveedorLogisticaDto } from './flito-proveedores-logistica.service.js';

const router = Router();
router.use(authMiddleware);

const UUID = z.string().uuid();

router.get('/', exigirFuncion('parametrizacion.proveedores.listar'), async (_req: Request, res: Response) => {
  res.json((await listarProveedoresLogistica()).map(proveedorLogisticaDto));
});

// HU #14148 — cuántas compañías lo tienen y los 3 primeros nombres.
router.get('/:id/impacto', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  if (!UUID.safeParse(req.params.id).success) { res.status(400).json({ error: 'ID inválido' }); return; }
  try {
    res.json(await impactoProveedorLogistica(req.params.id!));
  } catch (e) {
    if (e instanceof ProveedorLogisticaNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
    next(e);
  }
});

export default router;
