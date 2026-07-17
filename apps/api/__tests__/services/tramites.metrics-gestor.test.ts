// TRAM-DASH-01 — GET /api/tramites/metrics/gestor (KPIs por creado_por).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: executeMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { executeMock.mockReset(); executeMock.mockResolvedValue([]); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('GET /api/tramites/metrics/gestor — TRAM-DASH-01', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/gestor');
    expect(r.status).toBe(401);
  });

  it('admin → 200 con KPIs del gestor (userId=5)', async () => {
    executeMock
      .mockResolvedValueOnce([{ creados: 10, enviados: 4, rechazados: 1, activos: 5 }])
      .mockResolvedValueOnce([{ overall_status: 'green', n: 3 }])
      .mockResolvedValueOnce([{ tipologia: 'traspaso_standard', n: 6 }])
      .mockResolvedValueOnce([{ horas_mediana: '8.0', n: 4 }])
      .mockResolvedValueOnce([{ codigo: 'comparendo', n: 1 }]);
    const token = await testToken({ sub: 5, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/gestor?days=30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.totales).toEqual({ creados: 10, enviados: 4, rechazados: 1, activos: 5 });
    expect(r.body.preflight[0]).toEqual({ overall_status: 'green', n: 3 });
    expect(JSON.stringify(r.body)).not.toMatch(/"(documento|cedula|nombre|email)"/i);
  });

  it('transito puede consultar sus propias métricas', async () => {
    executeMock
      .mockResolvedValueOnce([{ creados: 0, enviados: 0, rechazados: 0, activos: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ horas_mediana: null, n: 0 }])
      .mockResolvedValueOnce([]);
    const token = await testToken({ sub: 2, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/gestor').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.totales.creados).toBe(0);
  });
});
