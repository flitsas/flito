import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
// OPS-02b r3: mock KEYED por tabla.
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { insert: insertMock, update: updateMock, delete: deleteMock } = kdb;

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
  const { default: router } = await import('../../src/modules/maintenance/routines.routes.js');
  app.use('/api/maint/routines', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('routines — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/routines');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/routines').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / + GET /:id', () => {
  it('GET / → lista activas', async () => {
    kdb.when.selectOnce('maintenance_routines', [{ id: 1, codigo: 'R-001' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/routines').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('GET /:id no encontrada → 404', async () => {
    kdb.when.selectOnce('maintenance_routines', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/routines/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('GET /:id encontrada → 200 con jobs/parts/periodicity', async () => {
    kdb.when.selectOnce('maintenance_routines', [{ id: 1, codigo: 'R-001' }]); // routine
    kdb.when.selectOnce('routine_jobs', [{ jobId: 10, orden: 1 }]); // jobs
    kdb.when.selectOnce('routine_parts', [{ partId: 20, cantidad: '2' }]); // parts
    kdb.when.selectOnce('routine_periodicity', [{ id: 1, criterio: 'vehicle' }]); // periods
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/routines/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(1);
    expect(r.body.parts).toHaveLength(1);
    expect(r.body.periodicity).toHaveLength(1);
  });
});

describe('POST / + PATCH /:id', () => {
  it('POST codigo inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'r 001', nombre: 'Rutina X' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, codigo: 'R-001' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'R-001', nombre: 'Rutina X' });
    expect(r.status).toBe(201);
  });

  it('PATCH no encontrada → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/routines/999').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('POST /:id/jobs + DELETE /:id/jobs/:jobId', () => {
  it('POST jobs → 201 (upsert)', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines/1/jobs').set('Authorization', `Bearer ${token}`)
      .send({ jobId: 10, orden: 2 });
    expect(r.status).toBe(201);
  });

  it('DELETE job → 200', async () => {
    deleteMock.mockReturnValueOnce({
      where: () => Promise.resolve(undefined),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/maint/routines/1/jobs/10').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /:id/parts + DELETE /:id/parts/:partId', () => {
  it('POST parts → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines/1/parts').set('Authorization', `Bearer ${token}`)
      .send({ partId: 20, cantidad: 3 });
    expect(r.status).toBe(201);
  });

  it('DELETE part → 200', async () => {
    deleteMock.mockReturnValueOnce({
      where: () => Promise.resolve(undefined),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/maint/routines/1/parts/20').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /:id/periodicity', () => {
  it('sin período (km/horas/dias) → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines/1/periodicity').set('Authorization', `Bearer ${token}`)
      .send({ criterio: 'vehicle', refId: 5 });
    expect(r.status).toBe(400);
  });

  it('criterio vehicle sin refId → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines/1/periodicity').set('Authorization', `Bearer ${token}`)
      .send({ criterio: 'vehicle', kmPeriodo: 5000 });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + invalida schedules pendientes', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    let updateCalled = false;
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => { updateCalled = true; return Promise.resolve(undefined); } }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/routines/1/periodicity').set('Authorization', `Bearer ${token}`)
      .send({ criterio: 'vehicle', refId: 5, kmPeriodo: 5000 });
    expect(r.status).toBe(201);
    expect(updateCalled).toBe(true);
  });

  it('DELETE periodicity → 200', async () => {
    deleteMock.mockReturnValueOnce({
      where: () => Promise.resolve(undefined),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/maint/routines/1/periodicity/10').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});
