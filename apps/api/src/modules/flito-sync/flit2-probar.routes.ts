// FLITO sync — «Probar conexión» con FLIT 2 (HU #13063, Feature #13057). Se monta desde
// `flit2.routes.ts` (`router.use`), así que responde en `/api/flito/sync/flit2/acceso/probar`.
//
//   POST /acceso/probar  `tramites.flit2.guardar_acceso` → 200 Flit2PruebaResultado
//                        · 429 limitador (5/min por usuario) · 503 llave_maestra / acceso_descifrado
//
// ¿Por qué un fichero aparte? Probar REUTILIZA el permiso de guardar (decisión del PO: sin código
// nuevo en la 0214), y el catálogo de permisos exige un código por guarda de los ficheros del
// inventario (`inventario-guardas.ts`): la misma guarda en `flit2.routes.ts` sería «código de
// función repetido». Es el precedente de `POST /:id/reanalizar` (`flito-impuestos.analisis.routes.ts`),
// que reutiliza `impuestos.tramite.certificar` desde un fichero fuera del inventario. En el panel de
// permisos, quien tiene «Guardar el acceso a FLIT 2» también puede probarlo.
//
// El desenlace de la prueba es dato (200), no error HTTP: la pantalla lo pinta como aviso. Ninguna
// respuesta lleva la contraseña ni el pase.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { probarConexion } from './flit2-pase.service.js';
import { Flit2Error } from './flit2.errors.js';

const router = Router();
// Explícito aunque el padre ya lo aplica: este router no debe quedar abierto si alguien lo monta solo.
router.use(authMiddleware);

/**
 * 5 por minuto y usuario. Cada prueba pide un pase nuevo a FLIT 2, y FLIT 2 bloquea el acceso tras
 * 5 fallos seguidos: el tope evita que la insistencia desde la pantalla lo provoque. Va después de la
 * guarda: quien no la pasa no consume cuota.
 */
const probarLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flit2-probar'),
  message: { error: 'Demasiadas pruebas de conexión con FLIT 2, espere 1 minuto' },
  store: makeStore('rl:flit2-probar:'),
});

router.post('/acceso/probar', exigirFuncion('tramites.flit2.guardar_acceso'), probarLimiter, async (req: Request, res: Response) => {
  try {
    const { filaId, resultado } = await probarConexion();
    // Solo el desenlace: ni la contraseña ni el pase entran en `audit_logs`.
    await audit(req, {
      action: 'view',
      resource: 'flit2_acceso',
      resourceId: filaId !== null ? String(filaId) : undefined,
      detail: `flit2.acceso.probar: resultado=${resultado.resultado}`,
    });
    res.json(resultado);
  } catch (e) {
    if (e instanceof Flit2Error) {
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

export default router;
