import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  executeMock.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/operational-indicators.routes.js');
  app.use('/api/op-ind', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

// 6 queries en orden: conductores, inspecciones, alcohol, simulacros, topConductores, topVehiculos
function mockSequence(rows: any[][]) {
  for (const r of rows) {
    executeMock.mockResolvedValueOnce({ rows: r });
  }
}

describe('operational indicators — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('vacío → 200 con cumple=false simulacros', async () => {
    mockSequence([
      [{ count: 0 }],
      [{ count: 0, no_aptos: 0 }],
      [{ total: 0, positivos: 0 }],
      [{ count: 0 }],
      [],
      [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.simulacros.cumple).toBe(false);
    expect(r.body.alcoholimetria.positivos_pct).toBeNull();
    expect(r.body.inspecciones.pct).toBeNull();
  });

  it('con datos → calcula porcentajes', async () => {
    mockSequence([
      [{ count: 5 }], // 5 conductores activos
      [{ count: 80, no_aptos: 3 }], // 80 inspecciones
      [{ total: 50, positivos: 1 }], // 1/50=2%
      [{ count: 2 }], // 2 simulacros
      [{ user_id: 1, name: 'Juan', no_aptos: 3 }],
      [{ vehicle_id: 5, plate: 'ABC123', no_aptos: 2 }],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind?desde=2026-04-01&hasta=2026-04-30')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.conductores_activos).toBe(5);
    expect(r.body.inspecciones.realizadas).toBe(80);
    expect(r.body.alcoholimetria.positivos_pct).toBe(2);
    expect(r.body.simulacros.cumple).toBe(true);
    expect(r.body.top_conductores_no_aptos).toHaveLength(1);
    expect(r.body.top_vehiculos_no_aptos).toHaveLength(1);
  });

  it('alcohol positivos > umbral → alerta_umbral=true', async () => {
    mockSequence([
      [{ count: 5 }],
      [{ count: 0, no_aptos: 0 }],
      [{ total: 100, positivos: 5 }], // 5%
      [{ count: 0 }],
      [],
      [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind?umbralAlcohol=2').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.alcoholimetria.alerta_umbral).toBe(true);
  });

  it('fechas inválidas → fallback', async () => {
    mockSequence([
      [{ count: 0 }], [{ count: 0, no_aptos: 0 }], [{ total: 0, positivos: 0 }], [{ count: 0 }], [], [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/op-ind?desde=mal&hasta=mal').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('días laborales calcula correctamente (semana corre lunes)', async () => {
    mockSequence([
      [{ count: 5 }],
      [{ count: 0, no_aptos: 0 }],
      [{ total: 0, positivos: 0 }],
      [{ count: 0 }],
      [],
      [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    // Semana de lunes 2026-04-27 a viernes 2026-05-01 = 5 días laborales
    const r = await request(app).get('/api/op-ind?desde=2026-04-27&hasta=2026-05-01')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.inspecciones.dias_laborales).toBe(5);
    // 5 conductores * 5 días = 25 esperadas
    expect(r.body.inspecciones.esperadas).toBe(25);
  });
});
