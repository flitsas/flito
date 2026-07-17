import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const argonVerifyMock = vi.fn();
vi.mock('argon2', () => ({
  default: { verify: argonVerifyMock },
  verify: argonVerifyMock,
}));

const checkLockoutMock = vi.fn();
const registerFailedMock = vi.fn().mockResolvedValue(undefined);
const clearLockoutMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/auth/loginLockout.js', () => ({
  checkLockout: checkLockoutMock,
  registerFailed: registerFailedMock,
  clearLockout: clearLockoutMock,
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

// Silenciar redis para evitar warnings de "connect ECONNREFUSED 127.0.0.1:6379".
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const blacklistTokenMock = vi.fn().mockResolvedValue(undefined);
const isTokenBlacklistedMock = vi.fn().mockResolvedValue(false);
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/auth.js')>();
  return {
    ...actual,
    blacklistToken: blacklistTokenMock,
    isTokenBlacklisted: isTokenBlacklistedMock,
  };
});

beforeEach(async () => {
  selectMock.mockReset();
  argonVerifyMock.mockReset();
  checkLockoutMock.mockReset();
  registerFailedMock.mockClear();
  clearLockoutMock.mockClear();
  auditMock.mockClear();
  blacklistTokenMock.mockClear();
  isTokenBlacklistedMock.mockReset().mockResolvedValue(false);
  // Default: no lockout
  checkLockoutMock.mockResolvedValue({ locked: false });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/auth/auth.routes.js');
  app.use('/api/auth', router);
  return app;
}

describe('POST /api/auth/login — validación zod', () => {
  it('body sin username → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ password: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/usuario.*contraseña/i);
  });

  it('body sin password → 400', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'x' });
    expect(r.status).toBe(400);
  });

  it('username string vacío → 400 (zod min 1)', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: '', password: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/auth/login — lockout', () => {
  it('cuenta bloqueada (locked=true) → 429 con remainingMins', async () => {
    checkLockoutMock.mockResolvedValueOnce({ locked: true, remainingMins: 12 });
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'p' });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/12 minutos/);
    // No tocó BD
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — usuario no existe / inactive', () => {
  it('user no existe → 401 + audit + registerFailed', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin usuario
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'JuanPerez', password: 'p' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Credenciales inválidas');
    expect(registerFailedMock).toHaveBeenCalledWith('JuanPerez');
    expect(clearLockoutMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalled();
    // El detail enmascara username (3 chars + '***')
    const auditArgs = auditMock.mock.calls[0][1];
    expect(auditArgs.action).toBe('login_failed');
    expect(auditArgs.detail).toContain('Jua***');
    expect(auditArgs.detail).not.toContain('JuanPerez');
  });

  it('user inactive (active=false) → 401 + registerFailed', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, username: 'u', passwordHash: 'h', active: false, role: 'admin', name: 'X', allowedPages: null,
    }]));
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'p' });
    expect(r.status).toBe(401);
    expect(argonVerifyMock).not.toHaveBeenCalled(); // ni siquiera verifica password
    expect(registerFailedMock).toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — password incorrecto', () => {
  it('argon2.verify=false → 401 + registerFailed + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 7, username: 'u', passwordHash: 'h', active: true, role: 'admin', name: 'X', allowedPages: null,
    }]));
    argonVerifyMock.mockResolvedValueOnce(false);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'u', password: 'mala' });
    expect(r.status).toBe(401);
    expect(registerFailedMock).toHaveBeenCalled();
    expect(clearLockoutMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0][1].action).toBe('login_failed');
  });
});

describe('POST /api/auth/login — éxito', () => {
  it('argon2.verify=true → 200 + token JWT + clearLockout + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 42, username: 'admin', passwordHash: 'h', active: true, role: 'admin', name: 'Admin User', allowedPages: null,
    }]));
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'OK' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.token.split('.').length).toBe(3); // JWT structure
    expect(r.body.user).toMatchObject({
      id: 42, name: 'Admin User', username: 'admin', role: 'admin',
    });
    // F-3: login ahora devuelve allowedPages efectivas (admin → todas las páginas).
    expect(Array.isArray(r.body.user.allowedPages)).toBe(true);
    expect(r.body.user.allowedPages).toContain('dashboard');
    expect(clearLockoutMock).toHaveBeenCalledWith('admin');
    expect(registerFailedMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0][1].action).toBe('login');
    expect(auditMock.mock.calls[0][1].resourceId).toBe('42');
  });

  it('NO devuelve passwordHash en respuesta (PII protection)', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, username: 'a', passwordHash: 'SECRET-HASH', active: true, role: 'admin', name: 'A', allowedPages: null,
    }]));
    argonVerifyMock.mockResolvedValueOnce(true);
    const app = await buildApp();
    const r = await request(app).post('/api/auth/login').send({ username: 'a', password: 'p' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET-HASH');
    expect(r.body.user).not.toHaveProperty('passwordHash');
  });
});

describe('GET /api/auth/me', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me');
    expect(r.status).toBe(401);
  });

  it('token válido + user existe → 200 con allowedPages efectivas', async () => {
    selectMock.mockReturnValueOnce(chain([{
      id: 1, username: 'admin', name: 'A', role: 'admin', allowedPages: null,
    }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
    expect(Array.isArray(r.body.allowedPages)).toBe(true);
  });

  it('token válido pero user no existe en BD → 404', async () => {
    selectMock.mockReturnValueOnce(chain([])); // user borrado tras emitir token
    const token = await testToken({ sub: 999, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });
});

describe('POST /api/auth/logout', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/auth/logout');
    expect(r.status).toBe(401);
  });

  it('token válido → 200 + blacklistToken llamado con el token', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(blacklistTokenMock).toHaveBeenCalledWith(token);
  });
});
