import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock del cliente BD ANTES de importar app. Drizzle expone `db.select(...).from(...).where(...).limit(...)` como cadena
// fluida que termina en una promesa-array; cada test reasigna la implementación con mockImplementation.
type FluentChain = {
  from: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

// Mock del rate limiter para que no bloquee. Importamos el módulo real y solo reemplazamos los limiters
// (otros exports como `userOrIpKey` los consume procesador.routes.ts y deben quedar disponibles).
vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    apiLimiter: passthrough,
    authLimiter: passthrough,
    qrPublicLimiter: passthrough,
  };
});

// Sin Redis en CI/local-test: getRedis() retorna null para que los consumidores caigan a fallback
// in-memory. Evita unhandled rejections de ioredis intentando conectar a 127.0.0.1:6379.
vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

// Helpers para armar la cadena fluida de drizzle.
function chain(rows: unknown[]): FluentChain {
  const result: FluentChain = {
    from: vi.fn(() => result),
    leftJoin: vi.fn(() => result),
    where: vi.fn(() => result),
    limit: vi.fn(() => Promise.resolve(rows) as unknown as FluentChain),
  };
  return result;
}

const VALID_TOKEN = 'abcdef1234567890ABCDEF';
const INVALID_TOKEN_SHORT = 'short';
const INVALID_TOKEN_CHARS = 'token!!con$$caracteres';

describe('GET /api/rndc/public/manifiestos/qr/:token', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('rechaza token con caracteres inválidos (400)', async () => {
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${INVALID_TOKEN_CHARS}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/inválido/i);
  });

  it('rechaza token muy corto (400)', async () => {
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${INVALID_TOKEN_SHORT}`);
    expect(r.status).toBe(400);
  });

  it('responde 404 cuando token no existe en BD', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin filas
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${VALID_TOKEN}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ valido: false });
  });

  it('responde 404 cuando manifiesto está soft-deleted (deletedAt != null)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      numero: 'MAN-1', consecutivoRndc: '123', estado: 'aprobado',
      fechaExpedicion: '2026-05-06', placa: 'ABC123',
      origenDane: '11001', destinoDane: '05001',
      anuladoAt: null, deletedAt: new Date(),
    }]));
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${VALID_TOKEN}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ valido: false });
  });

  it('responde 200 con datos mínimos (sin PII) cuando manifiesto vigente', async () => {
    selectMock.mockReturnValueOnce(chain([{
      numero: 'MAN-1', consecutivoRndc: '123', estado: 'aprobado',
      fechaExpedicion: '2026-05-06', placa: 'ABC123',
      origenDane: '11001', destinoDane: '05001',
      anuladoAt: null, deletedAt: null,
    }]));
    selectMock.mockReturnValueOnce(chain([{ nombre: 'BOGOTÁ D.C.' }]));
    selectMock.mockReturnValueOnce(chain([{ nombre: 'MEDELLÍN' }]));

    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${VALID_TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      valido: true,
      numero: 'MAN-1',
      consecutivoRndc: '123',
      placa: 'ABC123',
      origen: 'BOGOTÁ D.C.',
      destino: 'MEDELLÍN',
      razonSocialEmpresa: 'Kyverum LLC',
    });
    // No filtramos PII: ni conductor, ni cliente, ni valores comerciales.
    expect(r.body).not.toHaveProperty('conductor');
    expect(r.body).not.toHaveProperty('cliente');
    expect(r.body).not.toHaveProperty('valor');
    expect(r.body).not.toHaveProperty('flete');
  });

  it('responde valido=false cuando manifiesto está anulado', async () => {
    selectMock.mockReturnValueOnce(chain([{
      numero: 'MAN-2', consecutivoRndc: '124', estado: 'anulado',
      fechaExpedicion: '2026-05-06', placa: 'XYZ789',
      origenDane: '11001', destinoDane: '05001',
      anuladoAt: new Date(), deletedAt: null,
    }]));
    selectMock.mockReturnValueOnce(chain([{ nombre: 'BOGOTÁ D.C.' }]));
    selectMock.mockReturnValueOnce(chain([{ nombre: 'MEDELLÍN' }]));

    const r = await request(app).get(`/api/rndc/public/manifiestos/qr/${VALID_TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.valido).toBe(false);
    expect(r.body.estado).toBe('anulado');
  });
});

describe('GET /api/rndc/public/manifiestos/qr-png/:token', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('rechaza token inválido (400)', async () => {
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr-png/${INVALID_TOKEN_CHARS}`);
    expect(r.status).toBe(400);
  });

  it('responde 404 cuando token no existe', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr-png/${VALID_TOKEN}`);
    expect(r.status).toBe(404);
  });

  it('responde 200 con PNG cuando token existe', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    const r = await request(app).get(`/api/rndc/public/manifiestos/qr-png/${VALID_TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toMatch(/immutable/);
    // Magic bytes PNG: 89 50 4E 47.
    expect(r.body[0]).toBe(0x89);
    expect(r.body[1]).toBe(0x50);
    expect(r.body[2]).toBe(0x4e);
    expect(r.body[3]).toBe(0x47);
  });
});
