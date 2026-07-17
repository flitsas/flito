import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { requestWithRetry, upstreamHttpStatus, UpstreamError } from '../../src/shared/upstream.js';

// Servidor local controlable para probar la lógica de resiliencia de verdad
// (no mocks): cuenta requests por path y responde según el escenario.
let server: http.Server;
let base = '';
let calls: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = req.url || '/';
    calls[p] = (calls[p] || 0) + 1;
    if (p === '/flaky') {
      // 503 las primeras 2 veces, 200 a la 3ª.
      if (calls[p] < 3) { res.statusCode = 503; res.end('busy'); return; }
      res.statusCode = 200; res.end('ok'); return;
    }
    if (p === '/always503') { res.statusCode = 503; res.end('down'); return; }
    if (p === '/bad') { res.statusCode = 400; res.end('nope'); return; }
    if (p === '/hang') { /* nunca responde dentro del timeout */ setTimeout(() => res.end('late'), 10_000); return; }
    res.statusCode = 200; res.end('default');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('TRAM-10/11 · requestWithRetry (resiliencia upstream)', () => {
  it('reintenta ante 503 y devuelve 200 al recuperarse', async () => {
    calls = {};
    const r = await requestWithRetry({ url: `${base}/flaky`, retries: 2, backoffMs: 5 });
    expect(r.statusCode).toBe(200);
    expect(r.attempts).toBe(3);
    expect(calls['/flaky']).toBe(3);
  });

  it('agota reintentos y devuelve el último status reintentable', async () => {
    calls = {};
    const r = await requestWithRetry({ url: `${base}/always503`, retries: 2, backoffMs: 5 });
    expect(r.statusCode).toBe(503);
    expect(r.attempts).toBe(3);
    expect(calls['/always503']).toBe(3);
  });

  it('NO reintenta ante 4xx (no reintentable)', async () => {
    calls = {};
    const r = await requestWithRetry({ url: `${base}/bad`, retries: 2, backoffMs: 5 });
    expect(r.statusCode).toBe(400);
    expect(r.attempts).toBe(1);
    expect(calls['/bad']).toBe(1);
  });

  it('timeout lanza UpstreamError(kind=timeout)', async () => {
    await expect(
      requestWithRetry({ url: `${base}/hang`, retries: 0, timeoutMs: 60, backoffMs: 5 }),
    ).rejects.toMatchObject({ name: 'UpstreamError', kind: 'timeout' });
  });

  it('error de red (host inexistente) lanza UpstreamError(kind=network)', async () => {
    await expect(
      requestWithRetry({ url: 'http://127.0.0.1:1/nope', retries: 0, timeoutMs: 200, backoffMs: 5 }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('upstreamHttpStatus — mapeo a códigos claros', () => {
  it('timeout → 504, network → 502, 5xx → 502, 429 → 503', () => {
    expect(upstreamHttpStatus({ kind: 'timeout' })).toBe(504);
    expect(upstreamHttpStatus({ kind: 'network' })).toBe(502);
    expect(upstreamHttpStatus({ statusCode: 502 })).toBe(502);
    expect(upstreamHttpStatus({ statusCode: 429 })).toBe(503);
  });
});
