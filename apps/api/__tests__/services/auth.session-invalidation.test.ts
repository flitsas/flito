import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), execute: executeMock, transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
const originalSkip = process.env.AUTH_SKIP_SESSION_INVAL_CHECK;

beforeEach(async () => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); executeMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  // Activar check explícitamente en este archivo de tests (la suite global lo desactiva).
  process.env.AUTH_SKIP_SESSION_INVAL_CHECK = '';
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

import { afterAll } from 'vitest';
afterAll(() => {
  if (originalSkip !== undefined) process.env.AUTH_SKIP_SESSION_INVAL_CHECK = originalSkip;
});

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);

async function tokenWithIat(iatSeconds: number, role = 'admin'): Promise<string> {
  return await new SignJWT({ username: 'edison', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('6')
    .setIssuedAt(iatSeconds)
    .setExpirationTime('24h')
    .sign(secret());
}

describe('Auth · invalidación automática de sesiones JWT', () => {
  it('JWT con iat anterior a session_invalidated_at → 401', async () => {
    const invalDate = new Date('2026-05-07T20:00:00Z');
    // El primer select del middleware busca session_invalidated_at del user
    selectMock.mockReturnValueOnce(chain([{ s: invalDate }]));

    const tokenIat = Math.floor(new Date('2026-05-07T19:00:00Z').getTime() / 1000); // 1h antes
    const tok = await tokenWithIat(tokenIat);
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/Sesi[óo]n invalidada/i);
  });

  it('JWT con iat posterior → pasa el check de invalidación (no 401 por esa causa)', async () => {
    const invalDate = new Date('2026-05-07T20:00:00Z');
    selectMock.mockReturnValueOnce(chain([{ s: invalDate }]));
    // Después del middleware, el handler GET /users hace su propio select
    selectMock.mockReturnValueOnce(chain([])); // lista vacía de users

    const tokenIat = Math.floor(new Date('2026-05-07T21:00:00Z').getTime() / 1000); // 1h después
    const tok = await tokenWithIat(tokenIat);
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${tok}`);
    expect(r.status).not.toBe(401);
  });

  it('JWT sin iat (token viejo) y user con marca de invalidación → 401', async () => {
    const invalDate = new Date('2026-05-07T20:00:00Z');
    selectMock.mockReturnValueOnce(chain([{ s: invalDate }]));

    // Token sin setIssuedAt — payload.iat undefined → middleware usa 0
    const tok = await new SignJWT({ username: 'edison', role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('6')
      .setExpirationTime('24h')
      .sign(secret());
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(401);
  });

  it('user sin session_invalidated_at (null) → JWT pasa siempre', async () => {
    selectMock.mockReturnValueOnce(chain([{ s: null }]));
    selectMock.mockReturnValueOnce(chain([])); // handler GET

    const tok = await tokenWithIat(Math.floor(Date.now() / 1000));
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${tok}`);
    expect(r.status).not.toBe(401);
  });
});

describe('PATCH /users/:id invalida sesiones cuando cambia role/allowedPages', () => {
  it('cambiar role → updates incluye sessionInvalidatedAt', async () => {
    selectMock.mockReturnValueOnce(chain([{ s: null }]));        // middleware
    selectMock.mockReturnValueOnce(chain([{ id: 6, role: 'lider_pesv' }])); // before
    let capturedSet: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (s: any) => { capturedSet = s; return { where: () => ({ returning: () => Promise.resolve([{ id: 6, name: 'Edison', role: 'admin' }]) }) }; },
    }));

    const tok = await tokenWithIat(Math.floor(Date.now() / 1000));
    const r = await request(app).patch('/api/users/6').set('Authorization', `Bearer ${tok}`)
      .send({ role: 'admin' });
    expect(r.status).toBe(200);
    expect(capturedSet?.role).toBe('admin');
    expect(capturedSet?.sessionInvalidatedAt).toBeInstanceOf(Date);
  });

  it('cambiar solo nombre → NO bumpea sessionInvalidatedAt', async () => {
    selectMock.mockReturnValueOnce(chain([{ s: null }]));
    selectMock.mockReturnValueOnce(chain([{ id: 6, role: 'admin' }]));
    let capturedSet: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (s: any) => { capturedSet = s; return { where: () => ({ returning: () => Promise.resolve([{ id: 6, name: 'Edison Nuevo', role: 'admin' }]) }) }; },
    }));

    const tok = await tokenWithIat(Math.floor(Date.now() / 1000));
    const r = await request(app).patch('/api/users/6').set('Authorization', `Bearer ${tok}`)
      .send({ name: 'Edison Nuevo' });
    expect(r.status).toBe(200);
    expect(capturedSet?.sessionInvalidatedAt).toBeUndefined();
  });

  it('POST /:id/invalidate-sessions setea marca + 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ s: null }]));
    let capturedSet: any = null;
    updateMock.mockImplementationOnce(() => ({
      set: (s: any) => { capturedSet = s; return { where: () => ({ returning: () => Promise.resolve([{ id: 6, username: 'edison' }]) }) }; },
    }));

    const tok = await tokenWithIat(Math.floor(Date.now() / 1000));
    const r = await request(app).post('/api/users/6/invalidate-sessions').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(capturedSet?.sessionInvalidatedAt).toBeInstanceOf(Date);
  });
});
