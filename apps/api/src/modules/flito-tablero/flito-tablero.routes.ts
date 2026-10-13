// FLITO Tablero (HTTP). Porta el controlador de packages/server/src/tablero. Montado en
// /api/flito/tablero. Lectura para Operaciones y Auditoría.

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';
import { resolverPermisos } from '../../shared/permisos-efectivos.js';
import { resumen, sinBloquesAjenos } from './flito-tablero.service.js';

const router = Router();
router.use(authMiddleware);


// GET / — resumen de indicadores.
// HU #13426: abierto a `compania` (AC4) — solo los bloques de su compañía.
// HU #13428 (AC4): sin `soat.cola.ver` no sale el bloque de SOAT; sin `impuestos.cola.ver`, el de
// Impuestos. Se mira en la foto de `resolverPermisos` (la misma que acaba de decidir la guarda) y NO con
// `tieneFuncion`: el lector de guardas tomaría cada `tieneFuncion` como una operación montada en `GET /`.
router.get('/', exigirFuncion('tablero.tablero.ver'), async (req: Request, res: Response) => {
  const p = await resolverPermisos(req.user!.sub);
  const ve = (codigo: string) => p.ok && p.funciones.has(codigo);
  const r = await resumen(await alcanceDe(req));
  res.json(sinBloquesAjenos(r, { soat: ve('soat.cola.ver'), impuestos: ve('impuestos.cola.ver') }));
});

export default router;
