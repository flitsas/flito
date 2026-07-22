import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => selectMock.mockReset());

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-demo/flito-demo.routes.js');
  app.use('/api/flito/demo', router);
  return app;
}

// El panel de demo es solo para `operaciones` (fabrica los trámites del FLIT simulado).
describe('flito-demo — RBAC', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/flito/demo/tramites')).status).toBe(401);
  });

  it('proveedor (gestor SOAT) → 403', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/flito/demo/tramites').set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`);
    expect(r.status).toBe(403);
  });

  it('gestor_impuestos → 403', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/flito/demo/tramites').set('Authorization', `Bearer ${await testToken({ role: 'gestor_impuestos' })}`).send({});
    expect(r.status).toBe(403);
  });

  it('operaciones → lista 200', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/demo/tramites').set('Authorization', `Bearer ${await testToken({ role: 'operaciones' })}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('operaciones → crear con body inválido → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/flito/demo/tramites').set('Authorization', `Bearer ${await testToken({ role: 'operaciones' })}`).send({ organismoCodigo: '05001' });
    expect(r.status).toBe(400);
  });
});
