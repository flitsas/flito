// FLITO Tablero (HTTP). Porta el controlador de packages/server/src/tablero. Montado en
// /api/flito/tablero. Lectura para Operaciones y Auditoría.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { resumen } from './flito-tablero.service.js';

const router = Router();
router.use(authMiddleware);


// GET / — resumen de indicadores.
// HU #13426: abierto a `compania` (AC4) — solo los bloques de su compañía.
router.get('/', exigirFuncion('tablero.tablero.ver'), async (req: Request, res: Response) => {
  res.json(await resumen(await alcanceDe(req)));
});

export default router;
