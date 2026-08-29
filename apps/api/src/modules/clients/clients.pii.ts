// Clientes — qué entrega el listado del padrón y qué queda registrado de esa lectura (HU #11299,
// AC8).
//
// `GET /clients` era la lectura de datos personales más grande que provoca el panel de Terceros y
// la única que no dejaba rastro: `db.select()` SIN proyección sobre `clients` —hasta 500 filas
// COMPLETAS: nombre, documento, dirección, teléfono, correo, contacto y todo lo que se le añada
// mañana a la tabla— y `grep -c logPiiAccess` sobre este módulo daba 0, mientras `drivers/`,
// `flito-comparendos/`, `flito-conciliacion/` y `pesv/` sí registraban (AGENTS.md §16, Ley 1581
// art. 17). Se declaró como deuda de otro módulo en la HU anterior y se cierra aquí.
//
// ── Por qué la proyección vive en este archivo y no dentro del handler ───────────────────────────
//
// Porque la lista de campos que se REGISTRA se DERIVA de la lista de columnas que se ENTREGA, y las
// dos tienen que estar donde no puedan separarse. El bloqueante del ciclo anterior fue exactamente
// un inventario que declaraba más de lo que su ruta devolvía; aquí eso no se puede escribir: cambiar
// la proyección cambia `CAMPOS_PII_LISTADO` en la misma edición, sin acordarse de nada.
//
// Es el mismo gesto que `CAMPOS_PUBLICABLES` en `terceros.routes.ts` —derivar la lista de la
// proyección del validador en vez de mantener una copia— y la razón por la que
// `flito-conciliacion.pii.ts` y `siigo.pii.ts` existen aparte de sus routers.
//
// ── Qué se recortó, y contra qué se midió ───────────────────────────────────────────────────────
//
// Se midieron los CINCO consumidores de `GET /clients` que hay en la aplicación, campo por campo:
//
//   · `pages/Clients.tsx` — el listado: nombre, tipo y número de documento, ciudad, teléfono, correo,
//     los cuatro interruptores de autogestión y —desde el Feature #11912— el de «SOAT sin trámite».
//     (`notes` y `active` están declarados en su interfaz y NO los lee nadie; ver abajo.)
//   · `components/clientes/FichaFiscal.tsx` — `/clients?limit=500`, y de ahí sale la ficha entera:
//     tipo de persona, tipo y número de identificación, dígito de verificación, responsabilidades
//     fiscales, dirección, país/departamento/ciudad, nombre comercial, sucursal, nombre y los cinco
//     campos de contacto. Es el consumidor exigente: la ficha necesita casi toda la parte fiscal.
//   · `pages/FlitoBolsas.tsx` y `pages/FlitoConciliacion.tsx` — solo `id` y `name`.
//   · `pages/RndcRemesaForm.tsx` — `id`, `name` y `document`.
//
// La unión son las 27 columnas de `COLUMNAS_LISTADO`, de las 37 que tiene la tabla. El recorte no es
// cosmético aunque sea de diez columnas: tres de ellas son personales —`notes` (texto libre, que es
// donde acaba cualquier cosa), `city_texto_origen` (la ubicación que tenía la ficha antes de
// confirmarse) y `flito_carpeta_storage` (que se deriva del NIT)— y las otras siete son internas
// (`flito_tolerancia_valor_impuesto`, `person_type_origen`, `city_confirmada_por`,
// `city_confirmada_en`, `facturacion_bloqueos`, `created_at`, `active`) que ninguna pantalla lee.
// El efecto que más dura es el otro: la columna que se añada mañana a `clients` ya no sale sola por
// esta ruta.
//
// `notes` y `active` se van aunque estén declarados en la interfaz `Client` de `Clients.tsx`:
// declarados no es leídos —se comprobó por grep en toda la pantalla— y `notes` es justo la clase de
// campo que no debe viajar en un listado de 500. Quedan como limpieza de dos líneas para el lado del
// front; no se tocan desde aquí porque esta tanda no toca `apps/web`.

import type { Request } from 'express';
import { clients } from '../../db/schema.js';
import { registrarAccesoCliente } from '../siigo/siigo.pii.js';

/**
 * Las columnas que `GET /clients` entrega. Nada más.
 *
 * El orden es el de la tabla y el de la pantalla: primero lo del listado, después lo de la ficha
 * fiscal. Añadir una columna aquí es una decisión de exposición, no un detalle de consulta.
 */
export const COLUMNAS_LISTADO = {
  id: clients.id,
  name: clients.name,
  document: clients.document,
  documentType: clients.documentType,
  phone: clients.phone,
  email: clients.email,
  address: clients.address,
  city: clients.city,
  soatAutogestionable: clients.soatAutogestionable,
  // Feature #11912. Sale por AQUÍ y no por `/flito/parametrizacion/companias` porque `Clients.tsx`
  // pinta su columna en la misma tabla: cruzar dos rutas para una casilla dejaba a `financiera` —que
  // ve esta pantalla pero NO entra a parametrización (`requireRole('admin','auditor')`)— con un «—»
  // permanente que no distingue «apagado» de «no lo puedo leer».
  soatSinTramite: clients.soatSinTramite,
  impuestosAutogestionable: clients.impuestosAutogestionable,
  logisticaAutogestionable: clients.logisticaAutogestionable,
  logisticaPermiteParcial: clients.logisticaPermiteParcial,
  personType: clients.personType,
  idType: clients.idType,
  checkDigit: clients.checkDigit,
  fiscalResponsibilities: clients.fiscalResponsibilities,
  countryCode: clients.countryCode,
  stateCode: clients.stateCode,
  cityCode: clients.cityCode,
  commercialName: clients.commercialName,
  branchOffice: clients.branchOffice,
  contactFirstName: clients.contactFirstName,
  contactLastName: clients.contactLastName,
  contactEmail: clients.contactEmail,
  phoneIndicative: clients.phoneIndicative,
  phoneNumber: clients.phoneNumber,
};

type ClaveListado = keyof typeof COLUMNAS_LISTADO;

/**
 * Lo que la proyección entrega y NO es un dato personal. Todo lo demás sí lo es.
 *
 * La lista está al revés a propósito —se enumera lo impersonal, no lo personal— para que falle del
 * lado seguro: una columna nueva en `COLUMNAS_LISTADO` entra al registro como personal salvo que
 * quien la añada declare aquí que no lo es. Al revés, el olvido se llama «campo personal entregado
 * sin registrar», que es el defecto que esta HU corrige.
 *
 * El criterio es el que ya fija este módulo en `CAMPOS_FISCALES_TRAZABLES` (`clients.routes.ts`) y
 * `siigo.pii.ts`: los códigos de catálogo —tipo de persona, tipo de identificación,
 * responsabilidades fiscales, sucursal, tipo de documento— clasifican a un tercero pero no
 * identifican ni ubican a nadie por sí solos. `id` tampoco: ya viaja en `resource_id`.
 *
 * `checkDigit` entra aquí por la misma razón y conviene dejarla escrita, porque es la discutible:
 * es un dígito derivado del NIT, no un dato por derecho propio, y `document` —del que se calcula—
 * SÍ está declarado. Quien pregunte «¿quién leyó identificaciones?» encuentra la respuesta por
 * `document`; sumar `check_digit` no añadiría un solo acceso a esa lista.
 *
 * Los códigos de ubicación (`country_code`, `state_code`, `city_code`) NO están aquí: ubican al
 * titular, que es lo que AGENTS.md §14 protege y lo que `CAMPOS_PII_TERCERO_EXPORTADO` ya declara.
 */
const COLUMNAS_IMPERSONALES = new Set<ClaveListado>([
  'id',
  'documentType',
  'soatAutogestionable',
  // Parametrización, como sus vecinas: dice qué canal tiene abierto la compañía, no quién es. Va
  // clasificada aquí Y en `CLIENTS_COLUMNAS_SIN_PII` (`shared-types/siigo-terceros.ts`), que son dos
  // canarios distintos: aquel cubre la tabla entera, este solo lo que esta ruta entrega.
  'soatSinTramite',
  'impuestosAutogestionable',
  'logisticaAutogestionable',
  'logisticaPermiteParcial',
  'personType',
  'idType',
  'checkDigit',
  'fiscalResponsibilities',
  'branchOffice',
]);

/**
 * Columnas personales que la respuesta del listado entrega, con el nombre que tienen en la BASE.
 *
 * Se DERIVA de `COLUMNAS_LISTADO` en vez de escribirse a mano, y ese es el punto entero de este
 * archivo: así el registro no puede declarar un campo que la ruta no entregue —el bloqueante del
 * ciclo anterior— ni callarse uno que sí.
 *
 * Se usan los nombres de columna (`contact_email`, no `contactEmail`) por lo mismo que el resto del
 * repo: `pii_access_log` tiene que poder cruzarse con la tabla real, no con el DTO de una pantalla.
 * `columna.name` los da de primera mano, así que tampoco hay una segunda traducción que mantener.
 */
export const CAMPOS_PII_LISTADO: readonly string[] = Object.entries(COLUMNAS_LISTADO)
  .filter(([clave]) => !COLUMNAS_IMPERSONALES.has(clave as ClaveListado))
  .map(([, columna]) => columna.name);

/**
 * Deja constancia de que alguien barrió el padrón (Ley 1581 art. 17).
 *
 * Delega en `registrarAccesoCliente` de `siigo/siigo.pii.ts` en vez de llamar a `logPiiAccess` por
 * su cuenta, y la dependencia cruzada entre módulos es deliberada: ese contrato ya fija el
 * `resource_tipo` (`client`, el mismo literal con el que `audit()` anota las escrituras) y la forma
 * del `motivo` para las otras cinco rutas que leen fichas de cliente. Escribir aquí una segunda
 * versión daría dos maneras de nombrar la misma lectura y la consulta «¿quién ha leído el padrón?»
 * dejaría de responderse de una sola vez — que es lo único que un registro de acceso tiene que
 * saber hacer (ADR-0006 §7.5).
 *
 * Vive en este archivo y no en el router para que la dependencia con `siigo/` esté en UN sitio: el
 * día que ese contrato se mueva a `shared/`, se cambia esta línea y ningún handler se entera.
 */
export async function registrarAccesoListado(
  req: Request,
  tramo: { filas: number; limit: number; offset: number },
): Promise<void> {
  await registrarAccesoCliente(req, {
    accion: 'search',
    campos: CAMPOS_PII_LISTADO,
    // Un listado no apunta a una ficha, sino a un tramo del padrón: `resource_id` va nulo y el
    // tramo se reconstruye con `filas`, `limit` y `offset`.
    filas: tramo.filas,
    filtros: { limit: tramo.limit, offset: tramo.offset },
  });
}
