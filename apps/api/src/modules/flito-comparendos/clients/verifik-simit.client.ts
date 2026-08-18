// FLITO comparendos — adapter de Verifik SIMIT (Feature #11492 17a, HU #11499, AC1/AC3).
//
// La primera de las dos fuentes del módulo. Habla con Verifik y NADA más: no toca la base de
// datos, no decide qué NITs se consultan y no interpreta lo que llega. Devuelve la lista cruda y
// el contexto con el que la HU #11500 escribirá su `sync_run_step`.
//
// Este NO es el SIMIT del traspaso. `integraciones/simit.direct.ts` (FCM con proof-of-work) y el
// proxy CEA sirven al pre-vuelo de trámites y tienen otras credenciales, otro contrato y otro
// dueño; mezclarlos era la Opción 3 que el ADR-0001 descartó. De `integraciones/` solo se importa
// el helper de transporte.
//
// ── El token ─────────────────────────────────────────────────────────────────────────────────────
//
// Es el punto donde vive el riesgo residual de filtración de todo el módulo, así que las reglas son
// tres y se cumplen literalmente:
//
//   1. Llega envuelto en `Redacted` desde `obtenerTokenSimit()` y se desenvuelve en la línea que
//      construye la cabecera, no antes. No hay ninguna variable de este archivo que contenga el
//      token en claro más allá de esa expresión.
//   2. El objeto de cabeceras no se loguea, ni entero ni por partes, ni en el camino feliz ni en el
//      de error. Lo que se registra son códigos y conteos.
//   3. Ningún error de este archivo lleva el token en el mensaje: los mensajes los construyen las
//      clases de `flito-comparendos.errors.ts`.

import { httpsGetJson } from '../../integraciones/http.js';
import { env } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';
import { maskDocument } from '../../../shared/utils/pii.js';
import type { Redacted } from '../../../shared/utils/crypto.js';
import { obtenerTokenSimit } from '../flito-comparendos.token.service.js';
import {
  baseUrlExigida,
  comoErrorDeFuente,
  conLimiteDeTiempo,
  exigirHttpOk,
  extraerLista,
  limiteDeTiempoMs,
  type ContextoFuente,
} from './fuente-http.js';
import {
  FUENTE_SIMIT,
  type ComparendoCrudoSimit,
  type RespuestaFuenteSimit,
} from './types.js';

const log = loggerFor('flito-comparendos');

const CTX: ContextoFuente = { origen: 'simit', fuente: FUENTE_SIMIT };

/**
 * Ruta del endpoint de consulta. Constante del contrato del proveedor; el host va por entorno.
 *
 * El verbo es **GET**: así lo publica Verifik. No es una elección de este módulo (ver el porqué del
 * NIT en la query más abajo, en `consultarComparendosSimit`).
 */
const RUTA_CONSULTA = '/v2/co/simit/consultar';

/** Verifik discrimina el tipo de documento; este módulo monitorea empresas, siempre por NIT. */
const TIPO_DOCUMENTO = 'NIT';

export interface OpcionesConsultaSimit {
  /**
   * Token ya descifrado, para que el sync lo lea UNA vez por corrida y no una vez por NIT.
   *
   * Sigue viajando envuelto: aceptar aquí un `string` en claro convertiría cada llamada del sync en
   * una oportunidad de que el valor acabe en un objeto que alguien loguee. Si no se pasa, el
   * adapter lo pide él mismo y sirve tal cual desde un script o una prueba manual.
   */
  token?: Redacted<string>;
}

/**
 * Comparendos que Verifik SIMIT tiene registrados para un NIT.
 *
 * En `mock` no toca la red, no exige base URL y no pide el token: un entorno recién clonado —o la
 * suite de tests— tiene que poder ejercer el módulo entero sin credenciales y sin salir a internet.
 * Ese es también el motivo de que `COMPARENDOS_SIMIT_MODE` valga `mock` por defecto.
 *
 * @param nit NIT normalizado del catálogo (solo dígitos y guion de DV: el alfabeto lo cierra el
 *            Zod de la HU #11497, aquí ya llega limpio).
 * @throws ComparendosFuenteError con `codigo` y `httpStatus` — nunca con la credencial dentro.
 * @throws ComparendosLlaveMaestraError, ComparendosTokenNoConfiguradoError o
 *         ComparendosTokenDescifradoError si hay que pedir el token y no se puede obtener. Se
 *         declaran aparte a propósito: **no** son `ComparendosFuenteError`, así que el sync de la
 *         HU #11500 no puede discriminar solo por ese `instanceof` al escribir el step — se le
 *         escaparían los tres. No es un fallo de la fuente: es que ni siquiera se llegó a preguntar.
 */
export async function consultarComparendosSimit(
  nit: string, opciones: OpcionesConsultaSimit = {},
): Promise<RespuestaFuenteSimit> {
  if (env.COMPARENDOS_SIMIT_MODE === 'mock') return respuestaSimulada(nit);

  const base = baseUrlExigida(env.VERIFIK_SIMIT_BASE_URL, 'VERIFIK_SIMIT_BASE_URL', CTX);
  const token = opciones.token ?? await obtenerTokenSimit();

  // `documentType` y `documentNumber` son PARÁMETROS DE BÚSQUEDA, no cuerpo: el contrato de
  // Verifik para esta consulta es GET, y en un GET el cuerpo no está definido —el proveedor
  // sencillamente no lo lee—. Es el contrato de un tercero, no una decisión nuestra.
  //
  // La consecuencia hay que decirla en voz alta: el NIT monitoreado —dato de empresa— viaja escrito
  // en una URL y queda, por tanto, en el log de acceso de cualquier proxy del proveedor.
  //
  // Qué regla aplica y cuál no, porque importa: **AGENTS.md §14 gobierna NUESTRAS superficies** —las
  // URLs de páginas de `apps/web`, nuestros access logs y los filtros de nuestra API autenticada—, y
  // ahí su default de diseño (PII en el cuerpo de un `POST …/buscar`, no en la query) se sigue
  // cumpliendo entero: el API de comparendos busca por NIT en body. Esto de aquí es una llamada
  // SALIENTE a un tercero, que §14 no regula; sus mitigaciones (`auth`, `requireRole`,
  // `logPiiAccess`) son de una lectura nuestra y no tienen dónde aplicarse en un GET a Verifik.
  //
  // Lo que sí aplica es la **Ley 1581**: remitir el NIT monitoreado a Verifik —y al UTS— es una
  // transferencia de datos a un tercero, y ESA es la razón por la que esto merece un comentario.
  // Queda registrada como consecuencia asumida del contrato del proveedor (Feature 17a, «Decisiones
  // cerradas» §7); si algún día Verifik publica un POST equivalente, se mueve.
  //
  // Bajo nuestro control queda el resto, y se cumple: esta URL no se registra en ninguna línea de
  // log de este módulo, el NIT solo sale por `maskDocument`, y `comoErrorDeFuente` descarta el
  // mensaje original de la capa de red precisamente para que una URL con el NIT dentro no se cuele
  // por la puerta del error.
  //
  // `URLSearchParams` y no interpolación, igual que en el adapter municipal: el NIT llega
  // normalizado del catálogo, pero codificar aquí protege también lo que entre por un seed, una
  // migración o un script.
  const parametros = new URLSearchParams({ documentType: TIPO_DOCUMENTO, documentNumber: nit });
  const url = `${base}${RUTA_CONSULTA}?${parametros.toString()}`;

  try {
    // Las DOS cosas, como en el municipal: el `timeoutMs` de `httpsGetJson` aborta el socket, pero
    // es un timeout de INACTIVIDAD; la carrera pone encima el plazo ABSOLUTO que protege el
    // presupuesto de tiempo del sync (ADR-0001 §7) frente al techo de ~120 s del nginx.
    const respuesta = await conLimiteDeTiempo(() => httpsGetJson(url, {
      // Aquí y solo aquí se desenvuelve. El objeto muere con la llamada y no se registra nunca.
      Authorization: `Bearer ${token.unwrap()}`,
      Accept: 'application/json',
      // La clave de caché de esta petición ES la URL, y la URL lleva el NIT dentro. La RFC 9111 ya
      // impide a un caché compartido guardar una respuesta a petición autenticada, pero eso
      // depende de que el proxy la respete: decirlo explícitamente cuesta una línea y le quita la
      // discreción. En el UTS, que no lleva `Authorization`, es la única protección que hay.
      'Cache-Control': 'no-store',
    }, limiteDeTiempoMs()), CTX);

    const httpStatus = exigirHttpOk(respuesta.status, CTX);
    const items = extraerLista<ComparendoCrudoSimit>(respuesta.data, httpStatus, CTX);

    // Se registra la forma de lo que pasó, no lo que pasó: NIT enmascarado (Ley 1581), conteo y
    // código. Ni cabeceras, ni cuerpo, ni la lista.
    log.debug({ fuente: CTX.fuente, nit: maskDocument(nit), httpStatus, items: items.length },
      'consulta a Verifik SIMIT resuelta');

    return { ...CTX, modo: 'real', httpStatus, items };
  } catch (e) {
    const fallo = comoErrorDeFuente(e, CTX);
    // `codigo` y `httpStatus`, no el error crudo: un `err` de la capa de red podría arrastrar la
    // petición entera —cabecera de autorización incluida— al log.
    log.warn({ fuente: CTX.fuente, nit: maskDocument(nit), codigo: fallo.codigo, httpStatus: fallo.httpStatus },
      'consulta a Verifik SIMIT fallida');
    throw fallo;
  }
}

/**
 * Respuesta simulada, determinista y sin red (AC1).
 *
 * Determinista a propósito —nada de aleatoriedad ni de fechas de «hoy»—: en `mock` corren tanto la
 * suite como las demos, y un dato que cambia entre ejecuciones convierte cualquier prueba del merge
 * en una prueba intermitente.
 *
 * La forma imita el mapa v1 de ADR-0003 y está armada para que el merge de la HU #11500 tenga algo
 * real que hacer: el segundo comparendo lo devuelve también el UTS municipal con el MISMO número
 * —es el caso de unicidad— y llega aquí SIN descripción, que es justo el hueco que el municipal
 * debe rellenar sin pisar lo que ya trajo SIMIT.
 */
function respuestaSimulada(nit: string): RespuestaFuenteSimit {
  const items: ComparendoCrudoSimit[] = [
    {
      numeroComparendo: `MOCK-SIMIT-${nit}-0001`,
      placa: 'MOK123',
      codigoInfraccion: 'C29',
      descripcionInfraccion: 'Estacionar un vehículo en sitio prohibido',
      fechaComparendo: '2026-05-14',
      secretariaNombre: 'Secretaría de Movilidad de Medellín',
      valorAPagar: '604100',
      estado: 'Pendiente de pago',
    },
    {
      numeroComparendo: `MOCK-COMPARTIDO-${nit}-0002`,
      placa: 'MOK456',
      codigoInfraccion: 'D02',
      // Sin `descripcionInfraccion`: el hueco que el municipal rellena (CF-08).
      fechaComparendo: '2026-06-02',
      secretariaNombre: 'Secretaría de Movilidad de Bello',
      valorAPagar: '1160500',
      estado: 'En cobro coactivo',
    },
  ];

  log.debug({ fuente: CTX.fuente, nit: maskDocument(nit), items: items.length },
    'consulta a Verifik SIMIT simulada (COMPARENDOS_SIMIT_MODE=mock): no se tocó la red');

  return { ...CTX, modo: 'mock', httpStatus: null, items };
}
