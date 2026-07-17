import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';
import { createKeyedDb } from '../helpers/keyed-db.js';

// OPS-02b r3: mock KEYED por tabla. Indicators usa db.execute (SQL crudo);
// se mockea secuencialmente vía kdb.execute.
const kdb = createKeyedDb();
const { execute: executeMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
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
  kdb.reset();
  executeMock.mockReset();
  // db.execute para health check (executeMock should respond to first call too)
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/maintenance/indicators.routes.js');
  app.use('/api/maint/indicators', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

// 6 queries SQL en orden: mtbf, mttr, costoSistema, costoTotal, km, dispon, reincidentes
function mockSequence(rows: any[][]) {
  for (const r of rows) {
    executeMock.mockResolvedValueOnce({ rows: r });
  }
}

describe('indicators — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('respuesta sin OTs → 200 con valores null/0', async () => {
    mockSequence([
      [], // mtbf
      [{ mttr_horas: null, ots: 0 }], // mttr
      [], // costoSistema
      [{ costo_total: 0, ots: 0 }], // costoTotal
      [{ km_recorridos: null }], // km
      [{ horas_taller: 0, horas_periodo: 720 }], // dispon
      [], // reinc
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.mtbf_dias_promedio).toBeNull();
    expect(r.body.costo_total).toBe(0);
    expect(r.body.disponibilidad_pct).toBe(100);
    expect(r.body.km_recorridos).toBe(0);
  });

  it('con datos → calcula MTBF, costo/km, disponibilidad', async () => {
    mockSequence([
      [{ vehicle_id: 1, plate: 'ABC123', mtbf_dias: 30.5, ots: 5 }, { vehicle_id: 2, plate: 'DEF456', mtbf_dias: 45.0, ots: 3 }],
      [{ mttr_horas: 8.5, ots: 8 }],
      [{ system_id: 1, nombre: 'Motor', monto: 500000 }],
      [{ costo_total: 1500000, ots: 8 }],
      [{ km_recorridos: 30000 }],
      [{ horas_taller: 72, horas_periodo: 720 }],
      [{ vehicle_id: 1, plate: 'ABC123', falla: 'fuga aceite', ocurrencias: 3 }],
    ]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators?desde=2026-01-01&hasta=2026-04-30').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.mtbf_dias_promedio).toBe(37.75);
    expect(r.body.mttr_horas).toBe(8.5);
    expect(r.body.costo_total).toBe(1500000);
    expect(r.body.km_recorridos).toBe(30000);
    expect(r.body.costo_por_km).toBe(50);
    // disponibilidad = (720-72)/720*100 = 90
    expect(r.body.disponibilidad_pct).toBe(90);
    expect(r.body.ots_reincidentes).toHaveLength(1);
  });

  it('vehicleId param → llama queries con filter', async () => {
    mockSequence([[], [{ mttr_horas: null, ots: 0 }], [], [{ costo_total: 0, ots: 0 }], [{ km_recorridos: 0 }], [{ horas_taller: 0, horas_periodo: 720 }], []]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators?vehicleId=5').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.vehicleId).toBe(5);
  });

  it('fechas inválidas → fallback automático', async () => {
    mockSequence([[], [{ mttr_horas: null, ots: 0 }], [], [{ costo_total: 0, ots: 0 }], [{ km_recorridos: 0 }], [{ horas_taller: 0, horas_periodo: 720 }], []]);
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/maint/indicators?desde=invalid&hasta=invalid').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
