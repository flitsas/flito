// Siigo — asegurar el tercero de un cliente (HU #11297). Montado en /api/siigo/terceros.
//
// La guarda sale del catálogo de acciones (HU #11342): asegurar un tercero ESCRIBE en Siigo, así que
// es una acción de operación y no de consulta. Se reutiliza `emitir` en vez de inventar una acción
// nueva — quien puede emitir una factura necesariamente puede crear el tercero contra el que se
// emite, y separarlas daría un permiso que no sirve para nada por sí solo.
//
// Las guardas van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide
// de la guarda se nota leyendo el `router.<verbo>`.
//
// ── Salida de datos personales (HU #11299) ───────────────────────────────────────────────────────
//
// El `POST` deja registro en `pii_access_log` con `accion: 'export'`: manda a Siigo —un proveedor
// externo— la ficha del cliente y devuelve su identificación en el cuerpo. El
// `GET /cliente/:clienteId` también entrega `identificacion` y NO registra: es deuda declarada en
// `siigo.pii.ts` para la HU de seguimiento, porque el panel de la HU #11299 usa el POST y no ese
// GET. Escribirlo aquí para que quien añada el rastro no tenga que descubrirlo.
//
// El `GET /resumen` tampoco registra, pero por el motivo contrario y no por deuda: devuelve dos
// conteos y ninguna identidad. Los dos casos están razonados en `siigo.pii.ts`.

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
import {
  CAMPOS_PII_IDENTIFICACION, CAMPOS_PII_TERCERO_EXPORTADO, registrarAccesoCliente,
} from './siigo.pii.js';
import {
  asegurarTercero, resumenTerceros, SiigoTerceroError, vinculoDeCliente,
} from './siigo.terceros.service.js';
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

/**
 * Cuántos clientes tienen tercero en Siigo (HU #11299, AC3).
 *
 * Es la TERCERA cifra que el AC pide en la misma frase que las otras dos («cuántos están listos
 * para facturar, cuántos no lo están y cuántos tienen tercero vinculado en Siigo»), y las otras dos
 * ya salían de `GET /siigo/clientes/validacion`. Esta ruta no repite aquella: cada una cuenta sobre
 * su propia tabla —`clients` allá, `siigo_terceros` aquí— y el panel las pide en paralelo.
 *
 * **No es el lote de §R3-b del diseño de UX.** Aquello (`GET /terceros?clienteIds=`) diría QUIÉN
 * está vinculado para pintar una columna fila por fila, y se descartó a propósito. Descartar una
 * columna no es lo mismo que omitir un conteo: esto devuelve dos números y ninguna identidad.
 *
 * Va ANTES de `/cliente/:clienteId` por costumbre de este repo —rutas fijas primero—, aunque aquí
 * los dos segmentos no puedan colisionar.
 *
 * **Sin registro de acceso PII, y es deliberado**: la respuesta son dos enteros, ni un nombre ni una
 * identificación ni un `clients.id`. Es el mismo criterio que `CAMPOS_PII_RESUMEN` deja escrito en
 * `siigo.pii.ts` para el resumen de facturabilidad —lo que decide no es la ruta ni la tabla que se
 * recorre, sino si la RESPUESTA entrega datos personales—, con una diferencia: aquel sí registra
 * con la lista vacía porque barre las FICHAS del padrón, y este cuenta llaves foráneas sin mirar
 * una sola columna personal. El porqué está inventariado en `siigo.pii.ts` para que la próxima
 * revisión no lo lea como un olvido.
 */
router.get('/resumen', LECTURA, async (_req: Request, res: Response) => {
  res.json(await resumenTerceros());
});

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

    // Registro de acceso a PII (HU #11299, Ley 1581 art. 17). Va con `accion: 'export'` y no con
    // `read` porque aquí los datos SALEN del sistema: `armarTercero` manda a Siigo —un tercero
    // externo— nombre, identificación, dirección, ubicación, teléfono y contacto, y el cuerpo
    // devuelve además la identificación en claro a quien preguntó. El panel llama a esta ruta en
    // bucle sobre la lista de no facturables, así que es la salida de identidades más repetida de
    // la pantalla.
    //
    // NO lo cubre el `audit()` de abajo, y no es redundancia: la bitácora responde «quién CREÓ un
    // tercero» —una operación de negocio— y esto responde «qué datos personales salieron y de
    // quién». Cuando un titular pregunte a quién se le entregaron sus datos, la respuesta está en
    // esta tabla y no en la otra.
    //
    // Los campos se eligen por DESENLACE, porque no todos los caminos exportan lo mismo:
    // `sin_cambios` no hace ni una petición a Siigo —la huella coincide— y `vinculado_existente`
    // solo mandó la identificación en la consulta. Declarar los doce campos en esos dos casos diría
    // que salió una ficha entera que nunca salió.
    const escribioEnSiigo = r.desenlace === 'creado' || r.desenlace === 'actualizado';
    await registrarAccesoCliente(req, {
      accion: 'export',
      campos: escribioEnSiigo ? CAMPOS_PII_TERCERO_EXPORTADO : CAMPOS_PII_IDENTIFICACION,
      clienteId: r.clienteId,
      // El desenlace, no la identificación: el motivo dice qué pasó, no qué dato salió.
      filtros: { desenlace: r.desenlace, sucursal: r.sucursal },
    });

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
