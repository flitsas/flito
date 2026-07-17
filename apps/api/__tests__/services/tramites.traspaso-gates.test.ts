// TRAM-TRASPASO-P0 — regresión gates server-side (409) + merge JSONB + dual-actor STT.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn(),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => kdb.reset());

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

const preflightGreen = [{
  id: 1,
  overallStatus: 'green',
  checks: [{ key: 'impuesto_vehicular', status: 'ok' }],
  createdAt: new Date('2026-06-10T12:00:00Z'),
}];

function traspasoRow(overrides: Record<string, unknown> = {}) {
  return {
    modalidad: 'traspaso',
    estado: 'radicado',
    paso: 2,
    vehiculo: {},
    comprador: {},
    ...overrides,
  };
}

/** SELECTs: gate dual-actor + gates paso + partes duplicadas (+ preflight opcional). */
function mockTraspasoPatch(row: Record<string, unknown>, opts?: { preflight?: unknown[] | null }) {
  kdb.when
    .selectOnce('tramites_digitales', [row])
    .selectOnce('tramites_digitales', [row])
    .selectOnce('tramites_digitales', [row]);
  if (opts?.preflight !== null) {
    kdb.when.selectOnce('tramite_preflight', opts?.preflight ?? preflightGreen);
  }
}

describe('PATCH traspaso — gates 409', () => {
  it('comercial valor 0 → 409 comercial_gate', async () => {
    mockTraspasoPatch(traspasoRow({
      vehiculo: { _vendedor: { documento: '111', nombre: 'V', email: 'v@x.co' } },
    }));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/21').set('Authorization', `Bearer ${token}`)
      .send({ vehiculo: { _comercial: { valorVenta: 0 } } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('comercial_gate');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('avance paso 4 sin RUNT vendedor → 409 paso_gate', async () => {
    mockTraspasoPatch(traspasoRow({
      paso: 3,
      vehiculo: {
        _vendedor: { documento: '111', nombre: 'V', email: 'v@x.co' },
        _runtComprador: { consultado: true, documento: '222' },
        _simitComprador: { consultado: true, documento: '222', total: 0 },
      },
      comprador: { documento: '222', nombre: 'C', email: 'c@x.co' },
    }));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/21').set('Authorization', `Bearer ${token}`)
      .send({ paso: 4 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('paso_gate');
    expect(r.body.error).toMatch(/RUNT del vendedor/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('avance paso 4 sin SIMIT comprador → 409 simit_gate', async () => {
    mockTraspasoPatch(traspasoRow({
      paso: 3,
      vehiculo: {
        _vendedor: { documento: '111', nombre: 'V', email: 'v@x.co' },
        _runtVendedor: { consultado: true, documento: '111' },
        _runtComprador: { consultado: true, documento: '222' },
      },
      comprador: { documento: '222', nombre: 'C', email: 'c@x.co' },
    }));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/21').set('Authorization', `Bearer ${token}`)
      .send({ paso: 4 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('simit_gate');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('PATCH parcial vehiculo mergea _vendedor existente (no last-write-wins)', async () => {
    const row = traspasoRow({
      vehiculo: {
        _vendedor: { documento: '111', nombre: 'Vend', email: 'v@x.co' },
        marca: 'Toyota',
      },
    });
    mockTraspasoPatch(row);
    let captured: Record<string, unknown> | null = null;
    updateMock.mockReturnValueOnce({
      set: (data: Record<string, unknown>) => {
        captured = data;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 21, estado: 'radicado', paso: 2 }]) }) };
      },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/21').set('Authorization', `Bearer ${token}`)
      .send({ vehiculo: { _comercial: { valorVenta: 45_000_000 } } });
    expect(r.status).toBe(200);
    const veh = captured!.vehiculo as Record<string, unknown>;
    expect((veh._vendedor as { documento?: string }).documento).toBe('111');
    expect(veh.marca).toBe('Toyota');
    expect((veh._comercial as { valorVenta?: number }).valorVenta).toBe(45_000_000);
  });
});

describe('PATCH traspaso — dual-actor gestor ↔ STT', () => {
  it('PATCH solo _stt en en_validacion mergea sin borrar _vendedor (causa raíz trámite 27)', async () => {
    const row = traspasoRow({
      estado: 'en_validacion',
      vehiculo: {
        marca: 'MAZDA',
        _vendedor: { documento: '1000445469', nombre: 'ANDRES', email: 'v@x.co' },
        _comercial: { valorVenta: 30_000_000 },
      },
    });
    // assertTraspasoPatch + bloque paso (captura traspasoVehiculoBase)
    kdb.when
      .selectOnce('tramites_digitales', [row])
      .selectOnce('tramites_digitales', [row]);
    let captured: Record<string, unknown> | null = null;
    updateMock.mockReturnValueOnce({
      set: (data: Record<string, unknown>) => {
        captured = data;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 27, estado: 'en_validacion' }]) }) };
      },
    });
    const token = await testToken({ sub: 9, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27').set('Authorization', `Bearer ${token}`)
      .send({ vehiculo: { _stt: { numeroRunt: 'R-99', pago: { metodo: 'Efectivo', valor: 120000 } } } });
    expect(r.status).toBe(200);
    const veh = captured!.vehiculo as Record<string, unknown>;
    expect((veh._vendedor as { documento?: string }).documento).toBe('1000445469');
    expect(veh.marca).toBe('MAZDA');
    expect((veh._stt as { numeroRunt?: string }).numeroRunt).toBe('R-99');
  });

  it('PATCH de gestión con expediente en flujo STT → 409 gestion_cerrada', async () => {
    kdb.when.selectOnce('tramites_digitales', [traspasoRow({ estado: 'en_validacion' })]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27').set('Authorization', `Bearer ${token}`)
      .send({ vehiculo: { marca: 'RENAULT' } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gestion_cerrada');
    expect(r.body.error).toMatch(/Subsanación/i);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/estado — gates biométricos STT', () => {
  function estadoRow(overrides: Record<string, unknown> = {}) {
    return {
      estado: 'radicado',
      modalidad: 'traspaso',
      radicado: 'TD-2026-00009',
      workflow: [],
      organismoCodigo: '05001',
      vehiculo: { _vendedor: { documento: '111' } },
      comprador: { documento: '222' },
      furGenerado: false,
      ...overrides,
    };
  }

  it('cerrar gestión (radicado → en_validacion) sin biométrica dual → 409 biometria_gate', async () => {
    kdb.when.selectOnce('tramites_digitales', [estadoRow()]);
    kdb.when.selectOnce('tramites_validaciones', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27/estado').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'en_validacion' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('biometria_gate');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('STT en_validacion → en_tramite sin biométrica dual → 409 biometria_gate (legacy sin excepción FUR)', async () => {
    kdb.when.selectOnce('tramites_digitales', [estadoRow({ estado: 'en_validacion', furGenerado: true })]);
    kdb.when.selectOnce('tramites_validaciones', [
      { id: 19, parte: 'vendedor', documento: '111', estado: 'aprobado' },
      { id: 20, parte: 'comprador', documento: '222', estado: 'enviado' },
    ]);
    const token = await testToken({ sub: 9, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27/estado').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'en_tramite' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('biometria_gate');
    expect(r.body.error).toMatch(/Subsanación/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('en_validacion → en_tramite con biométrica dual → 200 y asigna _stt.asignadoA', async () => {
    kdb.when.selectOnce('tramites_digitales', [estadoRow({ estado: 'en_validacion' })]);
    kdb.when.selectOnce('tramites_validaciones', [
      { id: 19, parte: 'vendedor', documento: '111', estado: 'aprobado' },
      { id: 20, parte: 'comprador', documento: '222', estado: 'aprobado' },
    ]);
    let captured: Record<string, unknown> | null = null;
    updateMock.mockReturnValueOnce({
      set: (data: Record<string, unknown>) => {
        captured = data;
        return { where: () => Promise.resolve(undefined) };
      },
    });
    const token = await testToken({ sub: 9, role: 'transito', username: 'op-stt', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27/estado').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'en_tramite' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('en_tramite');
    const veh = captured!.vehiculo as { _stt?: { asignadoA?: string } };
    expect(veh._stt?.asignadoA).toBe('op-stt');
  });

  it('subsanación → en_validacion exige biométrica (reenvío del gestor)', async () => {
    kdb.when.selectOnce('tramites_digitales', [estadoRow({ estado: 'subsanacion' })]);
    kdb.when.selectOnce('tramites_validaciones', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/27/estado').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'en_validacion', nota: 'reenvío' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('biometria_gate');
  });
});

describe('POST generar-fur — biometria_gate', () => {
  it('sin biométrica dual → 409 biometria_gate', async () => {
    // Gate dual-actor (generar_legal) + select del trámite en generarFur
    kdb.when.selectOnce('tramites_digitales', [{ modalidad: 'traspaso', estado: 'radicado' }]);
    kdb.when.selectOnce('tramites_digitales', [{
      id: 21,
      estado: 'radicado',
      furGenerado: false,
      vehiculo: { _vendedor: { documento: '111' } },
      comprador: { documento: '222' },
      placa: 'IWL38D',
      vin: 'VIN123',
    }]);
    kdb.when.selectOnce('tramites_validaciones', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/21/generar-fur').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('biometria_gate');
  });

  it('regeneración STT (furGenerado + estado operativo) no re-exige biométrica en el gate', async () => {
    const { validateTraspasoFurBiometria } = await import('../../src/modules/tramites/traspaso-gates.js');
    // Sin validaciones aprobadas en BD: el gate pasa SOLO por la excepción de regeneración.
    kdb.when.select('tramites_validaciones', []);
    const tramite = {
      vehiculo: { _vendedor: { documento: '111' } },
      comprador: { documento: '222' },
      estado: 'en_tramite',
      furGenerado: true,
    };
    const r = await validateTraspasoFurBiometria(21, tramite.vehiculo, tramite);
    expect(r.ok).toBe(true);
    // Mismo trámite sin furGenerado → gate exige biométrica.
    const r2 = await validateTraspasoFurBiometria(21, tramite.vehiculo, { ...tramite, furGenerado: false });
    expect(r2.ok).toBe(false);
  });
});
