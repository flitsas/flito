// Siigo — asegurar el tercero de un cliente (HU #11297). Montado en /api/siigo/terceros.
//
// La guarda sale del catálogo de acciones (HU #11342): asegurar un tercero ESCRIBE en Siigo, así que
// es una acción de operación y no de consulta. Se reutiliza `emitir` en vez de inventar una acción
// nueva — quien puede emitir una factura necesariamente puede crear el tercero contra el que se
// emite, y separarlas daría un permiso que no sirve para nada por sí solo.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import { asegurarTercero, SiigoTerceroError, vinculoDeCliente } from './siigo.terceros.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = exigirAccionSiigo('consultar');
const ESCRITURA = exigirAccionSiigo('emitir');

/**
 * Limitador propio.
 *
 * Cada llamada puede gastar hasta tres peticiones de la ventana de 100 por minuto que la EMPRESA
 * comparte con la emisión —consultar, leer y escribir—, y `esperarTurno` no rechaza cuando la
 * ventana está llena: duerme. Sincronizar terceros en bucle es una forma silenciosa de dejar sin
 * cuota justo a lo que factura.
 */
const asegurarLimiter = rateLimit({
  windowMs: 900_000,
  max: 60,
  keyGenerator: userOrIpKey('siigo-terceros'),
  message: { error: 'Demasiadas sincronizaciones seguidas. Espera unos minutos.' },
  store: makeStore('rl:siigo-terceros:'),
});

const idSchema = z.coerce.number().int().positive();

function estadoDe(codigo: SiigoTerceroError['codigo']): number {
  return codigo === 'cliente_no_existe' ? 404 : 409;
}

/** El vínculo actual de un cliente. Lectura pura: no llama a Siigo. */
router.get('/cliente/:clienteId', LECTURA, async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.clienteId);
  if (!id.success) {
    res.status(400).json({ error: 'Identificador de cliente inválido' });
    return;
  }
  res.json({ vinculo: await vinculoDeCliente(id.data) });
});

/** Asegura el tercero: consulta, vincula o crea, y actualiza solo si algo cambió. */
router.post('/cliente/:clienteId', ESCRITURA, asegurarLimiter, async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.clienteId);
  if (!id.success) {
    res.status(400).json({ error: 'Identificador de cliente inválido' });
    return;
  }

  try {
    const r = await asegurarTercero(id.data);
    // La auditoría anota el desenlace, que es lo que alguien querrá reconstruir después: no es lo
    // mismo haber creado un tercero en Siigo que haberse vinculado a uno que ya estaba.
    await audit(req, {
      action: 'create', resource: 'siigo_terceros', resourceId: r.siigoCustomerId,
      detail: `Tercero del cliente ${r.clienteId} · ${r.desenlace} · sucursal ${r.sucursal}`,
    });
    res.json(r);
  } catch (e) {
    if (e instanceof SiigoTerceroError) {
      res.status(estadoDe(e.codigo)).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

export default router;
