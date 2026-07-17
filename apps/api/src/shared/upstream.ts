// TRAM-10/11 — cliente HTTP resiliente para integraciones externas (CEA FUR,
// Anthropic). Reemplaza los `https.request` ad-hoc dispersos: un solo lugar con
// timeout explícito, retry acotado con backoff, y clasificación de errores para
// mapear a códigos HTTP claros (502/503/504) hacia el cliente en vez de 500 opaco.

import http from 'node:http';
import https from 'node:https';

export type UpstreamKind = 'timeout' | 'network';

export class UpstreamError extends Error {
  constructor(public readonly kind: UpstreamKind, message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamResponse {
  statusCode: number;
  buffer: Buffer;
  attempts: number;
}

export interface RequestOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Timeout por intento (ms). Default 30s. */
  timeoutMs?: number;
  /** Reintentos adicionales (intentos totales = retries + 1). Default 2. */
  retries?: number;
  /** Qué status dispara retry. Default: 429 o >= 500. */
  retryableStatus?: (status: number) => boolean;
  /** Backoff base lineal (ms). Default 300. */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function once(opts: RequestOpts, timeoutMs: number): Promise<{ statusCode: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(opts.url); } catch { reject(new UpstreamError('network', `URL inválida: ${opts.url}`)); return; }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: opts.method ?? 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new UpstreamError('timeout', `timeout tras ${timeoutMs}ms`)));
    req.on('error', (e: any) => reject(e instanceof UpstreamError ? e : new UpstreamError('network', e?.message || 'error de red')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Hace la request con timeout + retry acotado. Reintenta ante timeout, error de
 * red, o status reintentable (429/5xx). Si se agotan los reintentos con un status
 * reintentable, DEVUELVE esa respuesta (el caller la mapea). Si el último intento
 * es timeout/red, LANZA UpstreamError.
 */
export async function requestWithRetry(opts: RequestOpts): Promise<UpstreamResponse> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retryable = opts.retryableStatus ?? ((s) => s === 429 || s >= 500);
  const base = opts.backoffMs ?? 300;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(base * attempt);
    try {
      const r = await once(opts, timeoutMs);
      if (retryable(r.statusCode) && attempt < retries) {
        lastErr = new UpstreamError('network', `upstream ${r.statusCode}`);
        continue;
      }
      return { ...r, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) continue;
      throw e instanceof UpstreamError ? e : new UpstreamError('network', (e as Error)?.message || 'error de red');
    }
  }
  // Inalcanzable, pero por tipo:
  throw lastErr instanceof Error ? lastErr : new UpstreamError('network', 'fallo upstream');
}

/** Mapea un fallo upstream a un código HTTP claro hacia el cliente. */
export function upstreamHttpStatus(info: { kind?: UpstreamKind; statusCode?: number }): number {
  if (info.kind === 'timeout') return 504;       // Gateway Timeout
  if (info.kind === 'network') return 502;       // Bad Gateway
  if (info.statusCode === 429) return 503;        // Service Unavailable (rate limit)
  if (info.statusCode && info.statusCode >= 500) return 502;
  return 502;
}
