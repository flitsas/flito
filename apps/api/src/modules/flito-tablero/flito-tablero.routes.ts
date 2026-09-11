// FLITO Tablero (HTTP). Porta el controlador de packages/server/src/tablero. Montado en
// /api/flito/tablero. Lectura para Operaciones y Auditoría.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { resumen } from './flito-tablero.service.js';

const router = Router();
router.use(authMiddleware);


// GET / — resumen de indicadores.
router.get('/', exigirFuncion('tablero.tablero.ver'), async (_req: Request, res: Response) => {
  res.json(await resumen());
});

export default router;
