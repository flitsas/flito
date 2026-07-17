import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';

// Indicadores usa db.execute(sql`...`) directamente — no hay select chain.
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(),
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

describe('RNDC indicadores', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    executeMock.mockReset();
    // /health hace execute(SELECT 1) por defecto
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET /resumen sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/indicadores/resumen');
    expect(r.status).toBe(401);
  });

  it('GET /resumen con admin → 200 con secciones manifiestos/remesas/revenue', async () => {
    executeMock.mockReset();
    // 3 ejecuciones consecutivas: byEstado, revenue, remesasResumen
    executeMock
      .mockResolvedValueOnce([{ borradores: 1, listos: 2, radicados: 3, aceptados: 4, rechazados: 0, cumplidos: 5, anulados: 0, total: 15 }])
      .mockResolvedValueOnce([{ revenue_total: '1500000', revenue_facturable: '900000', anticipos: '300000' }])
      .mockResolvedValueOnce([{ borradores: 0, activas_sin_manifiesto: 1, cumplidas: 4, anuladas: 0, total: 5 }]);

    const r = await request(app)
      .get('/api/rndc/indicadores/resumen')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.manifiestos.total).toBe(15);
    expect(r.body.remesas.total).toBe(5);
    expect(r.body.revenue.revenue_total).toBe('1500000');
    expect(r.body.rango).toHaveProperty('desde');
    expect(r.body.rango).toHaveProperty('hasta');
  });

  it('GET /resumen con desde/hasta usa el rango pasado', async () => {
    executeMock.mockReset();
    executeMock
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([{ revenue_total: '0' }])
      .mockResolvedValueOnce([{ total: 0 }]);

    const r = await request(app)
      .get('/api/rndc/indicadores/resumen?desde=2026-01-01&hasta=2026-12-31')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.rango.desde).toBe('2026-01-01');
    expect(r.body.rango.hasta).toBe('2026-12-31');
  });

  it('GET /top-conductores → 200 con lista', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([
      { conductor_id: 1, conductor_nombre: 'Juan', total_manifiestos: '10', cumplidos: '8', valor_flete_acumulado: '500000' },
      { conductor_id: 2, conductor_nombre: 'Pedro', total_manifiestos: '7', cumplidos: '5', valor_flete_acumulado: '350000' },
    ]);
    const r = await request(app)
      .get('/api/rndc/indicadores/top-conductores')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data[0].conductor_nombre).toBe('Juan');
  });

  it('GET /top-vehiculos → 200', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([
      { vehiculo_id: 1, placa: 'ABC123', alias: 'TURBO', total_manifiestos: '20', cumplidos: '18', valor_flete_acumulado: '1000000' },
    ]);
    const r = await request(app)
      .get('/api/rndc/indicadores/top-vehiculos')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data[0].placa).toBe('ABC123');
  });

  it('GET /top-rutas → 200', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([
      { origen_nombre: 'MEDELLIN', destino_nombre: 'BOGOTA', municipio_origen_dane: '05001', municipio_destino_dane: '11001', total: '15', valor_acumulado: '750000' },
    ]);
    const r = await request(app)
      .get('/api/rndc/indicadores/top-rutas')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data[0].origen_nombre).toBe('MEDELLIN');
  });

  it('GET /top-rutas sin auth → 401', async () => {
    const r = await request(app).get('/api/rndc/indicadores/top-rutas');
    expect(r.status).toBe(401);
  });
});
