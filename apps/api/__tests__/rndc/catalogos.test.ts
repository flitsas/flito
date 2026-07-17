import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
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

const MUNICIPIO_ROW = {
  codigoDane: '05001000',
  nombre: 'MEDELLIN',
  departamentoCodigo: '05',
  departamentoNombre: 'ANTIOQUIA',
};

describe('RNDC catalogos', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    executeMock.mockReset();
    // /health hace execute(SELECT 1) — devolver respuesta válida por defecto
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET /municipios sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/catalogos/municipios');
    expect(r.status).toBe(401);
  });

  it('GET /municipios con admin → 200 con lista', async () => {
    selectMock.mockReturnValueOnce(chain([MUNICIPIO_ROW]));
    const r = await request(app)
      .get('/api/rndc/catalogos/municipios')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].nombre).toBe('MEDELLIN');
  });

  it('GET /municipios con q=<2 chars no aplica filtro pero responde 200', async () => {
    selectMock.mockReturnValueOnce(chain([MUNICIPIO_ROW]));
    const r = await request(app)
      .get('/api/rndc/catalogos/municipios?q=a')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /municipios con depto filtra → 200', async () => {
    selectMock.mockReturnValueOnce(chain([MUNICIPIO_ROW]));
    const r = await request(app)
      .get('/api/rndc/catalogos/municipios?depto=05&q=mede')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /departamentos → 200 con execute SQL', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([
      { codigo: '05', nombre: 'ANTIOQUIA' },
      { codigo: '11', nombre: 'BOGOTA D.C.' },
    ]);
    const r = await request(app)
      .get('/api/rndc/catalogos/departamentos')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
  });

  it('GET /productos sin q → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: '001', nombre: 'CAFE' }]));
    const r = await request(app)
      .get('/api/rndc/catalogos/productos')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('GET /productos con q válido → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: '001', nombre: 'CAFE TOSTADO' }]));
    const r = await request(app)
      .get('/api/rndc/catalogos/productos?q=cafe')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /empaques → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: 'BG', nombre: 'BOLSA' }]));
    const r = await request(app)
      .get('/api/rndc/catalogos/empaques')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data[0].nombre).toBe('BOLSA');
  });

  it('GET /unidades → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: 'KG', nombre: 'KILOGRAMO' }]));
    const r = await request(app)
      .get('/api/rndc/catalogos/unidades')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data[0].codigo).toBe('KG');
  });

  it('GET /modos-pago → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ codigo: 'C', nombre: 'CONTADO' }]));
    const r = await request(app)
      .get('/api/rndc/catalogos/modos-pago')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });
});
