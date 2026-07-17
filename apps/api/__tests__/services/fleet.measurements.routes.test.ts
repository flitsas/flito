import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
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
  selectMock.mockReset();
  insertMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/fleet/measurements.routes.js');
  app.use('/api/fleet/measurements', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('measurements — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/measurements/vehicle/1');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/measurements/vehicle/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /vehicle/:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/measurements/vehicle/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('lista mediciones → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, vehicleId: 5, odometro: 50000 }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/measurements/vehicle/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe('POST /', () => {
  const VALID = { vehicleId: 5, odometro: 50000 };

  it('sin odometro ni horometro → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5 });
    expect(r.status).toBe(400);
  });

  it('vehicleId no positivo → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: -1, odometro: 100 });
    expect(r.status).toBe(400);
  });

  it('vehículo no es flota propia → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(404);
  });

  it('vehículo tipoMedicion=km sin odometro → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, tipoMedicion: 'km', distPromedioDia: 100, esFlotaPropia: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, horometro: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/odómetro/i);
  });

  it('vehículo tipoMedicion=horas sin horometro → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, tipoMedicion: 'horas', distPromedioDia: null, esFlotaPropia: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, odometro: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/horómetro/i);
  });

  it('éxito sin medición previa → 201', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, tipoMedicion: 'km', distPromedioDia: 100, esFlotaPropia: true }]));
    selectMock.mockReturnValueOnce(chain([])); // sin medición previa
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, odometro: 50000 });
    expect(r.status).toBe(201);
    expect(captured.usuarioId).toBe(7);
    expect(captured.excedioPromedio).toBe(false);
  });

  it('odometro menor al previo → warnings', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, tipoMedicion: 'km', distPromedioDia: null, esFlotaPropia: true }]));
    selectMock.mockReturnValueOnce(chain([{ fecha: '2026-01-01', odometro: 60000, horometro: null }]));
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, odometro: 50000 });
    expect(r.status).toBe(201);
    expect(r.body.warnings.length).toBeGreaterThan(0);
    expect(r.body.warnings[0]).toMatch(/menor/);
  });

  it('excedio promedio (>3x) → excedioPromedio=true + warning', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, tipoMedicion: 'km', distPromedioDia: 100, esFlotaPropia: true }]));
    selectMock.mockReturnValueOnce(chain([{ fecha: '2026-05-01', odometro: 50000, horometro: null }]));
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    // En 5 días: 100*5*3 = 1500 km es el límite. Mete 2000 km → exceeds
    const r = await request(app).post('/api/fleet/measurements').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, odometro: 52000, fecha: '2026-05-06' });
    expect(r.status).toBe(201);
    expect(captured.excedioPromedio).toBe(true);
    expect(r.body.warnings.some((w: string) => w.includes('excede'))).toBe(true);
  });
});
