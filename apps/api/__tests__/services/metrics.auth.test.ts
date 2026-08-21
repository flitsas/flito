// Bug #11599 — GET /metrics respondía 200 sin autenticación en DEV, QA y PDN.
//
// Se prueba contra la ruta REAL de `createApp`, no contra el middleware montado aparte:
// lo que falló no fue la lógica del guard (no existía), sino que la ruta estuviera servida
// sin él. Un test del middleware suelto pasaría aunque nadie lo cablease en app.ts.
//
// `env` es una foto tomada en el import (ver __tests__/setup.ts), así que tocar
// process.env.METRICS_TOKEN en caliente no cambiaría nada: se redefine la propiedad sobre
// el objeto `env` real con un getter, dejando el resto del entorno intacto para que
// createApp arranque de verdad.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { envMock } = vi.hoisted(() => ({ envMock: { METRICS_TOKEN: undefined as string | undefined } }));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  Object.defineProperty(actual.env, 'METRICS_TOKEN', {
    get: () => envMock.METRICS_TOKEN,
    configurable: true,
  });
  return actual;
});

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

const TOKEN = 'metrics-token-de-prueba-32-chars-min';

let app: any;

beforeEach(async () => {
  envMock.METRICS_TOKEN = undefined;
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('GET /metrics — Bug #11599', () => {
  it('sin METRICS_TOKEN configurado → 404 y NO entrega el registro', async () => {
    const r = await request(app).get('/metrics');

    expect(r.status).toBe(404);
    // El defecto era servir el registro: comprobar el 404 sin comprobar el cuerpo dejaría
    // pasar una respuesta que devolviese las métricas con el código cambiado.
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con METRICS_TOKEN y sin Authorization → 401 con WWW-Authenticate', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics');

    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con Bearer incorrecto de la misma longitud → 401', async () => {
    envMock.METRICS_TOKEN = TOKEN;
    const falso = 'x'.repeat(TOKEN.length);

    const r = await request(app).get('/metrics').set('Authorization', `Bearer ${falso}`);

    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con Bearer de longitud distinta → 401 (timingSafeEqual no lanza)', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    // timingSafeEqual tira TypeError si los buffers difieren en longitud: sin el chequeo
    // previo esto sería un 500, no un 401.
    const r = await request(app).get('/metrics').set('Authorization', 'Bearer corto');

    expect(r.status).toBe(401);
  });

  it('con el Bearer correcto → 200 y entrega el registro Prometheus', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    // Cerrar la ruta rompiéndola no es cerrarla: el scrape autenticado debe seguir
    // recibiendo el registro.
    expect(r.text).toMatch(/operaciones_/);
  });
});
