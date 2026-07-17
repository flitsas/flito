import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

// OPS-02b r3: mock KEYED por tabla. Los SELECT externos (GET) se enrutan por
// tabla; las transacciones (cerrar/anular OT) conservan su tx posicional interno.
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
  const { default: router } = await import('../../src/modules/maintenance/workorders.routes.js');
  app.use('/api/maint/wo', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('workorders — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/wo');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/wo').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET / + GET /:id', () => {
  it('GET / con filtros → 200', async () => {
    kdb.when.selectOnce('work_orders', [{ id: 1, numero: 'OT-1' }]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/wo?estado=abierta&vehicleId=5&tipo=correctivo')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('GET /:id no encontrada → 404', async () => {
    kdb.when.selectOnce('work_orders', []);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/wo/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('GET /:id encontrada → 200 con jobs/parts/gastos/seg', async () => {
    kdb.when.selectOnce('work_orders', [{ id: 1, numero: 'OT-X' }]); // wo
    kdb.when.selectOnce('wo_jobs', [{ jobId: 10 }]); // jobs
    kdb.when.selectOnce('wo_parts', [{ partId: 20, cantidad: '1' }]); // parts
    kdb.when.selectOnce('wo_otros_gastos', []); // gastos
    kdb.when.selectOnce('wo_seguimientos', [{ texto: 'avance' }]); // seg
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/wo/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(1);
  });
});

describe('POST /', () => {
  it('vehicleId no positivo → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: -1 });
    expect(r.status).toBe(400);
  });

  it('tipoTrabajo fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, tipoTrabajo: 'inventado' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + numero OT-YYYYMM-NNNN + audit wo_open', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: 5, tipoTrabajo: 'correctivo', falla: 'fuga aceite' });
    expect(r.status).toBe(201);
    expect(captured.numero).toMatch(/^OT-\d{6}-\d{4}$/);
    expect(auditMock.mock.calls[0][1].action).toBe('wo_open');
  });
});

describe('POST /:id/jobs y /:id/parts y /:id/otros-gastos y /:id/seguimiento', () => {
  it('POST jobs → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/jobs').set('Authorization', `Bearer ${token}`)
      .send({ jobId: 10, costoManoObra: 100000 });
    expect(r.status).toBe(201);
  });

  it('POST parts requiere ubicacionId → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/parts').set('Authorization', `Bearer ${token}`)
      .send({ partId: 10, cantidad: 2 });
    expect(r.status).toBe(400);
  });

  it('POST parts éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/parts').set('Authorization', `Bearer ${token}`)
      .send({ partId: 10, cantidad: 2, ubicacionId: 5 });
    expect(r.status).toBe(201);
  });

  it('POST otros-gastos → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/otros-gastos').set('Authorization', `Bearer ${token}`)
      .send({ concepto: 'Diagnóstico', monto: 50000 });
    expect(r.status).toBe(201);
  });

  it('POST seguimiento → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/seguimiento').set('Authorization', `Bearer ${token}`)
      .send({ texto: 'Avance del 50%' });
    expect(r.status).toBe(201);
  });

  it('POST seguimiento texto vacío → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/seguimiento').set('Authorization', `Bearer ${token}`)
      .send({ texto: '' });
    expect(r.status).toBe(400);
  });
});

describe('POST /:id/close-tecnica', () => {
  it('no es abierta → 409', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-tecnica').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
  });

  it('cerrada técnica → 200 + audit', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'cerrada_tecnica' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-tecnica').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('close_tecnica');
  });
});

describe('POST /:id/close-final', () => {
  it('OT no encontrada → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn(() => chain([])),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/999/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no encontrada/);
  });

  it('idempotente: ya cerrada → 200', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, estado: 'cerrada_final', vehicle_id: 5 }] }),
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotente).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('estado inválido (anulada) → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, estado: 'anulada' }] }),
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no permite cierre/);
  });

  it('parte sin ubicación → 422', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, estado: 'abierta', vehicle_id: 5, numero: 'OT-X' }] }),
        select: vi.fn((..._args) => chain([
          // primer select: pendientes (parts)
          { id: 10, partId: 20, ubicacionId: null, cantidad: '5' },
        ])),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/sin ubicación/);
  });

  it('stock insuficiente → 422', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      let executeCount = 0;
      const tx = {
        execute: vi.fn().mockImplementation(() => {
          executeCount++;
          if (executeCount === 1) return Promise.resolve({ rows: [{ id: 1, estado: 'abierta', vehicle_id: 5, numero: 'OT-X' }] });
          return Promise.resolve({ rows: [{ cantidad: '1' }] }); // stock muy bajo
        }),
        select: vi.fn(() => chain([
          { id: 10, partId: 20, ubicacionId: 5, cantidad: '100', valorUnit: '1000', descuento: '0' },
        ])),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Stock insuficiente/);
  });

  it('éxito sin partes pendientes → 200 + audit wo_close', async () => {
    let updateCalls = 0;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, estado: 'abierta', vehicle_id: 5, numero: 'OT-X', medicion_ingreso: null, routine_id: null }] }),
        select: vi.fn(() => chain([])),
        insert: vi.fn(() => ({ values: () => Promise.resolve(undefined) })),
        update: vi.fn(() => ({
          set: () => ({
            where: () => ({
              returning: () => {
                updateCalls++;
                return Promise.resolve([{ id: 1, estado: 'cerrada_final' }]);
              },
            }),
          }),
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/close-final').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.idempotente).toBe(false);
    expect(auditMock.mock.calls[0][1].action).toBe('wo_close');
  });
});

describe('POST /:id/anular', () => {
  it('OT cerrada o anulada → 409', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/anular').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
  });

  it('OT abierta → 200 + audit anulada', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'anulada' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/maint/wo/1/anular').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].detail).toBe('anulada');
  });
});
