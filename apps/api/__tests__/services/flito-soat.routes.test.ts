import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, username: 'u', role: role as never })}`;

describe('flito-soat — RBAC', () => {
  it('sin token → 401', async () => {
    expect((await request(await buildApp()).get('/api/flito/soat')).status).toBe(401);
  });
  it('gestor_impuestos → 403 (no participa en SOAT)', async () => {
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(403);
  });
  it('auditor → lectura 200 (solo lectura)', async () => {
    selectMock.mockReturnValueOnce(chain([])); // cola vacía
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  it('auditor → POST /enviar 403 (escritura)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/enviar').set('Authorization', await auth('auditor')).send({ ids: ['00000000-0000-0000-0000-000000000001'] });
    expect(r.status).toBe(403);
  });
  it('proveedor (gestor) → POST /:id/reactivar 403 (solo operaciones)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('proveedor')).send({ motivo: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('flito-soat — validaciones y errores', () => {
  it('enviar con ids vacío → 400', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/enviar').set('Authorization', await auth('operaciones')).send({ ids: [] });
    expect(r.status).toBe(400);
  });
  it('reversar con motivo < 5 → 400', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reversar')
      .set('Authorization', await auth('operaciones')).send({ estadoDestino: 'pendiente', motivo: 'x' });
    expect(r.status).toBe(400);
  });
  it('reactivar un SOAT inexistente → 404 (SoatError)', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no existe
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('operaciones')).send({ motivo: 'corregido' });
    expect(r.status).toBe(404);
  });
  it('reactivar un SOAT que no está Rechazado → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'x', estado: 'pagado' }]));
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('operaciones')).send({ motivo: 'corregido' });
    expect(r.status).toBe(400);
  });
});
