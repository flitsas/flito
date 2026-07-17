// OPS-02b r2: mock KEYED por tabla.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
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
  const { default: router } = await import('../../src/modules/fleet/vehicles.routes.js');
  app.use('/api/fleet/vehicles', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('fleet vehicles — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles');
    expect(r.status).toBe(401);
  });

  it('proveedor sin fleet → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('admin → 200 con array', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 1, plate: 'ABC123' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('filtros search/tipo/combustible', async () => {
    kdb.when.selectOnce('vehicles', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles?search=ABC&tipo=camion&combustible=acpm')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    kdb.when.selectOnce('vehicles', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con lastMeasurement + links', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 1, plate: 'ABC123' }]);
    kdb.when.selectOnce('vehicle_measurements', [{ fecha: '2026-05-01', odometro: 50000 }]);
    kdb.when.selectOnce('vehicle_equipment_links', []); // links principal
    kdb.when.selectOnce('vehicle_equipment_links', []); // links vinculado
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/vehicles/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.lastMeasurement.odometro).toBe(50000);
  });
});

describe('POST /', () => {
  const VALID = { plate: 'ABC123', brand: 'Mack' };

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(403);
  });

  it('year fuera de rango → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, year: 1800 });
    expect(r.status).toBe(400);
  });

  it('tipoVehiculo fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, tipoVehiculo: 'helicoptero' });
    expect(r.status).toBe(400);
  });

  it('VIN duplicado → 409', async () => {
    kdb.when.selectOnce('vehicles', [{ id: 999 }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, vin: 'ABCDEF12345678901' });
    expect(r.status).toBe(409);
  });

  it('éxito → 201 + esFlotaPropia=true + audit', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(captured.esFlotaPropia).toBe(true);
    expect(captured.stage).toBe('listo');
    expect(auditMock).toHaveBeenCalled();
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/vehicles/abc').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/vehicles/999').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'XYZ' });
    expect(r.status).toBe(404);
  });

  it('actualizar plate → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, plate: 'XYZ' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/vehicles/1').set('Authorization', `Bearer ${token}`)
      .send({ plate: 'XYZ' });
    expect(r.status).toBe(200);
    expect(r.body.data.plate).toBe('XYZ');
  });
});

describe('POST /:id/convert', () => {
  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles/999/convert').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('convierte a flota → 200 + audit detail converted_to_fleet', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, esFlotaPropia: true }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/vehicles/1/convert').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('converted_to_fleet');
  });
});
