import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { soatStatusAgg, vehiclesCount } from '../fixtures/soat/scenarios.js';
import { testToken } from '../helpers/auth.js';

// OPS-02b: mock KEYED por tabla. Drop-in — `selectMock` (etc.) siguen siendo vi.fn,
// así que el patrón posicional `mockReturnValueOnce(chain([...]))` se conserva en
// los tests de un solo SELECT; GET /stats (2 tablas) migra a `kdb.when.select`.
const kdb = createKeyedDb();
const selectMock = kdb.select;
const insertMock = kdb.insert;
const updateMock = kdb.update;
const transactionMock = kdb.transaction;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const refreshSoatMock = vi.fn();
const refreshResultToHttpMock = vi.fn();
vi.mock('../../src/modules/soat/refresh.service.js', () => ({
  refreshSoatFromRunt: refreshSoatMock,
  refreshResultToHttp: refreshResultToHttpMock,
}));

const consultarRuntMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarRuntMock,
}));

const sendExcelMock = vi.fn().mockImplementation((res: any) => {
  res.status(200).type('application/octet-stream').send(Buffer.from('xlsx'));
});
const parseExcelMock = vi.fn();
vi.mock('../../src/shared/utils/excel.js', () => ({
  parseExcel: parseExcelMock,
  sendExcel: sendExcelMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset(); // resetea select/insert/update/transaction/execute + registro keyed
  auditMock.mockClear();
  refreshSoatMock.mockReset();
  refreshResultToHttpMock.mockReset();
  parseExcelMock.mockReset();
  sendExcelMock.mockClear().mockImplementation((res: any) => {
    res.status(200).type('application/octet-stream').send(Buffer.from('xlsx'));
  });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/soat/soat.routes.js');
  app.use('/api/soat', router);
  return app;
}

describe('soat — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/soat');
    expect(r.status).toBe(401);
  });

  it('rol transito → 403 (requiere admin|proveedor)', async () => {
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).get('/api/soat').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('POST / — crear solicitudes (transaction loop)', () => {
  it('proveedor → 403 (solo admin crea)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [1] });
    expect(r.status).toBe(403);
  });

  it('vehicleIds vacío → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [] });
    expect(r.status).toBe(400);
  });

  it('vehículo no existe → continue (no falla, no inserta)', async () => {
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => chain([])), // vehículo no existe
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [999] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(0);
  });

  it('solicitud pendiente ya existe → continue (no duplica)', async () => {
    let selectCallCount = 0;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        select: vi.fn(() => {
          selectCallCount++;
          if (selectCallCount === 1) return chain([{ id: 5, stage: 'ingreso' }]); // vehículo existe
          return chain([{ id: 99 }]); // ya hay pendiente
        }),
        insert: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [5] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(0);
  });

  it('vehículo en ingreso → crea solicitud + auto-avanza stage a soat_pendiente', async () => {
    let updateCalled = false;
    let updateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      let selectCount = 0;
      const tx = {
        select: vi.fn(() => {
          selectCount++;
          if (selectCount === 1) return chain([{ id: 5, stage: 'ingreso' }]);
          return chain([]); // sin pendiente
        }),
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 100, vehicleId: 5, status: 'pendiente' }]) }),
        })),
        update: vi.fn(() => ({
          set: (v: any) => {
            updateCalled = true;
            updateValues = v;
            return { where: () => Promise.resolve(undefined) };
          },
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [5] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(1);
    expect(updateCalled).toBe(true);
    expect(updateValues.stage).toBe('soat_pendiente');
  });

  it('vehículo en stage avanzada (soat_comprado) → crea solicitud pero NO retrocede stage', async () => {
    let updateCalled = false;
    transactionMock.mockImplementationOnce(async (cb) => {
      let selectCount = 0;
      const tx = {
        select: vi.fn(() => {
          selectCount++;
          if (selectCount === 1) return chain([{ id: 5, stage: 'soat_comprado' }]);
          return chain([]);
        }),
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
        })),
        update: vi.fn(() => ({
          set: () => { updateCalled = true; return { where: () => Promise.resolve(undefined) }; },
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat').set('Authorization', `Bearer ${token}`)
      .send({ vehicleIds: [5] });
    expect(r.status).toBe(201);
    expect(updateCalled).toBe(false); // NO actualiza stage cuando está más avanzado
  });
});

describe('GET / — listado con filtro por rol', () => {
  it('admin sin filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/soat').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('proveedor → solo ve los asignados a él', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    const token = await testToken({ sub: 7, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/soat').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('status fuera del enum → ignorado', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/soat?status=hackeado').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('PATCH /:id/purchase — comprar (con optimistic locking)', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/abc/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(400);
  });

  it('solicitud no encontrada → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/999/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(404);
  });

  it('proveedor intenta comprar SOAT NO asignado → 403', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'pendiente', assignedTo: 99, vehicleId: 5 }]));
    const token = await testToken({ sub: 7, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no está asignado/i);
  });

  it('SOAT ya verificado → 409 con mensaje específico', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'verificado', assignedTo: null, vehicleId: 5 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/verificado por RUNT/);
  });

  it('SOAT ya comprado → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'comprado', assignedTo: null, vehicleId: 5 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya registrado como comprado/);
  });

  it('éxito desde pendiente → 200 + transaction propaga vehicle stage', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, status: 'pendiente', assignedTo: null, vehicleId: 5, tramiteId: null, notes: null,
    }]));
    let vehicleUpdateValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn().mockImplementationOnce(() => ({
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([{ id: 1, status: 'comprado' }]) }),
          }),
        })).mockImplementationOnce(() => ({
          set: (v: any) => { vehicleUpdateValues = v; return { where: () => Promise.resolve(undefined) }; },
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-001', insurer: 'SEGUROS S.A.', purchaseDate: '2026-05-06', expiryDate: '2027-05-05' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('comprado');
    expect(vehicleUpdateValues.stage).toBe('soat_comprado');
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'purchase', resource: 'soat_request' }),
    );
  });

  it('optimistic lock falla → 409 (otro usuario modificó)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'pendiente', assignedTo: null, vehicleId: 5, tramiteId: null }]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([]) }), // sin filas → conflicto
          }),
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/purchase').set('Authorization', `Bearer ${token}`)
      .send({ policyNumber: 'P-1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Otro usuario modificó/);
  });
});

describe('PATCH /:id/refresh-runt — delega a service', () => {
  it('id inválido → 400 sin llamar service', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/abc/refresh-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(refreshSoatMock).not.toHaveBeenCalled();
  });

  it('service ok → 200 + audit con detalles', async () => {
    refreshSoatMock.mockResolvedValueOnce({
      result: 'ok', policyNumber: 'P-001', insurer: 'SEGUROS', soatHolder: 'Juan',
    });
    refreshResultToHttpMock.mockReturnValueOnce({
      status: 200, body: { policyNumber: 'P-001' },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/refresh-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(refreshSoatMock).toHaveBeenCalledWith(1, expect.objectContaining({ triggeredBy: 'manual', triggeredByUser: 7 }));
    expect(auditMock).toHaveBeenCalled();
    expect(auditMock.mock.calls[0][1].detail).toContain('P-001');
  });

  it('service no-ok → status del service (no audit)', async () => {
    refreshSoatMock.mockResolvedValueOnce({ result: 'not_found' });
    refreshResultToHttpMock.mockReturnValueOnce({ status: 404, body: { error: 'no encontrado' } });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/refresh-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/verify — solo desde comprado, valida placeholder y vencido', () => {
  it('estado != comprado → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'pendiente', vehicleId: 5 }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/verify').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
  });

  it('policyNumber es placeholder ("Pendiente") → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, status: 'comprado', vehicleId: 5, tramiteId: null,
      policyNumber: 'Pendiente', expiryDate: null,
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/verify').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no tiene número de póliza real/);
  });

  it('póliza vencida → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, status: 'comprado', vehicleId: 5, tramiteId: null,
      policyNumber: 'P-001', expiryDate: '2020-01-01',
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/verify').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/vencido/i);
  });

  it('comprado + vigente + póliza real → 200 + propaga vehicle stage soat_verificado', async () => {
    const futureDate = new Date(Date.now() + 365 * 86400_000).toISOString().split('T')[0];
    selectMock.mockReturnValueOnce(chain([{
      id: 1, status: 'comprado', vehicleId: 5, tramiteId: null,
      policyNumber: 'P-001', expiryDate: futureDate,
    }]));
    let vehicleUpdate: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn().mockImplementationOnce(() => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, status: 'verificado' }]) }) }),
        })).mockImplementationOnce(() => ({
          set: (v: any) => { vehicleUpdate = v; return { where: () => Promise.resolve(undefined) }; },
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/verify').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(vehicleUpdate.stage).toBe('soat_verificado');
  });
});

describe('PATCH /:id/reject', () => {
  it('razón < 5 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/reject').set('Authorization', `Bearer ${token}`)
      .send({ reason: 'no' });
    expect(r.status).toBe(400);
  });

  it('SOAT ya verificado → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'verificado', notes: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/reject').set('Authorization', `Bearer ${token}`)
      .send({ reason: 'razón válida aquí' });
    expect(r.status).toBe(409);
  });

  it('rechazo OK → 200 + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, status: 'pendiente', notes: 'previo' }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => Promise.resolve(undefined) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/soat/1/reject').set('Authorization', `Bearer ${token}`)
      .send({ reason: 'placa inválida en póliza' });
    expect(r.status).toBe(200);
    expect(captured.status).toBe('rechazado');
    expect(captured.notes).toContain('placa inválida en póliza');
  });
});

describe('GET /stats [keyed]', () => {
  it('groupBy con defaults a 0 + count vehículos', async () => {
    // Keyed por tabla: el orden de los 2 SELECT (soat_requests + vehicles) no importa.
    kdb.when.select('soat_requests', soatStatusAgg());
    kdb.when.select('vehicles', vehiclesCount(50));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/soat/stats').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.comprado).toBe(10);
    expect(r.body.verificado).toBe(5);
    expect(r.body.pendiente).toBe(0);
    expect(r.body.totalVehicles).toBe(50);
  });
});

describe('POST /verificar-runt — batch comprado→verificado', () => {
  it('sin pendientes → verificados=0, total=0', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat/verificar-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.verificados).toBe(0);
  });

  it('SOAT con policyNumber=Pendiente → no se verifica (skip)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, vehicleId: 5, policyNumber: 'Pendiente', tramiteId: null },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat/verificar-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.verificados).toBe(0);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('SOAT con policy real → verificado en transaction', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, vehicleId: 5, policyNumber: 'P-001', tramiteId: null },
    ]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        })),
      };
      return cb(tx);
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/soat/verificar-runt').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.verificados).toBe(1);
    expect(transactionMock).toHaveBeenCalled();
  });
});
