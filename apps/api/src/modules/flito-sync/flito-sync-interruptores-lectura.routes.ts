// FLITO sync — lecturas de la configuración de la sincronización. Se monta desde
// `flito-sync-interruptores.routes.ts` (`router.use`), así que responde bajo `/api/flito/sync`.
//
//   GET /interruptores              `tramites.sincronizacion.configurar` → 200 InterruptoresSincronizacion · 401 · 403
//                                   (HU #13237)
//   GET /flit1/parametros-lectura   `tramites.sincronizacion.configurar` → 200 ParametrosLecturaFlit1 · 401 · 403
//                                   (HU #13628, AC1)
//   GET /flit1/estado-lectura       `tramites.sincronizacion.configurar` O `sync.sync.ver_estado`
//                                   → 200 EstadoLecturaFlit1 · 401 · 403 (HU #13628, AC8)
//
// Reutilizan la función del PUT (no hay función «ver» aparte: quien configura es quien consulta).
// Fichero aparte (como `flit2-probar.routes.ts`) porque el inventario de guardas exige un código por
// guarda en los ficheros de su lista. La respuesta no lleva credenciales de FLIT 2 ni PII: solo
// valores, quién y cuándo. No se audita: son lecturas sin PII.
//
// El O de funciones del estado no crea un `exigirAlgunaFuncion` en `shared/`: si el usuario no tiene
// ninguna de las dos, se delega en `exigirFuncion(configurar)`, que vuelve a decidir, registra el
// intento denegado y responde el MISMO 403 que el resto del API.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, funcionesConcedidas } from '../../shared/middleware/exigir-funcion.js';
import { listarInterruptores } from './flito-sync-interruptor.service.js';
import { leerEstadoLecturaFlit1, leerParametrosLecturaFlit1 } from './flito-sync-flit1-parametros.service.js';

const CONFIGURAR = 'tramites.sincronizacion.configurar';
const VER_ESTADO = 'sync.sync.ver_estado';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

router.get('/interruptores', exigirFuncion(CONFIGURAR), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listarInterruptores());
  } catch (e) {
    next(e);
  }
});

router.get('/flit1/parametros-lectura', exigirFuncion(CONFIGURAR), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await leerParametrosLecturaFlit1());
  } catch (e) {
    next(e);
  }
});

/** Pasa con `configurar` o con `ver_estado`; sin ninguna, el 403 canónico de `exigirFuncion`. */
async function configurarOVerEstado(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) { res.status(401).json({ error: 'Token requerido' }); return; }
  try {
    const concedidas = await funcionesConcedidas(req, [CONFIGURAR, VER_ESTADO]);
    if (concedidas.size > 0) { next(); return; }
  } catch (e) {
    next(e);
    return;
  }
  await exigirFuncion(CONFIGURAR)(req, res, next);
}

router.get('/flit1/estado-lectura', configurarOVerEstado, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await leerEstadoLecturaFlit1());
  } catch (e) {
    next(e);
  }
});

export default router;
