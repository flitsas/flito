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
    transaction: transactionMock,
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const argonHashMock = vi.fn();
const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { hash: argonHashMock, verify: argonVerifyMock },
  hash: argonHashMock,
  verify: argonVerifyMock,
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
  argonHashMock.mockReset().mockResolvedValue('HASHED-PIN');
  argonVerifyMock.mockReset().mockResolvedValue(true);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/checklists.routes.js');
  app.use('/api/checklists', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('GET /qr/:token — público (sin auth)', () => {
  it('token vacío → 401 (no matchea ruta /:token, cae en authMiddleware del resto)', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/qr/');
    // Express no matchea /qr/:token sin token. Pasa al siguiente router.use(auth) → 401.
    expect([400, 401, 404]).toContain(r.status);
  });

  it('token > 64 chars → 400', async () => {
    const app = await buildApp();
    const r = await request(app).get(`/api/checklists/qr/${'a'.repeat(65)}`);
    expect(r.status).toBe(400);
  });

  it('token no existe → 404 valido=false', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/qr/notoken');
    expect(r.status).toBe(404);
    expect(r.body.valido).toBe(false);
  });

  it('token válido + checklist no anulado → valido=true con datos', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, decision: 'apto', fechaHora: new Date('2026-05-06'),
      plate: 'ABC123', conductorName: 'Juan', anuladoAt: null,
    }]));
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/qr/x');
    expect(r.status).toBe(200);
    expect(r.body.valido).toBe(true);
    expect(r.body.placa).toBe('ABC123');
    expect(r.body.conductor).toBe('Juan');
  });

  it('checklist anulado → valido=false (preserva datos)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, decision: 'apto', fechaHora: new Date(),
      plate: 'ABC123', conductorName: 'Juan', anuladoAt: new Date(),
    }]));
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/qr/x');
    expect(r.status).toBe(200);
    expect(r.body.valido).toBe(false);
  });
});

describe('checklists — auth en endpoints privados', () => {
  it('GET /templates sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/templates');
    expect(r.status).toBe(401);
  });

  it('proveedor sin PESV → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/templates').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /templates', () => {
  it('admin → lista vigentes', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, titulo: 'Pre-operacional', vigente: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/templates').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('GET /templates/:id no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/templates/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('GET /templates/:id existe → devuelve template + items', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, titulo: 'X' }]));
    selectMock.mockReturnValueOnce(chain([{ id: 10, label: 'Frenos', orden: 1 }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/templates/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
  });
});

describe('GET / — listado checklists', () => {
  it('admin sin filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, plate: 'ABC', decision: 'apto' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('todos los filtros (vehicleId/conductorId/decision/desde/hasta)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists?vehicleId=5&conductorId=7&decision=apto&desde=2026-01-01&hasta=2026-12-31')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con responses', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, decision: 'apto' }]));
    selectMock.mockReturnValueOnce(chain([{ id: 10, itemId: 1, label: 'Frenos', valorBool: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/checklists/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.responses).toHaveLength(1);
  });
});

describe('POST /me/set-pin', () => {
  it('PIN no es 4-6 dígitos → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/me/set-pin').set('Authorization', `Bearer ${token}`)
      .send({ pin: 'abc' });
    expect(r.status).toBe(400);
  });

  it('PIN válido (6 dígitos) → 200 + argon2.hash + audit', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/me/set-pin').set('Authorization', `Bearer ${token}`)
      .send({ pin: '123456' });
    expect(r.status).toBe(200);
    expect(argonHashMock).toHaveBeenCalledWith('123456');
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'update', resource: 'driver_profile', detail: 'set_checklist_pin' }),
    );
  });
});

describe('POST / — crear checklist (PIN + decisión + transaction)', () => {
  const VALID_BODY = {
    vehicleId: 5, templateId: 1,
    pin: '1234',
    responses: [
      { itemId: 10, valorBool: true },
      { itemId: 11, valorEstado: 'bueno' },
    ],
  };

  it('responses vacío → 400 (zod min 1)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, responses: [] });
    expect(r.status).toBe(400);
  });

  it('response sin valor → 400 (refine)', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, responses: [{ itemId: 10 }] });
    expect(r.status).toBe(400);
  });

  it('PIN no es 4-6 dígitos → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, pin: 'abc' });
    expect(r.status).toBe(400);
  });

  it('conductor no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin profile
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(404);
  });

  it('conductor suspendido por alcohol → 403', async () => {
    selectMock.mockReturnValueOnce(chain([{
      checklistPinHash: 'h', suspendidoPorAlcohol: true,
    }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/suspendido/);
  });

  it('conductor sin PIN configurado → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{
      checklistPinHash: null, suspendidoPorAlcohol: false,
    }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/PIN/);
  });

  it('PIN incorrecto (argon2.verify=false) → 401', async () => {
    selectMock.mockReturnValueOnce(chain([{
      checklistPinHash: 'h', suspendidoPorAlcohol: false,
    }]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/PIN incorrecto/);
  });

  it('plantilla no vigente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: false }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(404);
  });

  it('items obligatorios faltantes → 400 con labels', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'Frenos', criterio: 'booleano', critico: true },
      { id: 99, obligatorio: true, label: 'Luces', criterio: 'booleano', critico: false },
    ]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, responses: [{ itemId: 10, valorBool: true }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Luces');
  });

  it('decisión APTO: todos buenos → apto', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'X', criterio: 'booleano', critico: false },
      { id: 11, obligatorio: false, label: 'Y', criterio: 'tres_estados', critico: false },
    ]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 100, decision: 'apto' }]) }),
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(r.body.decision).toBe('apto');
  });

  it('decisión NO_APTO: item crítico falla → no_apto (early break)', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'Frenos', criterio: 'booleano', critico: true },
    ]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 100, decision: 'no_apto' }]) }),
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, responses: [{ itemId: 10, valorBool: false }] });
    expect(r.body.decision).toBe('no_apto');
  });

  it('decisión CONDICIONAL: no-crítico malo + ninguno crítico → condicional', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'X', criterio: 'tres_estados', critico: false },
    ]));
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 100 }]) }),
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, responses: [{ itemId: 10, valorEstado: 'malo' }] });
    expect(r.body.decision).toBe('condicional');
  });

  it('medicionActual > 0 → inserta vehicleMeasurements', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'X', criterio: 'booleano', critico: false },
    ]));
    // Capturar TODOS los insert.values para encontrar el measurement (tiene field `odometro`)
    const insertedValues: any[] = [];
    transactionMock.mockImplementationOnce(async (cb) => {
      let isFirst = true;
      const tx = {
        insert: vi.fn(() => ({
          values: (v: any) => {
            insertedValues.push(v);
            const wasFirst = isFirst;
            isFirst = false;
            return wasFirst
              ? { returning: () => Promise.resolve([{ id: 100 }]) }
              : Promise.resolve(undefined);
          },
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, medicionActual: 50_000 });
    const measurement = insertedValues.find((v) => 'odometro' in v);
    expect(measurement).toBeDefined();
    expect(measurement.odometro).toBe(50_000);
    expect(measurement.fuente).toBe('app');
    expect(measurement.nota).toContain('Checklist preoperacional #100');
  });

  it('qrToken generado con base64url 24 bytes', async () => {
    selectMock.mockReturnValueOnce(chain([{ checklistPinHash: 'h', suspendidoPorAlcohol: false }]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, version: 1, vigente: true }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, obligatorio: true, label: 'X', criterio: 'booleano', critico: false },
    ]));
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb) => {
      const tx = {
        insert: vi.fn(() => ({
          values: (v: any) => {
            if (!insertedValues) insertedValues = v;
            return { returning: () => Promise.resolve([{ id: 100 }]) };
          },
        })),
      };
      return cb(tx);
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/checklists').set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(insertedValues.qrToken).toMatch(/^[A-Za-z0-9_-]{32}$/); // base64url de 24 bytes = 32 chars
    expect(insertedValues.firmaPinVerificado).toBe(true);
  });
});

describe('POST /:id/anular', () => {
  it('proveedor → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/1/anular').set('Authorization', `Bearer ${token}`)
      .send({ motivo: 'razón válida' });
    expect(r.status).toBe(403);
  });

  it('motivo < 5 chars → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/1/anular').set('Authorization', `Bearer ${token}`)
      .send({ motivo: 'no' });
    expect(r.status).toBe(400);
  });

  it('checklist no existe o ya anulado → 409 (atómico WHERE anuladoAt IS NULL)', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/999/anular').set('Authorization', `Bearer ${token}`)
      .send({ motivo: 'razón válida aquí' });
    expect(r.status).toBe(409);
  });

  it('éxito → 200 + audit detail=anulado + captura anuladoPor del JWT', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, anuladoAt: v.anuladoAt }]) }) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/checklists/1/anular').set('Authorization', `Bearer ${token}`)
      .send({ motivo: 'falsa lectura del odómetro' });
    expect(r.status).toBe(200);
    expect(captured.anuladoAt).toBeInstanceOf(Date);
    expect(captured.anuladoPor).toBe(7);
    expect(captured.anuladoMotivo).toBe('falsa lectura del odómetro');
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'checklist', detail: 'anulado' }),
    );
  });
});
