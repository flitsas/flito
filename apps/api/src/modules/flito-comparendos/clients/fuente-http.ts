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
 * `httpsGetJson` —y no digamos los 90 s de `httpsJson`— no son un valor conservador, son el valor
 * que hace que la corrida entera muera antes de terminar.
 */
export function limiteDeTiempoMs(): number {
  return env.COMPARENDOS_HTTP_TIMEOUT_MS;
}

/**
 * Base URL del proveedor, exigida y normalizada (sin barras finales).
 *
 * Se comprueba antes de construir la URL para que la ausencia salga como
 * `fuente_no_configurada` (503, dice qué variable falta) y no como una petición a
 * `undefined/v2/...` que acabaría de error de DNS. Nunca hay host por defecto en el código: los
 * hosts son decisión de despliegue cerrada del Feature.
 */
export function baseUrlExigida(
  valor: string | undefined, variable: string, ctx: ContextoFuente,
): string {
  const base = valor?.trim();
  if (!base) throw new ComparendosFuenteNoConfiguradaError(ctx.origen, ctx.fuente, variable);
  return base.replace(/\/+$/, '');
}

/**
 * Corre la petición con un techo de tiempo propio.
 *
 * `httpsGetJson` acepta su propio `timeoutMs` y aborta el socket de verdad; `httpsJson` no —tiene
 * 90 s fijos dentro— y por eso el POST de Verifik necesita esta carrera. Se prefiere esto a añadir
 * un parámetro a `integraciones/http.ts`, que es un helper compartido con traspaso, RUNT y
 * Fasecolda: la deuda que queda (un socket que puede seguir abierto hasta que el helper lo cierre)
 * es acotada y no compromete el presupuesto de tiempo del sync, que es lo que este techo protege.
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
 * Claves bajo las que los proveedores de tránsito suelen colgar la lista.
 *
 * Es una lista de candidatas, igual que el mapa de campos de ADR-0003, y por el mismo motivo:
 * todavía no hay una respuesta real capturada. El spike #11501 la reduce a la que sea.
 */
const CLAVES_LISTA = ['data', 'comparendos', 'infracciones', 'resultado', 'resultados', 'items', 'registros'];

/**
 * Saca la lista del cuerpo, o falla.
 *
 * Devolver `[]` cuando no se reconoce la forma sería el fallo más caro del módulo: el sync leería
 * «este NIT no debe nada» e inactivaría su histórico entero. Ver el porqué largo en
 * `ComparendosFuenteRespuestaIlegibleError`. Una lista vacía DE VERDAD (`{ data: [] }`) sí pasa:
 * ahí el proveedor sí contestó lo que se le preguntó.
 */
export function extraerLista<T>(cuerpo: unknown, httpStatus: number, ctx: ContextoFuente): T[] {
  if (Array.isArray(cuerpo)) return soloObjetos<T>(cuerpo, httpStatus, ctx);
  if (cuerpo !== null && typeof cuerpo === 'object') {
    const registro = cuerpo as Record<string, unknown>;
    for (const clave of CLAVES_LISTA) {
      const valor = registro[clave];
      if (Array.isArray(valor)) return soloObjetos<T>(valor, httpStatus, ctx);
    }
  }
  throw new ComparendosFuenteRespuestaIlegibleError(
    ctx.origen, ctx.fuente, httpStatus, describirForma(cuerpo),
  );
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
