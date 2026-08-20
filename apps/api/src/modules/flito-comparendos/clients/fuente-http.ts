// FLITO comparendos — transporte compartido por los adapters de fuente (HU #11499).
//
// Cuarto archivo de `clients/` además de los tres que nombra la HU. Existe porque lo que hay aquí
// —el techo de tiempo, la comprobación de 2xx, la extracción de la lista y la traducción de un
// error de socket a error de dominio— es EXACTAMENTE igual para Verifik y para UTS, y duplicarlo
// significaría que la próxima vez que se afine el manejo de errores se afine en un adapter y no en
// el otro. La alternativa era meterlo en `types.ts`, que es un archivo de tipos y no de plomería.
//
// Nada de lo que sale de aquí lleva la cabecera `Authorization`, el token ni el NIT: los mensajes
// los construyen las clases de `flito-comparendos.errors.ts`, que es donde vive esa garantía.

import { env } from '../../../config/env.js';
import {
  ComparendosFuenteError,
  ComparendosFuenteHttpError,
  ComparendosFuenteNoConfiguradaError,
  ComparendosFuenteRedError,
  ComparendosFuenteRespuestaIlegibleError,
  ComparendosFuenteTimeoutError,
} from '../flito-comparendos.errors.js';
import type { ComparendosOrigenFuente } from './types.js';

/** Identificación de la llamada en curso: acompaña a todo error para que el step sepa qué falló. */
export interface ContextoFuente {
  origen: ComparendosOrigenFuente;
  /** `'simit'` o el `codigoFuente` del municipio. */
  fuente: string;
}

/**
 * Techo de tiempo de UNA llamada, leído en cada invocación y no al importar el módulo.
 *
 * Lo segundo permitiría que un test cambiara el valor y el adapter siguiera con la foto vieja, pero
 * sobre todo: este número es el que hace viable el sync síncrono. La matriz NIT × municipios va
 * contra un nginx que corta a los ~120 s (ADR-0001 §7), así que los 15 s por defecto de
 * `httpsGetJson` no son un valor conservador: son el valor que hace que la corrida entera muera
 * antes de terminar.
 */
export function limiteDeTiempoMs(): number {
  return env.COMPARENDOS_HTTP_TIMEOUT_MS;
}

/** Excepciones que una fuente concreta puede pedirle a la validación de la base URL. */
export interface OpcionesBaseUrl {
  /**
   * Admite `http://` además de `https://`. Solo para fuentes SIN credencial en la petición.
   *
   * El adapter que lo enciende es responsable de pasarle al transporte la misma excepción
   * (`permitirTextoPlano` de `httpsGetJson`): sin eso, una base `http://` saldría igual contra el
   * 443 del host, que es el fallo silencioso que esta validación existe para evitar.
   */
  permitirTextoPlano?: boolean;
}

/**
 * Base URL del proveedor: exigida, VALIDADA y normalizada (sin barras finales).
 *
 * Se comprueba antes de construir la URL para que un valor ausente o inservible salga como
 * `fuente_no_configurada` (503, dice qué variable revisar) y no como una petición a
 * `undefined/v2/...` que acabaría de error de DNS. Nunca hay host por defecto en el código: los
 * hosts son decisión de despliegue cerrada del Feature.
 *
 * Las tres comprobaciones no son celo de validación; cada una cierra un fallo concreto:
 *
 *   1. **Parsea o no sirve.** Un valor que `new URL` no acepta reventaría más adelante como
 *      `TypeError` crudo dentro del `try` del adapter y saldría convertido en `fuente_red`, que es
 *      exactamente el diagnóstico equivocado: no falló la red, falló la provisión.
 *   2. **El esquema, y solo el que la fuente admita.** `https:` siempre; `http:` únicamente si la
 *      fuente pasa `permitirTextoPlano` (ver abajo). Lo que esta comprobación impide en los dos
 *      casos es lo mismo: que una base `http://` acabe saliendo en silencio contra el 443 del
 *      host —que es lo que hacía el transporte compartido antes de aceptar el esquema— y el NIT se
 *      remita a un endpoint que nadie revisó, o que el operador reciba un error opaco de TLS o de
 *      DNS en lugar de un error de provisión.
 *   3. **Sin `search` ni `hash`.** Los adapters concatenan `${base}${RUTA}?${params}`; una base con
 *      `?` o `#` pegado produciría una URL con la query partida en dos y parámetros del despliegue
 *      mezclados con los nuestros. Es el único punto donde la base se interpola, y así deja de
 *      poder inyectar nada en la query que lleva el NIT.
 *
 * Los mensajes describen la FORMA del valor (esquema, «trae query»), nunca el valor: viajan al
 * cuerpo de la respuesta y a `flito_comparendos_sync_steps.mensaje`, que se conserva.
 *
 * En `mock` no se llega aquí: los dos adapters cortocircuitan antes, de modo que un entorno local
 * sin variables provisionadas sigue ejerciendo el módulo entero.
 *
 * ── `permitirTextoPlano`, y por qué NO es un relajamiento general ────────────────────────────────
 *
 * La comprobación 2 sigue siendo la regla; lo que cambia es que **una** fuente puede pedir
 * excepción. La pide el UTS municipal y solo el UTS municipal, porque el proveedor no publica
 * HTTPS y sin esto la fuente no es consultable (decisión de David, 2026-08-20, que sustituye a la
 * de «preguntar antes al proveedor» del Feature 17a §594).
 *
 * Verifik NO la pide y no debe pedirla nunca: su petición lleva la cabecera `Authorization` con el
 * token del módulo, y en texto plano eso es regalar la credencial a cualquiera en el camino. Que
 * el parámetro sea explícito por llamada —y no una variable de entorno global— es justamente lo
 * que impide que encender el UTS abra también a Verifik.
 *
 * Lo que se acepta al encenderlo, dicho en voz alta: el NIT monitoreado viaja SIN CIFRAR en la
 * query de un GET a un tercero. Es un dato de empresa (Ley 1581, transferencia a tercero) y queda
 * legible para cualquier intermediario de la ruta. `uts-municipal.client.ts` lo registra con un
 * `log.warn` en cada corrida para que no se convierta en el estado normal por olvido.
 */
export function baseUrlExigida(
  valor: string | undefined, variable: string, ctx: ContextoFuente,
  opciones: OpcionesBaseUrl = {},
): string {
  const base = valor?.trim();
  if (!base) throw new ComparendosFuenteNoConfiguradaError(ctx.origen, ctx.fuente, variable);

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ComparendosFuenteNoConfiguradaError(
      ctx.origen, ctx.fuente, variable, 'la base no es una URL absoluta',
    );
  }

  const admiteTextoPlano = opciones.permitirTextoPlano === true;
  if (url.protocol !== 'https:' && !(admiteTextoPlano && url.protocol === 'http:')) {
    throw new ComparendosFuenteNoConfiguradaError(
      ctx.origen, ctx.fuente, variable,
      `la base usa el esquema ${url.protocol.replace(':', '')} y esta fuente solo admite `
      + `${admiteTextoPlano ? 'https o http' : 'https'}`,
    );
  }
  if (url.search || url.hash) {
    throw new ComparendosFuenteNoConfiguradaError(
      ctx.origen, ctx.fuente, variable,
      'la base debe ser solo el origen (y una ruta, si el proveedor está tras un prefijo): no '
      + 'puede traer query string ni fragmento',
    );
  }

  return base.replace(/\/+$/, '');
}

/**
 * Corre la petición con un techo de tiempo propio.
 *
 * El `timeoutMs` de `httpsGetJson` aborta el socket de verdad, pero es un techo de INACTIVIDAD: un
 * proveedor que gotee un byte por debajo de ese plazo mantiene la petición viva indefinidamente.
 * Esta carrera pone encima el plazo ABSOLUTO, y la necesitan las dos fuentes (las dos son GET).
 * Se prefiere esto a añadir un parámetro a `integraciones/http.ts`, que es un helper compartido con
 * traspaso, RUNT y Fasecolda: la deuda que queda (un socket que puede seguir abierto hasta que el
 * helper lo cierre) es acotada y no compromete el presupuesto de tiempo del sync.
 *
 * El temporizador se limpia siempre en el `finally`; si aun así quedara vivo, el `unref` evita que
 * sea él quien mantenga el proceso despierto.
 */
export async function conLimiteDeTiempo<T>(
  ejecutar: () => Promise<T>, ctx: ContextoFuente,
): Promise<T> {
  const ms = limiteDeTiempoMs();
  let temporizador: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ejecutar(),
      new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(
          () => rechazar(new ComparendosFuenteTimeoutError(ctx.origen, ctx.fuente, ms)), ms,
        );
        temporizador.unref?.();
      }),
    ]);
  } finally {
    if (temporizador) clearTimeout(temporizador);
  }
}

/** 2xx o error tipado. Un 4xx/5xx con cuerpo JSON sigue siendo un fallo, no una lista vacía. */
export function exigirHttpOk(status: number | undefined, ctx: ContextoFuente): number {
  // `undefined` (respuesta sin `statusCode`) cuenta como fallo, no como 200: no se asume nada.
  const codigo = status ?? 0;
  if (codigo < 200 || codigo >= 300) {
    throw new ComparendosFuenteHttpError(ctx.origen, ctx.fuente, codigo);
  }
  return codigo;
}

/**
 * Claves de PRIMER NIVEL bajo las que un proveedor puede colgar la lista, como último recurso.
 *
 * Sigue siendo la red de seguridad genérica de ADR-0003, pero ya no es el mecanismo principal: las
 * dos fuentes reales cuelgan sus comparendos de una ruta ANIDADA y concreta, y esas rutas las
 * declara cada adapter (`RUTAS_LISTA`). Este barrido solo actúa si ninguna ruta declarada aparece
 * en el cuerpo — el caso de un proveedor que devuelve `{ "registros": [...] }` a secas.
 */
const CLAVES_LISTA = ['data', 'comparendos', 'infracciones', 'resultado', 'resultados', 'items', 'registros'];

/** Segmentos que nunca se navegan: un `source_path` no es una excusa para tocar el prototipo. */
const SEGMENTOS_PROHIBIDOS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Lee una ruta con puntos (`data.multas`, `estadoCuenta.infraccion.0.descripcion`) o `undefined`.
 *
 * Navega con `hasOwnProperty` en cada salto (RN-14) y admite índices numéricos para atravesar
 * arrays. Se exporta porque el merge homologa con exactamente la misma semántica de ruta: si las
 * dos implementaciones divergen, el `field_map` querría decir una cosa aquí y otra allá.
 */
export function leerRuta(raiz: unknown, ruta: string): unknown {
  let actual: unknown = raiz;
  for (const segmento of ruta.split('.')) {
    if (actual === null || typeof actual !== 'object') return undefined;
    if (SEGMENTOS_PROHIBIDOS.has(segmento)) return undefined;
    if (Array.isArray(actual)) {
      if (!/^\d+$/.test(segmento)) return undefined;
      const i = Number(segmento);
      if (i >= actual.length) return undefined;
      actual = actual[i];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(actual, segmento)) return undefined;
    actual = (actual as Record<string, unknown>)[segmento];
  }
  return actual;
}

/**
 * Saca la lista del cuerpo, o falla.
 *
 * Devolver `[]` cuando no se reconoce la forma sería el fallo más caro del módulo: el sync leería
 * «este NIT no debe nada» e inactivaría su histórico entero. Ver el porqué largo en
 * `ComparendosFuenteRespuestaIlegibleError`. Una lista vacía DE VERDAD (`{ data: { multas: [] } }`)
 * sí pasa: ahí el proveedor sí contestó lo que se le preguntó.
 *
 * ── Por qué `rutas` es una lista y se CONCATENA, en vez de «la primera que aparezca» ─────────────
 *
 * Porque las dos fuentes reales parten sus comparendos en más de un array del mismo cuerpo, y los
 * arrays vacíos conviven con los llenos:
 *
 *   · Verifik devuelve `data.comparendos` **vacío** y los cinco comparendos del NIT en `data.multas`
 *     (capturado el 2026-08-20). Quedarse con la primera clave que sea un array habría devuelto la
 *     lista VACÍA y, con ella, la inactivación en falso del histórico del NIT — exactamente el
 *     fallo que este archivo existe para no cometer.
 *   · El UTS parte lo suyo entre `informacionComparendo` e `informacionComparendoAdicional`, y el
 *     vacío de los dos tampoco es siempre el mismo.
 *
 * Concatenar es seguro porque el acumulador del merge deduplica por número de comparendo y gana el
 * primer ítem de cada número (`acumularSimit` / `acumularMunicipal`): un comparendo que apareciera
 * en dos de las rutas se escribe una sola vez. Perder uno por elegir la rama equivocada, en cambio,
 * no se recupera.
 *
 * `rutas` va por prioridad y el orden se conserva en el resultado, así que la rama que el adapter
 * declara primero es la que gana el desempate del acumulador.
 */
export function extraerLista<T>(
  cuerpo: unknown, httpStatus: number, ctx: ContextoFuente, rutas: readonly string[] = [],
): T[] {
  if (Array.isArray(cuerpo)) return soloObjetos<T>(cuerpo, httpStatus, ctx);

  const ramas: unknown[][] = [];
  if (cuerpo !== null && typeof cuerpo === 'object') {
    for (const ruta of rutas) {
      const valor = leerRuta(cuerpo, ruta);
      if (Array.isArray(valor)) ramas.push(valor);
    }
    if (ramas.length === 0) {
      const registro = cuerpo as Record<string, unknown>;
      for (const clave of CLAVES_LISTA) {
        if (!Object.prototype.hasOwnProperty.call(registro, clave)) continue;
        const valor = registro[clave];
        if (Array.isArray(valor)) { ramas.push(valor); break; }
      }
    }
  }

  if (ramas.length === 0) {
    throw new ComparendosFuenteRespuestaIlegibleError(
      ctx.origen, ctx.fuente, httpStatus, describirForma(cuerpo),
    );
  }
  return soloObjetos<T>(ramas.flat(), httpStatus, ctx);
}

/**
 * Se queda con los elementos que son objetos planos.
 *
 * Validar el contenedor no basta: `{"data": [null, "texto"]}` pasaba el filtro de forma y entregaba
 * al merge dos cosas tipadas como objeto que no lo son. Y como estos ítems acaban en
 * `payload_simit` / `payload_municipal` y `types.ts` los declara con firma de índice, un `__proto__`
 * propio venido de `JSON.parse` sería contaminación de prototipo en cuanto alguien los combine con
 * `Object.assign` en vez de con spread.
 *
 * Si la lista traía elementos y NINGUNO sobrevive, es respuesta ilegible y no lista vacía: filtrar a
 * secas reintroduciría por la puerta de atrás el `[]` silencioso que todo este módulo evita, y con
 * él la inactivación en falso del histórico del NIT.
 */
function soloObjetos<T>(lista: unknown[], httpStatus: number, ctx: ContextoFuente): T[] {
  const objetos = lista.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (lista.length > 0 && objetos.length === 0) {
    throw new ComparendosFuenteRespuestaIlegibleError(
      ctx.origen, ctx.fuente, httpStatus,
      `lista de ${lista.length} elementos que no son objetos`,
    );
  }
  return objetos as T[];
}

/**
 * Una clave que parece nombre de campo, y no un dato disfrazado de clave.
 *
 * Exige **al menos una minúscula**, y ese detalle es el que hace el trabajo: por alfabeto, una placa
 * colombiana (`ABC123`) es un identificador perfectamente válido e indistinguible de un nombre de
 * campo. Lo que sí las separa es la caja — los proveedores nombran sus campos en camelCase o
 * snake_case (`data`, `numeroComparendo`, `total`), mientras que placas y documentos son mayúsculas
 * y dígitos. El coste es enmascarar alguna clave legítima en mayúsculas (`NIT`, `ID`); se acepta,
 * porque equivocarse hacia el otro lado significa persistir un dato personal en `sync_steps`.
 */
const CLAVE_DE_CONTRATO = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const TIENE_MINUSCULA = /[a-z]/;

/**
 * Describe la FORMA del cuerpo sin enseñar su contenido.
 *
 * De un objeto se dan los nombres de clave y de cualquier otra cosa solo el tipo y el tamaño. Un
 * cuerpo de texto puede ser el HTML de un portal de tránsito con placas y cédulas dentro: eso no
 * entra en un log ni recortado.
 *
 * **Las claves se filtran por alfabeto**, y no por prudencia genérica: dar por hecho que una clave
 * es contrato falla justo cuando el proveedor contesta un mapa indexado por placa o por documento
 * —`{"ABC123": {…}, "1036640908": {…}}`—, donde el identificador ES la clave. Y esta pista no se
 * queda en un log: viaja al cuerpo de la respuesta HTTP y a la columna `mensaje` de
 * `flito_comparendos_sync_steps`, que se conserva. Lo que no parece nombre de campo sale como `?`,
 * que mantiene el valor diagnóstico (cuántas claves, de qué forma) sin persistir el dato.
 */
function describirForma(cuerpo: unknown): string {
  if (cuerpo === null || cuerpo === undefined) return 'cuerpo vacío';
  if (typeof cuerpo === 'string') return `texto plano de ${cuerpo.length} caracteres`;
  if (typeof cuerpo !== 'object') return `valor ${typeof cuerpo}`;
  const claves = Object.keys(cuerpo as Record<string, unknown>);
  if (claves.length === 0) return 'objeto sin claves';
  const seguras = claves.slice(0, 8)
    .map((k) => (CLAVE_DE_CONTRATO.test(k) && TIENE_MINUSCULA.test(k) ? k : '?'));
  return `claves recibidas: ${seguras.join(', ')}${claves.length > 8 ? '…' : ''}`;
}

/**
 * Traduce cualquier cosa que haya salido mal a un error del dominio.
 *
 * Los errores que ya son del módulo pasan intactos —el timeout de la carrera, el HTTP no-OK, la
 * respuesta ilegible—. Lo demás es la capa de red, y de ahí solo se conserva el `code` de Node:
 * el mensaje original es texto de librería, y de un texto de librería no se puede prometer que no
 * arrastre la URL o el cuerpo de la petición.
 *
 * **AVISO — esta función es el único punto que impide que una URL con el NIT dentro salga por
 * la puerta del error.** Las consultas a las dos fuentes son GET con el documento en la query
 * (contrato de los proveedores, ver `verifik-simit.client.ts`), y un `Error` de red trae la URL
 * completa en su `message` (`connect ECONNREFUSED https://…?documentNumber=900123456`). Ese
 * mensaje se descarta **a propósito** y se sustituye por el `code`; el error resultante se loguea,
 * se devuelve por el API y se persiste en `flito_comparendos_sync_steps.mensaje`.
 *
 * Quien edite esto: no propagues `e.message`, ni lo anexes «para depurar», ni pases el error
 * original como `cause` (pino serializa `cause`). Si hace falta más diagnóstico, añade campos
 * cerrados —`code`, `syscall`—, nunca texto libre de la librería. Lo fija el test «la URL con el
 * NIT dentro no acaba en ningún log, ni en el camino feliz ni en el de error»
 * (`__tests__/services/flito-comparendos-clients.test.ts`).
 */
export function comoErrorDeFuente(e: unknown, ctx: ContextoFuente): ComparendosFuenteError {
  if (e instanceof ComparendosFuenteError) return e;
  if (esTimeoutDeSocket(e)) {
    return new ComparendosFuenteTimeoutError(ctx.origen, ctx.fuente, limiteDeTiempoMs());
  }
  const codigo = typeof (e as { code?: unknown })?.code === 'string'
    ? (e as { code: string }).code
    : 'desconocido';
  return new ComparendosFuenteRedError(ctx.origen, ctx.fuente, codigo);
}

/**
 * Timeout abortado por el propio helper HTTP.
 *
 * `httpsGetJson` rechaza con `new Error('Timeout')` pelado, sin `code`, así que hay que mirar el
 * mensaje; los timeouts que vienen del sistema sí traen `code`. Se comprueban las dos formas
 * porque un timeout y un fallo de red se cuentan distinto en el resumen del sync.
 */
function esTimeoutDeSocket(e: unknown): boolean {
  const codigo = (e as { code?: unknown })?.code;
  if (codigo === 'ETIMEDOUT' || codigo === 'ESOCKETTIMEDOUT' || codigo === 'ECONNABORTED') return true;
  const mensaje = e instanceof Error ? e.message : '';
  return /^timeout/i.test(mensaje);
}
