import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    transaction: transactionMock,
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
  updateMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/fleet/links.routes.js');
  app.use('/api/fleet/links', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('fleet links — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/links/vehicle/1');
    expect(r.status).toBe(401);
  });

  it('proveedor sin fleet → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/links/vehicle/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /vehicle/:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/links/vehicle/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('lista vínculos → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, vehiculoPrincipalId: 5, vehiculoVinculadoId: 6 }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/fleet/links/vehicle/5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe('POST /', () => {
  const VALID = { vehiculoPrincipalId: 5, vehiculoVinculadoId: 6 };

  it('mismo vehículo principal y vinculado → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`)
      .send({ vehiculoPrincipalId: 5, vehiculoVinculadoId: 5 });
    expect(r.status).toBe(400);
  });

  it('vehiculoPrincipalId no positivo → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`)
      .send({ vehiculoPrincipalId: -1, vehiculoVinculadoId: 6 });
    expect(r.status).toBe(400);
  });

  it('un vehículo no es flota propia → 400', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 5, esFlota: true },
      { id: 6, esFlota: false },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/flota propia/);
  });

  it('un vehículo no existe (only 1 row) → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5, esFlota: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + transaction (cierra previo + crea nuevo)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 5, esFlota: true },
      { id: 6, esFlota: true },
    ]));
    let updateCalled = false;
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({
            where: () => { updateCalled = true; return Promise.resolve(undefined); },
          }),
        })),
        insert: vi.fn(() => ({
          values: (v: any) => { insertedValues = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(updateCalled).toBe(true);
    expect(insertedValues.creadoPor).toBe(7);
    expect(insertedValues.esActual).toBe(true);
    expect(auditMock).toHaveBeenCalled();
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/fleet/links').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(403);
  });
});

describe('PATCH /:id/close', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/links/abc/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/links/999/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('cerrado → 200 + audit closed', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, esActual: false }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/fleet/links/1/close').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('closed');
  });
});
