import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
// OPS-02b r3: mock KEYED por tabla.
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

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

const runScheduleOnceMock = vi.fn().mockResolvedValue({ created: 0, updated: 0 });
vi.mock('../../src/modules/maintenance/schedule.cron.js', () => ({
  runScheduleOnce: runScheduleOnceMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  runScheduleOnceMock.mockClear().mockResolvedValue({ created: 0, updated: 0 });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/maintenance/schedule.routes.js');
  app.use('/api/maint/schedule', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('schedule — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/schedule');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/schedule').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('admin → 200', async () => {
    kdb.when.selectOnce('maintenance_schedule', [{ id: 1, vehicleId: 5 }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/schedule').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('todos los filtros (vehicleId/estado/desde/hasta)', async () => {
    kdb.when.selectOnce('maintenance_schedule', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/schedule?vehicleId=5&estado=pendiente&desde=2026-01-01&hasta=2026-12-31')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /', () => {
  const VALID = { vehicleId: 5, routineId: 1, fechaProgramada: '2026-06-01' };

  it('sin routineId ni jobId → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/schedule').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, fechaProgramada: '2026-06-01' });
    expect(r.status).toBe(400);
  });

  it('fechaProgramada formato inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/schedule').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, fechaProgramada: '01/06/2026' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + tipo manual + estado pendiente', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/maint/schedule').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(captured.tipo).toBe('manual');
    expect(captured.estado).toBe('pendiente');
    expect(captured.creadoPor).toBe(7);
  });
});

describe('PATCH /:id/cancel', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/schedule/abc/cancel').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado o no pendiente → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/schedule/999/cancel').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('cancelar → 200 + audit cancelled', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'cancelada' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/schedule/1/cancel').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('cancelled');
  });
});

describe('POST /recompute', () => {
  it('admin → corre cron + 200', async () => {
    runScheduleOnceMock.mockResolvedValueOnce({ created: 5, updated: 2 });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/schedule/recompute').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.stats.created).toBe(5);
    expect(runScheduleOnceMock).toHaveBeenCalled();
  });
});
