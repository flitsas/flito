import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
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

const generarManifiestoPdfMock = vi.fn();
vi.mock('../../src/modules/rndc/pdf.service.js', () => ({
  generarManifiestoPdf: generarManifiestoPdfMock,
}));

describe('RNDC pdf — GET /manifiestos/:id/pdf', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    generarManifiestoPdfMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/manifiestos/1/pdf');
    expect(r.status).toBe(401);
  });

  it('GET con id no numérico → 400', async () => {
    const r = await request(app)
      .get('/api/rndc/manifiestos/abc/pdf')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ID inválido');
  });

  it('GET con id <=0 → 400', async () => {
    const r = await request(app)
      .get('/api/rndc/manifiestos/0/pdf')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
  });

  it('GET id válido → 200 application/pdf', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake', 'utf8');
    generarManifiestoPdfMock.mockResolvedValueOnce(fakePdf);
    const r = await request(app)
      .get('/api/rndc/manifiestos/42/pdf')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toMatch(/manifiesto-42\.pdf/);
    expect(r.body.toString('utf8').startsWith('%PDF')).toBe(true);
    expect(generarManifiestoPdfMock).toHaveBeenCalledWith({ manifiestoId: 42 });
  });

  it('GET cuando service lanza "no encontrado" → 404', async () => {
    generarManifiestoPdfMock.mockRejectedValueOnce(new Error('Manifiesto 999 no encontrado'));
    const r = await request(app)
      .get('/api/rndc/manifiestos/999/pdf')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no encontrado/i);
  });

  it('GET cuando service lanza error genérico → 500', async () => {
    generarManifiestoPdfMock.mockRejectedValueOnce(new Error('disco lleno'));
    const r = await request(app)
      .get('/api/rndc/manifiestos/7/pdf')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(500);
  });
});
