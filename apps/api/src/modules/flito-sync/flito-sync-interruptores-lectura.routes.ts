// FLITO sync — lectura de los interruptores por fuente (HU #13237, Feature #13236). Se monta desde
// `flito-sync-interruptores.routes.ts` (`router.use`), así que responde en `/api/flito/sync/interruptores`.
//
//   GET /interruptores  `tramites.sincronizacion.configurar` → 200 InterruptoresSincronizacion · 401 · 403
//
// Reutiliza la función del PUT (no hay función «ver» aparte: quien configura es quien consulta).
// Fichero aparte (como `flit2-probar.routes.ts`) porque el inventario de guardas exige un código por
// guarda en los ficheros de su lista. La respuesta no lleva credenciales de FLIT 2: solo fuente,
// valor, quién y cuándo, más el maestro del ambiente. No se audita: es una lectura sin PII.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { listarInterruptores } from './flito-sync-interruptor.service.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

router.get('/interruptores', exigirFuncion('tramites.sincronizacion.configurar'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listarInterruptores());
  } catch (e) {
    next(e);
  }
});

export default router;
