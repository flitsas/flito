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
import {
  MOTIVOS_NO_FACTURABLE,
  type ErrorClienteNoFacturable,
  type FaltanteCliente,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import { asegurarTercero, SiigoTerceroError, vinculoDeCliente } from './siigo.terceros.service.js';
import {
  ClienteNoFacturableError, COLUMNAS_CLIENTE_EVALUABLE,
} from './siigo.validador-cliente.service.js';

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

/**
 * Los campos a los que el validador puede apuntar. Se derivan de su propia proyección: si mañana
 * señala una columna nueva, tiene que estar ahí para poder evaluarla, así que la lista se mantiene
 * sola y no hay que acordarse de este archivo.
 */
const CAMPOS_PUBLICABLES = new Set(Object.keys(COLUMNAS_CLIENTE_EVALUABLE));

/**
 * Saneado de los faltantes ANTES de que salgan por HTTP (Ley 1581).
 *
 * La regla es que el cuerpo nombre CAMPOS, nunca sus valores. Hoy el validador ya cumple —tanto
 * `detalle` como `campo` salen de catálogos estáticos—, pero eso es una propiedad de su código de
 * hoy, no del contrato: el día que alguien componga un `detalle` con el nombre o el NIT del cliente
 * para depurar, este `map` es lo único que impide que ese dato viaje al navegador y al log del
 * proxy. Por eso `detalle` se REconstruye desde `MOTIVOS_NO_FACTURABLE` en vez de reenviarse, y
 * `campo` solo pasa si es una columna conocida.
 *
 * Un motivo que no esté en el catálogo se descarta: la pantalla no sabría pintarlo y el texto sería
 * de origen desconocido, que es justo lo que no se quiere reenviar.
 */
function faltantesPublicables(faltantes: readonly FaltanteCliente[]): FaltanteCliente[] {
  const salida: FaltanteCliente[] = [];
  for (const f of faltantes) {
    const detalle = MOTIVOS_NO_FACTURABLE[f.motivo];
    if (detalle === undefined) continue;
    salida.push(f.campo !== undefined && CAMPOS_PUBLICABLES.has(f.campo)
      ? { motivo: f.motivo, detalle, campo: f.campo }
      : { motivo: f.motivo, detalle });
  }
  return salida;
}

/**
 * El rechazo por ficha incompleta, con la lista de qué falta (HU #11299, AC4 y AC6).
 *
 * **422 y no 409, ni 500.** El 500 de antes era el defecto: `asegurarTercero` relanza a propósito
 * `ClienteNoFacturableError` —el `catch` del servicio la deja pasar TAL CUAL para no perder la
 * lista— y aquí solo se traducía `SiigoTerceroError`, así que el motivo más frecuente de fallo
 * («a este cliente le falta el tipo de persona») salía como «Error interno del servidor» y mandaba
 * al operador a buscar a soporte en vez de a la ficha del cliente.
 *
 * De los dos códigos posibles se elige 422 por lo mismo que ya hacen `statusDeMapeoError`
 * (`validacion` → 422), `reconciliacion.routes` (`datos` → 422) y `ciudades.routes`: la petición
 * está bien formada —el identificador es válido y el permiso alcanza—; lo que no se sostiene es el
 * ESTADO DE LOS DATOS a los que apunta. El 409 de `estadoDe` está reservado en este mismo router
 * para el conflicto de verdad —otro cliente ya ocupa esa identificación y esa sucursal, Siigo
 * rechazó—, y esa diferencia le sirve al front: un 422 se resuelve corrigiendo ESTE cliente; un 409
 * se resuelve mirando OTRO registro o escalando. Fundirlos en un solo código volvería a perder,
 * más discretamente, la misma información que se está recuperando aquí.
 */
function rechazoNoFacturable(e: ClienteNoFacturableError): ErrorClienteNoFacturable {
  const faltantes = faltantesPublicables(e.faltantes);
  // El mensaje se arma desde la lista ya saneada y NO desde `e.message`, que se compone con los
  // `detalle` originales: así el texto y la lista no pueden contradecirse y el mensaje hereda la
  // misma garantía de no llevar valores de la ficha.
  const error = faltantes.length > 0
    ? `El cliente no se puede facturar todavía: ${faltantes.map((f) => f.detalle).join(' ')}`
    : 'El cliente no se puede facturar todavía. Revísalo en el informe de clientes no facturables.';
  return { error, codigo: 'cliente_no_facturable', clienteId: e.clienteId, faltantes };
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
    // Va ANTES del `SiigoTerceroError` porque son excepciones hermanas y no anidadas: el servicio
    // relanza esta sin envolverla, y quien lea el orden tiene que ver que la ficha incompleta se
    // resuelve aquí y nunca llega al manejador genérico.
    if (e instanceof ClienteNoFacturableError) {
      res.status(422).json(rechazoNoFacturable(e));
      return;
    }
    if (e instanceof SiigoTerceroError) {
      res.status(estadoDe(e.codigo)).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

export default router;
