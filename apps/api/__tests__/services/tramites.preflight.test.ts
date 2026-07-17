// TRAM-INNOV A1 — pre-vuelo SOAT · SIMIT · RUNT.
//
// Bloque 1: derivePreflightChecks (PURO, sin red/BD).
// Bloque 2: rutas POST /preflight y GET /:id/preflight (runt.service + db mockeados).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

// Mocks de IO. `vi.hoisted` los inicializa antes que los import estáticos (el
// módulo preflight importa db/client y runt.service al cargar).
const { selectMock, insertMock, consultarVehiculoRunt, consultarPersonaRunt, consultarSimit } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), consultarVehiculoRunt: vi.fn(), consultarPersonaRunt: vi.fn(), consultarSimit: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/modules/runt/runt.service.js', () => ({ consultarVehiculoRunt, consultarPersonaRunt }));
vi.mock('../../src/modules/integraciones/integraciones.service.js', () => ({ consultarSimit }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { derivePreflightChecks, deriveLaftChecks } from '../../src/modules/tramites/preflight.js';

const futuro = '31/12/2099';
const pasado = '01/01/2020';

describe('A1 · derivePreflightChecks (puro)', () => {
  it('vehículo no consultado → SOAT/RTM unknown; sin fail → no red', () => {
    const r = derivePreflightChecks({ vehiculoResp: null });
    expect(r.checks.find((c) => c.key === 'soat')!.status).toBe('unknown');
    expect(r.overall).not.toBe('red');
  });

  it('SOAT vigente por fecha → ok; sin warns/fails → green', () => {
    const r = derivePreflightChecks({
      vehiculoResp: { ok: true, data: { soat: { fechaVencimSoat: futuro, estadoSoat: 'VIGENTE' } } },
    });
    expect(r.checks.find((c) => c.key === 'soat')!.status).toBe('ok');
    expect(r.overall).toBe('green');
  });

  it('SOAT vencido → fail → overall red', () => {
    const r = derivePreflightChecks({
      vehiculoResp: { ok: true, data: { soat: { fechaVencimSoat: pasado, estadoSoat: 'NO VIGENTE' } } },
    });
    expect(r.checks.find((c) => c.key === 'soat')!.status).toBe('fail');
    expect(r.overall).toBe('red');
  });

  it('comprador con comparendos → warn → overall yellow (sin fails)', () => {
    const r = derivePreflightChecks({
      vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } },
      compradorResp: { ok: true, persona: { estadoPersona: 'ACTIVO' }, multas: { tieneMultas: 'SI', valorTotal: 250000 } },
      compradorDoc: '123',
    });
    expect(r.checks.find((c) => c.key === 'comparendos_comprador')!.status).toBe('warn');
    expect(r.overall).toBe('yellow');
  });

  it('comprador sin comparendos + SOAT ok + inscrito → green', () => {
    const r = derivePreflightChecks({
      vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } },
      compradorResp: { ok: true, persona: { estadoPersona: 'ACTIVO' }, multas: { tieneMultas: 'NO' } },
      compradorDoc: '123',
    });
    expect(r.checks.find((c) => c.key === 'comparendos_comprador')!.status).toBe('ok');
    expect(r.checks.find((c) => c.key === 'inscripcion_runt')!.status).toBe('ok');
    expect(r.overall).toBe('green');
  });

  it('documento no provisto → comparendos/inscripción unknown', () => {
    const r = derivePreflightChecks({ vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } } });
    expect(r.checks.find((c) => c.key === 'comparendos_comprador')!.status).toBe('unknown');
    expect(r.checks.find((c) => c.key === 'inscripcion_runt')!.status).toBe('unknown');
  });

  it('impuesto vehicular siempre unknown (sin integración) pero no impide green', () => {
    const r = derivePreflightChecks({ vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } } });
    expect(r.checks.find((c) => c.key === 'impuesto_vehicular')!.status).toBe('unknown');
    expect(r.overall).toBe('green');
  });

  // TRAM-F3: SIMIT real tiene precedencia + check de placa.
  it('SIMIT comprador con comparendos → comparendos_comprador warn (source SIMIT)', () => {
    const r = derivePreflightChecks({
      compradorDoc: '111', simitComprador: { ok: true, total: 2, totalMonto: 800000 },
    });
    const c = r.checks.find((x) => x.key === 'comparendos_comprador')!;
    expect(c.status).toBe('warn');
    expect(c.source).toBe('SIMIT');
    expect(r.overall).toBe('yellow');
  });

  it('SIMIT comprador sin comparendos → ok', () => {
    const r = derivePreflightChecks({ compradorDoc: '111', simitComprador: { ok: true, total: 0, totalMonto: 0 } });
    expect(r.checks.find((x) => x.key === 'comparendos_comprador')!.status).toBe('ok');
  });

  it('SIMIT placa con comparendos → comparendos_placa warn', () => {
    const r = derivePreflightChecks({ placa: 'ABC123', simitPlaca: { ok: true, total: 1, totalMonto: 300000 } });
    const c = r.checks.find((x) => x.key === 'comparendos_placa')!;
    expect(c.status).toBe('warn');
  });

  it('sin placa → comparendos_placa unknown (no altera overall)', () => {
    const r = derivePreflightChecks({ vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } } });
    expect(r.checks.find((x) => x.key === 'comparendos_placa')!.status).toBe('unknown');
    expect(r.overall).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset();
  consultarVehiculoRunt.mockReset(); consultarPersonaRunt.mockReset();
  consultarSimit.mockReset();
  // SIMIT no disponible → derivePreflightChecks usa multas RUNT (pre-vuelo real con skipCeaFallback).
  consultarSimit.mockResolvedValue({ ok: false, total: 0, totalMonto: 0, comparendos: [] });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('POST /api/tramites/preflight', () => {
  it('sin VIN ni placa → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/preflight').set('Authorization', `Bearer ${token}`).send({ compradorDoc: '123' });
    expect(r.status).toBe(400);
  });

  it('VIN con SOAT vigente → 200 overall green + persiste snapshot', async () => {
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } });
    let inserted: any = null;
    insertMock.mockReturnValueOnce({ values: (v: any) => { inserted = v; return { returning: () => Promise.resolve([{ id: 42, createdAt: new Date() }]) }; } });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/preflight').set('Authorization', `Bearer ${token}`).send({ vin: 'MAZ123TEST456789' });
    expect(r.status).toBe(200);
    expect(r.body.overall).toBe('green');
    expect(r.body.id).toBe(42);
    expect(Array.isArray(r.body.checks)).toBe(true);
    expect(inserted.overallStatus).toBe('green');
    expect(inserted.createdBy).toBe(7);
    expect(consultarVehiculoRunt).toHaveBeenCalled();
  });

  it('RUNT caído (consulta rechaza) → degradación: 200 con checks unknown, no 500', async () => {
    consultarVehiculoRunt.mockRejectedValue(new Error('circuit open'));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 1, createdAt: new Date() }]) }) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/preflight').set('Authorization', `Bearer ${token}`).send({ vin: 'ABC123' });
    expect(r.status).toBe(200);
    expect(r.body.checks.find((c: any) => c.key === 'soat').status).toBe('unknown');
  });

  it('comprador con comparendos SIMIT → overall yellow', async () => {
    consultarVehiculoRunt.mockResolvedValue({ ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } });
    consultarSimit.mockResolvedValue({ ok: true, total: 2, totalMonto: 100000, comparendos: [] });
    consultarPersonaRunt.mockResolvedValue({ ok: true, persona: { estadoPersona: 'ACTIVO' }, multas: { tieneMultas: 'NO' } });
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 5, createdAt: new Date() }]) }) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/preflight').set('Authorization', `Bearer ${token}`).send({ vin: 'ABC123', compradorDoc: '1020304050' });
    expect(r.status).toBe(200);
    expect(r.body.overall).toBe('yellow');
    expect(consultarPersonaRunt).toHaveBeenCalled();
  });
});

describe('PRE-02 · enriquecimiento de checks con action', () => {
  it('SOAT fail → check.action step soat_subir; checks ok → action null', () => {
    const r = derivePreflightChecks({ vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'NO VIGENTE', fechaVencimSoat: pasado } } } });
    const soat = r.checks.find((c) => c.key === 'soat')!;
    expect(soat.status).toBe('fail');
    expect(soat.action).toMatchObject({ kind: 'step', ctaId: 'soat_subir', step: 2 });
  });

  it('SOAT ok → action null', () => {
    const r = derivePreflightChecks({ vehiculoResp: { ok: true, data: { soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: futuro } } } });
    expect(r.checks.find((c) => c.key === 'soat')!.action).toBeNull();
  });
});

describe('PRE-02 · deriveLaftChecks (sintéticos)', () => {
  it('screening con coincidencia → check warn/fail + action laft_revisar', () => {
    const checks = deriveLaftChecks({ status: 'red', matches: 2, topSignal: 'OFAC' }, null);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ key: 'laft_comprador', status: 'fail', source: 'LAFT' });
    expect(checks[0].action).toMatchObject({ kind: 'hint', ctaId: 'laft_revisar' });
    expect(checks[0].message).toMatch(/coincidencia/i);
  });

  it('screening limpio → check ok sin action; sin screening → sin check', () => {
    const checks = deriveLaftChecks({ status: 'green', matches: 0, topSignal: null }, undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('ok');
    expect(checks[0].action).toBeNull();
    expect(deriveLaftChecks(null, null)).toEqual([]);
  });
});

describe('POST /api/tramites/:id/preflight/cta (telemetría)', () => {
  it('ctaId válido → 200 ok', async () => {
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/9/preflight/cta').set('Authorization', `Bearer ${token}`)
      .send({ checkKey: 'soat', ctaId: 'soat_subir', overall: 'red' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('ctaId no canónico → 400', async () => {
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/9/preflight/cta').set('Authorization', `Bearer ${token}`)
      .send({ checkKey: 'soat', ctaId: 'hackeado' });
    expect(r.status).toBe(400);
  });

  it('body inválido → 400', async () => {
    const token = await testToken({ sub: 3, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/9/preflight/cta').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
  });
});

describe('GET /api/tramites/:id/preflight', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/0/preflight').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('sin snapshot → 200 con preflight null', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/9/preflight').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.preflight).toBeNull();
  });

  it('con snapshot → 200 con overall + checks', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 3, tramiteId: 9, vin: 'ABC', placa: null, overallStatus: 'yellow', checks: [{ key: 'soat', status: 'ok' }], createdAt: new Date() }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/9/preflight').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.preflight.overall).toBe('yellow');
    expect(r.body.preflight.checks[0].key).toBe('soat');
  });
});
