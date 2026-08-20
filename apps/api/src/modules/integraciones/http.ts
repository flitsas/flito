// HTTP helpers para integraciones directas (SIMIT, Fasecolda, ML, RUNT).

import http from 'http';
import https from 'https';

export interface HttpResponse { status: number | undefined; data: any; headers?: Record<string, string | string[] | undefined> }

export function httpsJson(method: string, url: string, body: unknown, hdrs?: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string | number> = { 'Content-Type': 'application/json', ...hdrs };
    const bs = method !== 'GET' && body != null ? JSON.stringify(body) : null;
    if (bs) h['Content-Length'] = Buffer.byteLength(bs);
    const rq = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (r2) => {
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve({ status: r2.statusCode, data: JSON.parse(d), headers: r2.headers as HttpResponse['headers'] }); }
        catch { resolve({ status: r2.statusCode, data: d, headers: r2.headers as HttpResponse['headers'] }); }
      });
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
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve({ status: r2.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: r2.statusCode, data: d }); }
      });
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
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve({ status: r2.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: r2.statusCode, data: d }); }
      });
    });
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}
