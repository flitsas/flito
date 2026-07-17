import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain, chainReject } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

// OPS-02b r3: mock KEYED por tabla.
const kdb = createKeyedDb();
const { insert: insertMock, update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/maintenance/parts.routes.js');
  app.use('/api/maint/parts', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('parts — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /locations + POST /locations', () => {
  it('GET → lista', async () => {
    kdb.when.selectOnce('parts_locations', [{ id: 1, codigo: 'BOD-1' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts/locations').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('POST codigo no regex → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/locations').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'bod 1', nombre: 'Bodega' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, codigo: 'BOD-1' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/locations').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'BOD-1', nombre: 'Bodega Principal' });
    expect(r.status).toBe(201);
  });
});

describe('GET / (parts)', () => {
  it('200 + filter conStockBajo', async () => {
    kdb.when.selectOnce('parts', [
      { id: 1, codigo: 'P-001', stockTotal: '5', existenciaMin: '10' }, // low
      { id: 2, codigo: 'P-002', stockTotal: '20', existenciaMin: '10' }, // ok
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts?conStockBajo=1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].id).toBe(1);
  });

  it('GET con q + systemId → 200', async () => {
    kdb.when.selectOnce('parts', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts?q=filtro&systemId=1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /', () => {
  it('codigo inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'lower', nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('existenciaMax < min → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'P-001', nombre: 'Aceite', existenciaMin: 100, existenciaMax: 50 });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + existenciaMin como string', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'P-001', nombre: 'Aceite', existenciaMin: 10 });
    expect(r.status).toBe(201);
    expect(captured.existenciaMin).toBe('10');
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/parts/abc').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/parts/999').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('GET /:id/stock', () => {
  it('lista stock por ubicación', async () => {
    kdb.when.selectOnce('parts_stock', [{ locationCodigo: 'BOD-1', cantidad: '10' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts/1/stock').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /movements', () => {
  it('lista con filtros → 200', async () => {
    kdb.when.selectOnce('parts_movements', [{ id: 1, tipo: 'entrada' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/parts/movements?partId=5&tipo=entrada&desde=2026-01-01')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /movements', () => {
  it('entrada sin destino o sin valorUnit → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/movements').set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'entrada', partId: 1, cantidad: 5 });
    expect(r.status).toBe(400);
  });

  it('traslado origen=destino → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/movements').set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'traslado', partId: 1, cantidad: 5, ubicacionOrigenId: 1, ubicacionDestinoId: 1 });
    expect(r.status).toBe(400);
  });

  it('salida sin origen → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/movements').set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'salida', partId: 1, cantidad: 5 });
    expect(r.status).toBe(400);
  });

  it('entrada éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, tipo: 'entrada' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/movements').set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'entrada', partId: 1, cantidad: 10, valorUnit: 5000, ubicacionDestinoId: 2 });
    expect(r.status).toBe(201);
  });

  it('salida con stock insuficiente (P0001) → 422', async () => {
    const err: any = new Error('Stock insuficiente para repuesto');
    err.code = 'P0001';
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => chainReject(err) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/parts/movements').set('Authorization', `Bearer ${token}`)
      .send({ tipo: 'salida', partId: 1, cantidad: 100, ubicacionOrigenId: 2 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Stock insuficiente/);
  });
});
