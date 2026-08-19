// Siigo — el listado de productos, para poder ELEGIR uno (A3). Montado en /api/siigo/productos.
//
// Hasta ahora FLITO solo sabía *verificar* un código que alguien había escrito a mano
// (`consultarProductoPorCodigo`). Nadie veía nunca la lista, así que mapear un concepto exigía ir a
// Siigo Nube, copiar el código y pegarlo aquí — y el mapeo mostraba después un código pelado donde
// quien factura esperaba leer «Servicio en la Nube», que es el nombre que va a salir en el
// documento.
//
// Sale a la RED en cada consulta, y es deliberado. Los catálogos de emisión tienen copia local
// porque se eligen una vez y se validan miles; este listado se abre para elegir y se cierra. Una
// copia local suya sería una tabla más que mantener, un botón más de sincronizar y una lista que
// puede estar vieja justo cuando alguien acaba de crear el producto en Siigo — que es el momento en
// que se abre este selector.
//
// La guarda es `consultar` y no una de operación: mirar el catálogo de productos no factura nada.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import { listarProductos, motivoLegible } from './siigo.productos.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = exigirAccionSiigo('consultar');

/**
 * Limitador propio, y más estrecho que el de las consultas locales.
 *
 * Cada petición son hasta cinco viajes a Siigo, y la cuota de 100 por minuto se comparte con la
 * emisión. Un selector que alguien abre y cierra en bucle no puede dejar sin cuota a lo que factura.
 */
const listadoLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('siigo-productos'),
  store: makeStore('rl:siigo-productos:'),
  message: { error: 'Demasiadas consultas al catálogo de productos. Espera un momento.' },
});

const consultaSchema = z.object({
  /** Se filtra por código Y por nombre. Siigo no tiene filtro por nombre: se aplica en el servicio. */
  q: z.string().trim().max(120).optional(),
}).strict();

/**
 * GET / — los productos de Siigo del ambiente del SERVIDOR.
 *
 * El ambiente no se acepta por parámetro, igual que en el envío: es `env.SIIGO_AMBIENTE` y nada
 * más. Dejarlo elegir al cliente sería ofrecer una forma de mirar la empresa de producción desde una
 * pantalla de pruebas.
 */
router.get('/', LECTURA, listadoLimiter, async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  try {
    const listado = await listarProductos(env.SIIGO_AMBIENTE, { busqueda: parsed.data.q });
    res.json(listado);
  } catch (e) {
    // 502 y no 500: el fallo es de Siigo o del cortacircuitos, no de esta API. El mensaje sale de
    // `motivoLegible`, que ya traduce las caídas y los rechazos a lenguaje operativo.
    res.status(502).json({ error: motivoLegible(e) });
  }
});

export default router;
