// HTTP helpers para integraciones directas (SIMIT, Fasecolda, ML, RUNT).

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

export function httpsGetJson(url: string, hdrs?: Record<string, string>, timeoutMs = 15_000): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const rq = https.request({
      method: 'GET', hostname: u.hostname, path: u.pathname + u.search,
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
