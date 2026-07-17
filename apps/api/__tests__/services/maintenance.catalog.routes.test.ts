import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
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
  const { default: router } = await import('../../src/modules/maintenance/catalog.routes.js');
  app.use('/api/maint/catalog', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('catalog — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/systems');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/systems').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /systems + POST /systems', () => {
  it('GET 200 con lista', async () => {
    kdb.when.selectOnce('maintenance_systems', [{ id: 1, codigo: 'MOTOR' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/systems').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('POST codigo no regex → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/catalog/systems').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'mot-or', nombre: 'Motor' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, codigo: 'MOTOR' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/catalog/systems').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'MOTOR', nombre: 'Motor' });
    expect(r.status).toBe(201);
  });
});

describe('GET /subsystems + POST /subsystems', () => {
  it('GET sin systemId → 200', async () => {
    kdb.when.selectOnce('maintenance_subsystems', [{ id: 1, systemId: 1 }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/subsystems').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('GET con systemId → 200', async () => {
    kdb.when.selectOnce('maintenance_subsystems', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/subsystems?systemId=5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/catalog/subsystems').set('Authorization', `Bearer ${token}`)
      .send({ systemId: 1, codigo: 'SUB', nombre: 'Subsistema' });
    expect(r.status).toBe(201);
  });
});

describe('GET /jobs + POST /jobs', () => {
  it('GET con q + systemId → 200', async () => {
    kdb.when.selectOnce('maintenance_jobs', [{ id: 1, codigo: 'JOB-001' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/jobs?q=cambio&systemId=1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('POST codigo inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/catalog/jobs').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'job lower', nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, codigo: 'JOB-001' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/catalog/jobs').set('Authorization', `Bearer ${token}`)
      .send({ codigo: 'JOB-001', nombre: 'Cambio aceite' });
    expect(r.status).toBe(201);
  });
});

describe('PATCH /jobs/:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/catalog/jobs/abc').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/catalog/jobs/999').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('actualizar → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, nombre: 'Nuevo' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/catalog/jobs/1').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Nuevo' });
    expect(r.status).toBe(200);
  });
});

describe('GET /mechanics + PATCH /mechanics/:userId', () => {
  it('GET → lista mecánicos activos', async () => {
    kdb.when.selectOnce('users', [{ id: 1, name: 'Pedro', esMecanico: true }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/catalog/mechanics').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('PATCH no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/catalog/mechanics/999').set('Authorization', `Bearer ${token}`)
      .send({ esMecanico: true });
    expect(r.status).toBe(404);
  });

  it('PATCH habilitar mecánico + audit detail', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 5, esMecanico: true, especialidades: ['motor'] }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/maint/catalog/mechanics/5').set('Authorization', `Bearer ${token}`)
      .send({ esMecanico: true, especialidades: ['motor'] });
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toMatch(/es_mecanico=true/);
  });
});
