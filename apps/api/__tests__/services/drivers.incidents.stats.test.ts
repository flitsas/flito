import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';

const selectMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: executeMock,
    transaction: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); executeMock.mockReset();
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV Paso 21 · GET /drivers/incidents/stats', () => {
  it('retorna agregados completos: totales + mensual + causa + topConductores + indicadoresPesv', async () => {
    // 1. totalRows
    executeMock.mockResolvedValueOnce({ rows: [{
      total: 12, accidentes: 5, casi: 4, comparendos: 3,
      fatales: 1, graves: 2, leves: 3,
      victimas_total: 7, dias_perdidos_total: 45, costos_total: '5000000',
      investigaciones: 4, investigaciones_cerradas: 3,
    }] });
    // 2. mensual
    executeMock.mockResolvedValueOnce({ rows: [
      { mes: '2026-04', total: 5, accidentes: 2, graves_fatales: 1, victimas: 3 },
      { mes: '2026-05', total: 7, accidentes: 3, graves_fatales: 2, victimas: 4 },
    ] });
    // 3. porCausa
    executeMock.mockResolvedValueOnce({ rows: [
      { metodo: '5_porques', c: 2 },
      { metodo: 'ishikawa', c: 2 },
    ] });
    // 4. topConductores
    executeMock.mockResolvedValueOnce({ rows: [
      { conductor_id: 7, name: 'Edison Alvarez', c: 3, victimas: 1 },
    ] });
    // 5. HHT (jornadas)
    executeMock.mockResolvedValueOnce({ rows: [{ hht: 1500 }] });

    const r = await request(app).get('/api/drivers/incidents/stats').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.totales.total).toBe(12);
    expect(r.body.mensual.length).toBe(2);
    expect(r.body.porCausa.length).toBe(2);
    expect(r.body.topConductores[0].name).toBe('Edison Alvarez');
    // Frecuencia = 5 * 200000 / 1500 = 666.67
    expect(r.body.indicadoresPesv.frecuencia).toBeCloseTo(666.67, 1);
    // Severidad = 45 * 200000 / 1500 = 6000
    expect(r.body.indicadoresPesv.severidad).toBeCloseTo(6000, 1);
    // Indice gravedad = (666.67 * 6000) / 1000 = 4000
    expect(r.body.indicadoresPesv.indiceGravedad).toBeGreaterThan(3990);
  });

  it('HHT=0 → indicadores en 0 (sin division por cero)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ total: 0, accidentes: 0, casi: 0, comparendos: 0, fatales: 0, graves: 0, leves: 0, victimas_total: 0, dias_perdidos_total: 0, costos_total: '0', investigaciones: 0, investigaciones_cerradas: 0 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [{ hht: 0 }] });

    const r = await request(app).get('/api/drivers/incidents/stats').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.indicadoresPesv.frecuencia).toBe(0);
    expect(r.body.indicadoresPesv.severidad).toBe(0);
    expect(r.body.indicadoresPesv.indiceGravedad).toBe(0);
  });

  it('respeta filtros from/to en periodo', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ total: 1, accidentes: 0, casi: 1, comparendos: 0, fatales: 0, graves: 0, leves: 0, victimas_total: 0, dias_perdidos_total: 0, costos_total: '0', investigaciones: 0, investigaciones_cerradas: 0 }] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [{ hht: 100 }] });

    const r = await request(app).get('/api/drivers/incidents/stats?from=2026-01-01&to=2026-03-31').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.periodo.from).toBe('2026-01-01');
    expect(r.body.periodo.to).toBe('2026-03-31');
  });

  it('sin auth → 401', async () => {
    const r = await request(app).get('/api/drivers/incidents/stats');
    expect(r.status).toBe(401);
  });
});
