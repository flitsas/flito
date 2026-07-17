// TRAMITES-ABCD · Sprint A — GET /api/tramites/metrics/summary (panel admin).

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

describe('GET /api/tramites/metrics/summary — admin-only', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/summary');
    expect(r.status).toBe(401);
  });

  it('rol transito → 403 (no es admin)', async () => {
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/summary').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('rol proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/summary').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('admin → 200 con todos los bloques del epic', async () => {
    // 8 bloques en orden: preflight, tiempo, rechazos, rechazosPorMotivo, tipologias, notif, portal, lotes
    executeMock
      .mockResolvedValueOnce([{ overall_status: 'green', n: 5 }, { overall_status: 'yellow', n: 2 }])
      .mockResolvedValueOnce([{ horas_mediana: '12.5', n: 7 }])
      .mockResolvedValueOnce([{ rechazos: 1, enviados: 7 }])
      .mockResolvedValueOnce([{ codigo: 'comparendo', n: 1 }])
      .mockResolvedValueOnce([{ tipologia: 'flota_corporativa', n: 4 }])
      .mockResolvedValueOnce([{ canal: 'whatsapp', n: 3 }])
      .mockResolvedValueOnce([{ rol: 'comprador', invitados: 6, con_consentimiento: 4 }])
      .mockResolvedValueOnce([{ lotes: 2, filas: 50, tramites_creados: 48 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/summary?days=30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.windowDays).toBe(30);
    expect(r.body.preflight[0]).toEqual({ overall_status: 'green', n: 5 });
    expect(r.body.tiempoTransito).toEqual({ horas_mediana: 12.5, n: 7 });
    expect(r.body.rechazosOt).toEqual({ rechazos: 1, enviados: 7 });
    expect(r.body.rechazosPorMotivo[0]).toEqual({ codigo: 'comparendo', n: 1 });
    expect(r.body.tipologias[0].tipologia).toBe('flota_corporativa');
    expect(r.body.notificaciones[0].canal).toBe('whatsapp');
    expect(r.body.portal[0]).toEqual({ rol: 'comprador', invitados: 6, con_consentimiento: 4 });
    expect(r.body.lotes).toEqual({ lotes: 2, filas: 50, tramites_creados: 48 });
    // Sin PII: ningún bloque expone cédulas/nombres.
    expect(JSON.stringify(r.body)).not.toMatch(/"(documento|cedula|nombre|comprador_doc|email)"/i);
  });

  it('days fuera de rango → clamp (admin, query days=999 → 90)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/metrics/summary?days=999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.windowDays).toBe(90);
  });
});
