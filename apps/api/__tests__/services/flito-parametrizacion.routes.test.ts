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

const auth = async (role: 'admin' | 'auditor' | 'gestor_impuestos' | 'proveedor') =>
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
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('admin'));
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
      .set('Authorization', await auth('admin')).send({ modalidad: 'requiere_gestion', motivo: 'x' });
    expect(r.status).toBe(400);
  });

  // Las validaciones de las reglas de enrutamiento se retiran con sus endpoints (HU #10979):
  // el proveedor se elige al enviar el SOAT al gestor, así que ya no hay ámbitos que validar ni
  // una regla global única que proteger.

  it('cambiar a la modalidad ya vigente → 400', async () => {
    // 1) organismo existe, 2) modalidadVigente → requiere_gestion
    selectMock
      .mockReturnValueOnce(chain([{ codigo: '11001', alias: 'Bogotá', activo: true }]))
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const app = await buildApp();
    const r = await request(app).post('/api/flito/parametrizacion/organismos/11001/modalidad')
      .set('Authorization', await auth('admin')).send({ modalidad: 'requiere_gestion', motivo: 'ya está clasificado así' });
    expect(r.status).toBe(400);
  });
});

// ───────── HU #11913 (Feature #11912): «SOAT sin trámite» es un flag INDEPENDIENTE ─────────
//
// El AC3 no pide que el flag exista: pide que **no se contagie**. Un `set` mal encadenado —el
// clásico `if (soatAutogestionable !== undefined) { …; set.soatSinTramite = false; }`— dejaría los
// dos flags atados sin que ningún test que solo compruebe «persiste» lo notara. De ahí que estas
// pruebas miren el objeto que llega al UPDATE y no la respuesta.

/** Fila de `clients` tal como sale del `returning()` del PATCH. */
const compania = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'Acme', document: '900', soatAutogestionable: false, soatSinTramite: false,
  impuestosAutogestionable: false, logisticaAutogestionable: false, logisticaPermiteParcial: false,
  flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0', ...over,
});

/** Captura el objeto del `.set(...)` del UPDATE y devuelve la fila que se le pida. */
function capturarUpdate(devuelve: Record<string, unknown>) {
  const capturado: { set?: Record<string, unknown> } = {};
  updateMock.mockReturnValueOnce({
    set: (v: Record<string, unknown>) => {
      capturado.set = v;
      return { where: () => ({ returning: () => Promise.resolve([devuelve]) }) };
    },
  });
  return capturado;
}

describe('compañías — flag «SOAT sin trámite» (AC3 de la HU #11913)', () => {
  it('GET /companias lo devuelve, y separado de la autogestión', async () => {
    selectMock.mockReturnValueOnce(chain([compania({ soatAutogestionable: true, soatSinTramite: false })]));
    const app = await buildApp();
    const r = await request(app).get('/api/flito/parametrizacion/companias').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    // Una compañía puede autogestionar SU SOAT y NO tener abierto el canal sin trámite: son dos
    // preguntas, y el DTO tiene que poder decir cosas distintas de cada una.
    expect(r.body[0].soatAutogestionable).toBe(true);
    expect(r.body[0].soatSinTramite).toBe(false);
  });

  it('PATCH del flag → persiste y NO toca la autogestión', async () => {
    const cap = capturarUpdate(compania({ soatSinTramite: true }));
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatSinTramite: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatSinTramite: true });
    expect(cap.set).not.toHaveProperty('soatAutogestionable');
    expect(r.body.soatSinTramite).toBe(true);
  });

  it('PATCH de la autogestión → NO arrastra el flag nuevo (el contagio que el AC3 prohíbe)', async () => {
    const cap = capturarUpdate(compania({ soatAutogestionable: true, soatSinTramite: true }));
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatAutogestionable: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatAutogestionable: true });
    expect(cap.set).not.toHaveProperty('soatSinTramite');
    // Y la compañía que ya tenía el canal abierto lo conserva tras encender la autogestión.
    expect(r.body.soatSinTramite).toBe(true);
  });

  it('los dos a la vez → los dos se escriben, que es una combinación válida', async () => {
    const cap = capturarUpdate(compania({ soatAutogestionable: true, soatSinTramite: true }));
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin'))
      .send({ soatAutogestionable: true, soatSinTramite: true });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatAutogestionable: true, soatSinTramite: true });
  });

  it('apagar el flag → false llega al UPDATE (y no se pierde por ser «falsy»)', async () => {
    const cap = capturarUpdate(compania({ soatSinTramite: false }));
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('admin')).send({ soatSinTramite: false });
    expect(r.status).toBe(200);
    expect(cap.set).toEqual({ soatSinTramite: false });
  });

  it('el flag es de ESCRITURA de Operaciones: auditor → 403', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/flito/parametrizacion/companias/1')
      .set('Authorization', await auth('auditor')).send({ soatSinTramite: true });
    expect(r.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
