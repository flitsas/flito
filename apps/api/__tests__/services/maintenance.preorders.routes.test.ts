import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

// OPS-02b r3: mock KEYED por tabla. SELECT externos (GET) por tabla; la conversión
// a OT (transacción) conserva su tx posicional interno.
const kdb = createKeyedDb();
const { insert: insertMock, update: updateMock, transaction: transactionMock, execute: executeMock } = kdb;

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
  executeMock.mockResolvedValue({ rows: [{ count: 0 }] });
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/maintenance/preorders.routes.js');
  app.use('/api/maint/preorders', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('preorders — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('lista con filtros → 200', async () => {
    kdb.when.selectOnce('pre_orders', [{ id: 1, numero: 'PO-202605-0001' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders?estado=borrador&vehicleId=5')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('pre_orders', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con jobs/parts', async () => {
    kdb.when.selectOnce('pre_orders', [{ id: 1, numero: 'PO-X' }]); // po
    kdb.when.selectOnce('pre_order_jobs', [{ jobId: 10 }]); // jobs
    kdb.when.selectOnce('pre_order_parts', [{ partId: 20, cantidad: '5' }]); // parts
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/preorders/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(1);
    expect(r.body.parts).toHaveLength(1);
  });
});

describe('POST /', () => {
  it('vehicleId no positivo → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: -1 });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + numero PO-YYYYMM-NNNN', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ count: 5 }] });
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5 });
    expect(r.status).toBe(201);
    expect(captured.numero).toMatch(/^PO-\d{6}-\d{4}$/);
    expect(captured.creadoPor).toBe(7);
  });
});

describe('POST /:id/jobs y POST /:id/parts', () => {
  it('jobs → 201 (upsert)', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/jobs').set('Authorization', `Bearer ${token}`)
      .send({ jobId: 10, costoEstimado: 50000 });
    expect(r.status).toBe(201);
  });

  it('parts → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/parts').set('Authorization', `Bearer ${token}`)
      .send({ partId: 20, cantidad: 2, costoEstimado: 30000 });
    expect(r.status).toBe(201);
  });

  it('parts cantidad <= 0 → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/parts').set('Authorization', `Bearer ${token}`)
      .send({ partId: 20, cantidad: 0 });
    expect(r.status).toBe(400);
  });
});

describe('POST /:id/approve', () => {
  it('no es borrador → 409', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/approve').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
  });

  it('aprobada → 200 + audit detail approved', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'aprobada' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/approve').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('approved');
  });
});

describe('POST /:id/generate-ot', () => {
  it('preorden no encontrada → 409', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])),
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/999/generate-ot').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no encontrada/);
  });

  it('preorden no aprobada → 409', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([{ id: 1, estado: 'borrador', vehicleId: 5 }])),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/generate-ot').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/aprobadas/);
  });

  it('éxito → 201 con OT creada', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    transactionMock.mockImplementationOnce(async (cb) => {
      let selectCount = 0;
      const tx = {
        select: vi.fn(() => {
          selectCount++;
          if (selectCount === 1) return chain([{ id: 1, estado: 'aprobada', vehicleId: 5, observaciones: 'X' }]);
          return chain([]); // sin jobs ni parts
        }),
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 50, numero: 'OT-202605-0001' }]) }),
        })),
        update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/preorders/1/generate-ot').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(201);
    expect(r.body.data.id).toBe(50);
    expect(auditMock).toHaveBeenCalled();
  });
});
