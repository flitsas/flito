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
  const { default: router } = await import('../../src/modules/drivers/indicators.routes.js');
  app.use('/api/pesv-ind', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

// 5 queries en orden: km, incidentes, cumplDoc, capacitación, top
function mockSequence(rows: any[][]) {
  for (const r of rows) {
    executeMock.mockResolvedValueOnce({ rows: r });
  }
}

describe('PESV indicators — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/pesv-ind');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/pesv-ind').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('respuesta vacía → 200 con tasas null', async () => {
    mockSequence([
      [{ km_total: 0 }],
      [{ accidentes: 0, casi_accidentes: 0, comparendos: 0, lesionados: null, fatales: 0, dias_perdidos_total: null, costo_total: 0 }],
      [{ total: 0, con_vencidos: 0, con_por_vencer: 0 }],
      [{ total: 0, capacitados: 0 }],
      [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/pesv-ind').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.tasa_accidentalidad).toBeNull();
    expect(r.body.cumplimiento_documental_pct).toBeNull();
    expect(r.body.km_recorridos).toBe(0);
  });

  it('con datos → calcula tasas (accidentes * 1M / km)', async () => {
    mockSequence([
      [{ km_total: 1_000_000 }], // 1M km
      [{ accidentes: 5, casi_accidentes: 2, comparendos: 3, lesionados: 4, fatales: 1, dias_perdidos_total: 30, costo_total: 5000000 }],
      [{ total: 10, con_vencidos: 2, con_por_vencer: 1 }],
      [{ total: 10, capacitados: 8 }],
      [{ user_id: 1, name: 'Juan', incidentes_count: 3, fatales: 1, victimas: 2 }],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/pesv-ind?desde=2026-01-01&hasta=2026-04-30')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.accidentes).toBe(5);
    expect(r.body.fatales).toBe(1);
    // tasa accidentalidad = 5 * 1_000_000 / 1_000_000 = 5
    expect(r.body.tasa_accidentalidad).toBe(5);
    expect(r.body.tasa_fatales).toBe(1);
    // severidad = 30 / 5 = 6
    expect(r.body.severidad).toBe(6);
    // cumplimiento = (10-2)/10*100 = 80
    expect(r.body.cumplimiento_documental_pct).toBe(80);
    // capacitación = 8/10*100 = 80
    expect(r.body.capacitacion_pct).toBe(80);
    expect(r.body.top_conductores).toHaveLength(1);
  });

  it('fechas inválidas → fallback', async () => {
    mockSequence([
      [{ km_total: 0 }],
      [{ accidentes: 0, casi_accidentes: 0, comparendos: 0, lesionados: 0, fatales: 0, dias_perdidos_total: 0, costo_total: 0 }],
      [{ total: 0, con_vencidos: 0, con_por_vencer: 0 }],
      [{ total: 0, capacitados: 0 }],
      [],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/pesv-ind?desde=invalid&hasta=invalid').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
