// Siigo — consultar la elegibilidad de unos trámites (HU #11324). Montado en /api/siigo/elegibilidad.
//
// Solo lectura, y por eso la guarda es `consultar` y no una de operación: preguntar si un trámite se
// puede facturar no factura nada. El AC8 lo dice al revés y significa lo mismo — los roles con
// lectura la consultan «sin poder emitir nada desde ella».
//
// La guarda va como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide de
// la guarda se nota leyendo el `router.<verbo>`.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import {
  evaluarElegibilidad, resumirElegibilidad, TOPE_TRAMITES_ELEGIBILIDAD,
} from './facturacion.elegibilidad.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = exigirAccionSiigo('consultar');

/**
 * Limitador propio.
 *
 * No sale a la red, pero cada petición evalúa hasta cuatrocientos trámites con una consulta que
 * arrastra los joins del reporte de costos. Es barato por fila y caro en bucle, y además cada 403
 * escribe en una bitácora que prohíbe borrar.
 */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userOrIpKey('siigo-elegibilidad'),
  message: { error: 'Demasiadas consultas seguidas. Espera un momento.' },
  store: makeStore('rl:siigo-elegibilidad:'),
});

const consultaSchema = z.object({ ids: z.string().trim().min(1) });

/**
 * GET /tramites?ids=a,b,c — el veredicto de cada trámite y el resumen del conjunto.
 *
 * Devuelve las dos cosas en una respuesta porque quien pinta la pantalla necesita las dos: el
 * veredicto por fila y los contadores de arriba. Separarlas en dos endpoints obligaría a evaluar
 * dos veces lo mismo, y a que los números y las filas pudieran discrepar entre una llamada y otra.
 */
router.get('/tramites', LECTURA, consultaLimiter, async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Falta la lista de trámites' });
    return;
  }

  const ids = parsed.data.ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > TOPE_TRAMITES_ELEGIBILIDAD) {
    res.status(400).json({
      error: `Se pueden evaluar como máximo ${TOPE_TRAMITES_ELEGIBILIDAD} trámites por petición.`,
    });
    return;
  }

  const veredictos = await evaluarElegibilidad(ids, env.SIIGO_AMBIENTE);
  const anteriores = veredictos.filter(
    (v) => v.motivos.some((m) => m.motivo === 'anterior_al_corte'),
  ).length;

  res.json({ items: veredictos, resumen: resumirElegibilidad(veredictos, anteriores) });
});

export default router;
