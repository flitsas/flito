import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  transactionMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}

const auth = async (role: 'operaciones' | 'auditor' | 'gestor_impuestos' | 'proveedor') =>
  `Bearer ${await testToken({ sub: 1, username: 'u', role })}`;

// ───────────────────────────── RBAC (D-2: gestores no entran) ────────────────

describe('parametrización — RBAC', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/flito/parametrizacion/companias')).status).toBe(401);
  });

  it('gestor_impuestos → lectura 403 (no entra a parametrización)', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(403);
  });

  it('proveedor (gestor SOAT) → lectura 403', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/proveedores-soat').set('Authorization', await auth('proveedor'));
    expect(r.status).toBe(403);
  });

  it('auditor → lectura 200 (solo lectura)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
  });

  it('auditor → escritura 403 (mutaciones solo operaciones)', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('auditor')).send({ soatAutogestionable: true });
    expect(r.status).toBe(403);
  });

  it('operaciones → lectura 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Acme', document: '900', soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false, flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0' }]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('operaciones'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].nit).toBe('900');
  });
});

// ───────────────────────────── Validaciones caras ────────────────────────────

describe('parametrización — validaciones', () => {
  it('cambiar modalidad con motivo < 5 → 400 (motivo obligatorio y explicativo)', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/organismos/11001/modalidad')
      .set('Authorization', await auth('operaciones')).send({ modalidad: 'requiere_gestion', motivo: 'x' });
    expect(r.status).toBe(400);
  });

  it('regla por compañía sin companiaId → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/reglas-proveedor-soat')
      .set('Authorization', await auth('operaciones'))
      .send({ ambito: 'compania', proveedorSoatId: '00000000-0000-0000-0000-000000000001' });
    expect(r.status).toBe(400);
  });

  it('segunda regla global → 409 (solo puede haber una)', async () => {
    // 1) lookup proveedor existe, 2) lookup global existente
    selectMock
      .mockReturnValueOnce(chain([{ id: '00000000-0000-0000-0000-000000000001' }]))
      .mockReturnValueOnce(chain([{ id: 'regla-global-existente' }]));
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/reglas-proveedor-soat')
      .set('Authorization', await auth('operaciones'))
      .send({ ambito: 'global', proveedorSoatId: '00000000-0000-0000-0000-000000000001' });
    expect(r.status).toBe(409);
  });

  it('cambiar a la modalidad ya vigente → 400', async () => {
    // 1) organismo existe, 2) modalidadVigente → requiere_gestion
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '11001', alias: 'Bogotá', activo: true }]))
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/organismos/11001/modalidad')
      .set('Authorization', await auth('operaciones')).send({ modalidad: 'requiere_gestion', motivo: 'ya está clasificado así' });
    expect(r.status).toBe(400);
  });
});
