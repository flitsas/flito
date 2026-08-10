// Siigo — lo que el reporte de costos necesita saber de la factura de cada trámite (HU #11337).
//
// Existe porque hasta ahora NADIE servía el estado ante la DIAN: el historial se escribía (HU
// #11330), el sondeo lo alimentaba (#11332) y el motivo lo explicaba (#11333), pero ninguna ruta lo
// devolvía. La pantalla es el primer consumidor, así que la ruta llega con ella.
//
// DOS DECISIONES
//
//   1. **Por lotes, no una petición por fila.** El reporte pinta hasta 200 trámites por página. Una
//      llamada por fila serían 200 peticiones para dibujar una tabla, y el navegador las encolaría
//      de seis en seis. Se pide por lista de identificadores, como ya hace `correcciones.routes.ts`.
//   2. **Sale todo de la base, y ni una petición a Siigo.** La pantalla se abre constantemente; si
//      cada apertura gastara cuota de la ventana de 100 por minuto que comparte con la emisión,
//      mirar el reporte frenaría la facturación. El estado lo mantiene el ciclo periódico, no el
//      clic de nadie — que es además lo que el AC3 exige contarle a quien mira.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import { facturacionDeTramites, TOPE_TRAMITES_CONSULTA } from './siigo.facturacion-tramites.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = exigirAccionSiigo('consultar');

/**
 * Limitador propio, por paridad con el resto del módulo.
 *
 * Cada petición puede pedir hasta 400 trámites y evalúa tres subconsultas por fila. No es un vector
 * de un anónimo —solo entran los tres roles de confianza—, pero un cliente en bucle o un token
 * robado amplifican cómodo. Y hay un efecto de segundo orden que se olvida: cada 403 escribe una
 * fila en una bitácora que PROHÍBE borrar, así que una ruta sin freno también es una forma de
 * llenar una tabla que nadie puede vaciar.
 *
 * Generoso a propósito: la pantalla lanza una petición por carga y por cambio de página, y quien
 * concilia el cierre de mes pagina mucho.
 */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userOrIpKey('siigo-facturacion-tramites'),
  message: { error: 'Demasiadas consultas seguidas. Espera un momento.' },
  store: makeStore('rl:siigo-facturacion-tramites:'),
});

const consultaSchema = z.object({
  // Cadena separada por comas, como el resto de las consultas por lote del módulo. El tope se
  // valida aquí: sin él, una lista de veinte mil identificadores construiría una consulta enorme
  // para una pantalla que muestra doscientos.
  ids: z.string().trim().min(1),
});

/**
 * GET /tramites?ids=a,b,c — en qué punto está la factura de cada trámite.
 *
 * Devuelve solo los que TIENEN factura. Un trámite ausente de la respuesta significa «nunca se le
 * pidió», que es información y no un hueco: la pantalla lo pinta como «Sin enviar» sin necesidad de
 * que el servidor le mande una fila vacía por cada uno.
 */
router.get('/tramites', LECTURA, consultaLimiter, async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Falta la lista de trámites' });
    return;
  }

  const ids = parsed.data.ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > TOPE_TRAMITES_CONSULTA) {
    res.status(400).json({
      error: `Se pueden consultar como máximo ${TOPE_TRAMITES_CONSULTA} trámites por petición.`,
    });
    return;
  }

  res.json({ items: await facturacionDeTramites(ids) });
});

export default router;
