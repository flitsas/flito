// Siigo — resolver a mano una emisión que se quedó a medias (HU #11326). En /api/siigo/reconciliacion.
//
// **Es la salida del último estado que no la tenía.** La reconciliación automática se niega —con
// razón— a concluir que una factura no existe cuando no ha podido comprobarlo, y hay casos en que no
// puede comprobarlo nunca: un cliente con más facturas en la ventana de las que caben en el tope de
// páginas, un identificador FLIT ambiguo, una compañía sin tercero vinculado. Esa fila se quedaba
// `en_proceso` para siempre, con su trámite retenido por el índice de facturas vivas.
//
// Lo que este endpoint aporta no es una decisión distinta: es la MISMA decisión, tomada por alguien
// que sí puede averiguarla porque ha entrado a Siigo Nube a mirarlo. Por eso pide el veredicto —
// existe o no existe— en vez de ofrecer un botón de «desbloquear», que invitaría a pulsar sin mirar.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import {
  resolverHuerfanaAMano, SiigoReconciliacionError,
} from './facturacion.reconciliacion.service.js';

const router = Router();
router.use(authMiddleware);

/**
 * Limitador estricto.
 *
 * Cada llamada afirma algo sobre un documento ante la DIAN y libera —o da por buena— una factura.
 * No es una pantalla que se recargue: son unas pocas decisiones al día, tomadas de una en una
 * después de mirar. Un tope bajo es lo coherente con eso, y acota el daño de un guion que llame en
 * bucle.
 */
const resolverLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  keyGenerator: userOrIpKey('siigo-reconciliar'),
  message: { error: 'Demasiadas resoluciones manuales seguidas. Espera un momento.' },
  store: makeStore('rl:siigo-reconciliar:'),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El cuerpo obliga a decir CUÁL de las dos cosas se comprobó.
 *
 * `existe: true` exige el identificador de Siigo, y no por formalismo: sin él la fila quedaría
 * `emitida` sin nada con que reconciliar después, y un CHECK de la tabla lo rechazaría de todos
 * modos. Pedirlo aquí convierte ese rechazo en un mensaje que se entiende.
 */
/**
 * El identificador va a una RUTA, así que su forma se acota aquí.
 *
 * No se exige UUID —que es lo que devuelve Siigo— porque en modo simulado los identificadores tienen
 * otra forma y el ciclo del AC8 tiene que poder recorrerse entero. Lo que sí se acota es el juego de
 * caracteres: sin `/`, sin `?`, sin `&` y sin puntos consecutivos, un valor pegado por error no puede
 * convertirse en otra petición.
 */
const ID_SIIGO_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

const cuerpoSchema = z.discriminatedUnion('existe', [
  z.object({ existe: z.literal(true), siigoInvoiceId: z.string().trim().regex(ID_SIIGO_RE) }),
  z.object({ existe: z.literal(false) }),
]);

/**
 * POST /:facturaId — registrar el veredicto humano sobre una reserva a medias.
 *
 * La guarda es `marcar_fallido`, que es la acción del catálogo para «alguien decide el desenlace de
 * una factura que no salió». `auditor` mira y no toca, igual que en el resto del módulo.
 */
router.post(
  '/:facturaId',
  exigirAccionSiigo('marcar_fallido'),
  resolverLimiter,
  async (req: Request, res: Response) => {
    const { facturaId } = req.params;
    if (!UUID_RE.test(facturaId)) {
      res.status(400).json({ error: 'El identificador de la factura no es válido.' });
      return;
    }

    const parsed = cuerpoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Hay que decir si la factura existe en Siigo, y si existe, con qué identificador.',
      });
      return;
    }

    // `sub` y no `id`: es el campo del JWT en este repo. Se lee sin `as number` para que un token
    // sin sujeto se detecte aquí y no llegue a la bitácora como autor nulo de una decisión humana.
    const usuarioId = req.user?.sub;
    if (!usuarioId) {
      res.status(401).json({ error: 'No se pudo identificar a quien resuelve.' });
      return;
    }

    try {
      const r = await resolverHuerfanaAMano(facturaId, parsed.data, {
        ambiente: env.SIIGO_AMBIENTE, usuarioId,
      });
      res.json(r);
    } catch (e) {
      if (e instanceof SiigoReconciliacionError) {
        // 404 no existe · 422 el veredicto no se pudo comprobar · 409 el estado ya no admite
        // resolverla. Los tres son del cliente y ninguno es un fallo del servidor.
        const status = e.codigo === 'no_existe' ? 404 : e.codigo === 'datos' ? 422 : 409;
        res.status(status).json({ error: e.message });
        return;
      }
      throw e;
    }
  },
);

export default router;
