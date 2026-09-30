// FLITO sync — estado de la conexión con FLIT 2 (HU #13097, Feature #13060). Se monta desde
// `flit2.routes.ts` (`router.use`), así que responde en `/api/flito/sync/flit2/estado`.
//
//   GET /estado  `sync.sync.ver_estado` → 200 Flit2EstadoConexion · 401 sin token · 403 sin la función
//
// Reutiliza la función del estado del sync de FLIT 1 (0179): no hace falta migración de siembra.
// Fichero aparte (como `flit2-probar.routes.ts`) porque el inventario de guardas exige un código por
// guarda en `flit2.routes.ts`. Sin parámetros; la respuesta no lleva clientId, contraseña, pase,
// cursores ni textos crudos de FLIT 2 (lo garantiza la proyección del servicio). No se audita: es una
// lectura de estado sin PII que la UI repite cada 2 minutos.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { obtenerEstadoConexion } from './flit2-estado.service.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

router.get('/estado', exigirFuncion('sync.sync.ver_estado'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await obtenerEstadoConexion());
  } catch (e) {
    next(e);
  }
});

export default router;
