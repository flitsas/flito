// HTTP helpers para integraciones directas (SIMIT, Fasecolda, ML, RUNT).

import http, { type IncomingMessage } from 'http';
import https from 'https';

export interface HttpResponse { status: number | undefined; data: any; headers?: Record<string, string | string[] | undefined> }

/**
 * Acumula el cuerpo en Buffers y lo decodifica UNA sola vez, al final.
 *
 * Lo que había antes —`let d = ''; r2.on('data', (c) => (d += c))`— destruye caracteres. `c` es un
 * Buffer y `d += c` invoca `toString('utf8')` POR TROZO: si un carácter multibyte queda partido
 * entre dos trozos, cada mitad se decodifica por su cuenta y sale como U+FFFD (el rombo de
 * interrogación).
 *
 * Quien trocea es el SOCKET, no la codificación de transferencia. TCP entrega lo que ha llegado, de
 * modo que un cuerpo con `Content-Length` se reparte en varios eventos `data` exactamente igual que
 * uno `chunked` en cuanto no cabe en lo que el kernel entrega de una vez. Que quede dicho para no
 * repetir el error de diagnóstico del Bug #11711: los municipios verificados contra el proveedor el
 * 2026-08-21 —CINCO de los OCHO que siembra la migración 0150: BELLO, MEDELLIN, ITAGUI, ENVIGADO y
 * SABANETA, sin medir CALI, MANIZALES ni RIONEGRO— responden TODOS con `Content-Length` y NINGUNO
 * con `Transfer-Encoding: chunked` — y aun así esta acumulación se
 * conserva, porque lo que evita no depende de esa cabecera. Sus descripciones de infracción sí van
 * llenas de acentos («Conducir un vehículo a velocidad superior a la máxima permitida»), que es el
 * texto que se corrompería. `integraciones-http-transporte.test.ts` parte a propósito un carácter
 * multibyte entre dos `write` —con y sin `Content-Length`— y exige que el texto llegue idéntico.
 *
 * Qué arregla y qué NO, para que nadie lo venda como lo que no es. NO es la causa del Bug #11711:
 * esa está medida y es otra —el cuerpo del UTS viene doblemente codificado, ver `parsearCuerpo`—.
 * NO arregla `JSON.parse` —U+FFFD es un carácter válido dentro de un string JSON, así que un cuerpo
 * corrompido así parseaba igual—. Lo que evita es el mojibake PERSISTIDO: esos rombos acabarían en
 * `descripcion_infraccion` y en `payload_simit` / `payload_municipal`, que es texto que se guarda y
 * se sirve.
 *
 * Alcance, que aquí NO es opt-in: esto rige para TODOS los llamadores del helper —traspaso, RUNT,
 * Fasecolda, Mercado Libre y las dos fuentes de comparendos— y ninguno lo pidió. Se asume a
 * propósito y sin parámetro, al revés que `permitirTextoPlano` o `desenrollarJsonAnidado`: aquello
 * son excepciones que una fuente pide para sí, y esto es la corrección de una lectura que estaba mal
 * para cualquiera. Lo único que cambia de resultado es un cuerpo que hoy llegaría con U+FFFD.
 *
 * Node entrega Buffers en un socket sin `setEncoding`; el `Buffer.from` es solo el cinturón para el
 * caso de que un llamador (o un mock) lo haya puesto en modo string.
 */
function leerCuerpo(r2: IncomingMessage, alTerminar: (texto: string) => void): void {
  const trozos: Buffer[] = [];
  r2.on('data', (c: Buffer | string) => trozos.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c));
  r2.on('end', () => alTerminar(Buffer.concat(trozos).toString('utf8')));
}

/**
 * `JSON.parse` del cuerpo. Por defecto, EXACTAMENTE lo de siempre: un solo intento y, si falla, el
 * texto crudo tal cual —comportamiento del que dependen los llamadores que miran el cuerpo cuando
 * el proveedor contesta un error en texto—.
 *
 * ── `desenrollarJsonAnidado`, y por qué es opt-in ────────────────────────────────────────────────
 *
 * Encendido, se admite UNA capa de codificación doble: si el primer `JSON.parse` entrega un
 * `string` y ese string vuelve a parsear a objeto o array, se usa lo de dentro.
 *
 * Esto no es una precaución por si acaso ni una hipótesis: es la CAUSA RAÍZ del Bug #11711, medida
 * contra el proveedor el 2026-08-21 sobre CINCO de los OCHO municipios que siembra la migración
 * 0150 —BELLO, MEDELLIN, ITAGUI, ENVIGADO y SABANETA; CALI, MANIZALES y RIONEGRO no se midieron—.
 * Los cinco contestan `HTTP 200`, `Content-Type: application/json; charset=utf-8`,
 * `Content-Length` — y un cuerpo cuyo primer byte es una COMILLA DOBLE: el JSON ya serializado,
 * devuelto como STRING. Es el patrón conocido de un backend .NET que serializa el resultado y
 * devuelve el texto.
 *
 * `JSON.parse` NO lanza ahí: devuelve el string. El síntoma que producía era un 502 opaco de la capa
 * de arriba —«texto plano de N caracteres», porque `extraerLista` no reconoce nada dentro de un
 * string—, y de propina una validación SALTADA: sobre un string, la comprobación del envelope del
 * UTS no encuentra ningún `codigoEstado` y sale limpia. Lo primero era ruidoso y desorientaba; lo
 * segundo es lo que obliga a desenrollar aquí, en el transporte, y no más abajo.
 *
 * Es un parámetro por llamada y no el comportamiento por defecto por el mismo motivo que
 * `permitirTextoPlano`: este helper lo comparten traspaso, RUNT, Fasecolda y Mercado Libre, y
 * ninguno de ellos pidió este cambio. Con la opción apagada, un cuerpo doblemente codificado sigue
 * llegando como `string`, que es lo que esos cuatro llamadores han visto siempre. Quien encienda
 * esto para una fuente nueva está decidiendo por esa fuente y solo por ella.
 *
 * Es UN nivel, no un bucle: desenrollar «lo que haga falta» convertiría un cuerpo raro en cualquier
 * cosa, y aquí se quiere lo contrario —que un cuerpo que no entendemos siga siendo un fallo—. Si el
 * segundo parseo falla, o da un primitivo, se devuelve el string del primer parseo y el error de más
 * arriba es el de siempre. NUNCA se intenta «adivinar» JSON dentro de texto plano: sin recortes, sin
 * regex, sin heurísticas.
 */
export function parsearCuerpo(texto: string, desenrollarJsonAnidado = false): unknown {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return texto;
  }
  if (!desenrollarJsonAnidado || typeof valor !== 'string') return valor;
  try {
    const anidado: unknown = JSON.parse(valor);
    if (anidado !== null && typeof anidado === 'object') return anidado;
  } catch { /* era un string de verdad: se queda como string */ }
  return valor;
}

export function httpsJson(method: string, url: string, body: unknown, hdrs?: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string | number> = { 'Content-Type': 'application/json', ...hdrs };
    const bs = method !== 'GET' && body != null ? JSON.stringify(body) : null;
    if (bs) h['Content-Length'] = Buffer.byteLength(bs);
    const rq = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (r2) => {
      leerCuerpo(r2, (texto) => resolve({
        status: r2.statusCode,
        data: parsearCuerpo(texto),
        headers: r2.headers as HttpResponse['headers'],
      }));
    });
    rq.setTimeout(90_000, () => rq.destroy(new Error('Timeout 90s')));
    rq.on('error', reject);
    if (bs) rq.write(bs);
    rq.end();
  });
}

/** Excepciones que un llamador concreto puede pedirle a `httpsGetJson`. */
export interface OpcionesGetJson {
  /**
   * Habla `http://` EN CLARO cuando la URL lo dice, en vez de forzar `https` igualmente.
   *
   * Apagado por defecto y a propósito: el comportamiento histórico de este helper —compartido con
   * traspaso, RUNT, Fasecolda y Mercado Libre— es hablar `https` pase lo que pase, y ninguno de
   * esos llamadores debe cambiar por esto. Lo enciende UNA fuente, el UTS municipal de
   * comparendos, cuyo proveedor no publica HTTPS (decisión de David, 2026-08-20); su adapter pide
   * la misma excepción arriba, en `baseUrlExigida`, para que la decisión quede en un solo sitio.
   *
   * Que sea un parámetro por llamada, y no una variable de entorno, es lo que impide que abrirlo
   * para el UTS lo abra también para una petición que lleve credencial en la cabecera.
   */
  permitirTextoPlano?: boolean;

  /**
   * Admite UNA capa de codificación doble en el cuerpo (ver `parsearCuerpo`).
   *
   * Apagado por defecto, y por la misma razón que `permitirTextoPlano`: con la opción apagada, un
   * cuerpo que parsea a `string` sigue llegando como `string`, que es lo que traspaso, RUNT,
   * Fasecolda y Mercado Libre han visto siempre. Lo enciende UNA fuente —el UTS municipal—, que
   * devuelve el resultado ya serializado como texto en los cinco municipios medidos el 2026-08-21
   * —de los ocho sembrados; ver `parsearCuerpo`— (Bug #11711). Que la opción sea opt-in por llamada
   * también cubre eso: si alguno de los tres sin medir contestara bien, el desenrollado ni se
   * dispara —solo actúa cuando el primer `JSON.parse` entrega un `string`—.
   */
  desenrollarJsonAnidado?: boolean;
}

export function httpsGetJson(
  url: string, hdrs?: Record<string, string>, timeoutMs = 15_000, opciones: OpcionesGetJson = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Con la excepción apagada (el default) se sigue usando `https` aunque la URL diga `http:`,
    // que es lo que este helper ha hecho siempre.
    const enClaro = u.protocol === 'http:' && opciones.permitirTextoPlano === true;
    const transporte = enClaro ? http : https;
    const rq = transporte.request({
      method: 'GET', hostname: u.hostname,
      // El puerto de la URL se DESCARTABA: un `…:8080` salía en silencio contra el 443 del host,
      // que es un fallo mudo —la petición sale, pero no a donde dice la variable de entorno—.
      // `u.port` es `''` cuando la URL no lo trae, y ahí `undefined` deja el default del módulo.
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: { Accept: 'application/json', 'User-Agent': 'Kyverum-Operaciones/1.0', ...hdrs },
      timeout: timeoutMs,
    }, (r2) => {
      leerCuerpo(r2, (texto) => resolve({
        status: r2.statusCode,
        data: parsearCuerpo(texto, opciones.desenrollarJsonAnidado === true),
      }));
    });
    rq.on('error', reject);
    rq.on('timeout', () => { rq.destroy(); reject(new Error('Timeout')); });
    rq.end();
  });
}

export function httpsFormPost(url: string, body: string, hdrs?: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string | number> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...hdrs,
    };
    const rq = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: h }, (r2) => {
      leerCuerpo(r2, (texto) => resolve({ status: r2.statusCode, data: parsearCuerpo(texto) }));
    });
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}
