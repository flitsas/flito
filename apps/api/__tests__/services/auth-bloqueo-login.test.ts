/**
 * Bug #12953 — «BLOQUEO GENERAL POR INTENTOS DE INGRESO».
 *
 * Repro: un usuario agotaba sus intentos y TODOS quedaban fuera con «Demasiados intentos de
 * autenticacion, espere 15 minutos». El `authLimiter` contaba por la IP que veía la api (la del
 * gateway Docker, única para todos) y contaba también los logins correctos.
 *
 * Aquí se monta el `authLimiter` REAL como en `app.ts` (`trust proxy = 1`, sobre
 * `/api/auth/login`) delante de un login falso que responde 200/401 según la contraseña. La
 * plantilla nginx que entrega la IP real no tiene test en el repo: se verifica en DEV.
 *
 * El limitador es un singleton con store en memoria: cada test usa IPs propias para no heredar
 * el contador de otro.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { authLimiter } = await import('../../src/shared/middleware/rateLimiter.js');
const { checkLockout, registerFailed } = await import('../../src/modules/auth/loginLockout.js');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth/login', authLimiter);
  app.post('/api/auth/login', (req, res) => {
    if (req.body?.password === 'buena') return res.json({ ok: true });
    return res.status(401).json({ error: 'Credenciales invalidas' });
  });
  return app;
}

function login(app: express.Express, ip: string, username: string, password: string) {
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ username, password });
}

describe('authLimiter — Bug #12953', () => {
  it('logins CORRECTOS repetidos desde la misma IP nunca dan 429 (solo cuentan los fallos)', async () => {
    const app = buildApp();
    for (let i = 0; i < 15; i++) {
      const res = await login(app, '203.0.113.10', 'ana', 'buena');
      expect(res.status).toBe(200);
    }
  });

  it('los fallos del usuario A desde la IP X no bloquean al usuario B desde la IP Y', async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect((await login(app, '203.0.113.20', 'ana', 'mala')).status).toBe(401);
    }
    // A agotó su cupo en X…
    const bloqueado = await login(app, '203.0.113.20', 'ana', 'mala');
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toBe('Demasiados intentos de autenticacion, espere 2 minutos');
    // …y B, desde otra IP, entra.
    expect((await login(app, '198.51.100.7', 'beto', 'buena')).status).toBe(200);
    expect((await login(app, '198.51.100.7', 'beto', 'mala')).status).toBe(401);
  });

  it('la ventana del limitador es de 2 minutos (cabecera RateLimit-Reset ≤ 120 s)', async () => {
    const app = buildApp();
    const res = await login(app, '203.0.113.30', 'ana', 'mala');
    expect(res.status).toBe(401);
    const reset = Number(res.headers['ratelimit-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(120);
  });
});

describe('loginLockout — bloqueo por usuario de 2 minutos (Bug #12953)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('tras 5 fallos bloquea 2 min y a los 2 min vuelve a dejar entrar', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    for (let i = 0; i < 5; i++) await registerFailed('lockout-12953');

    const estado = await checkLockout('lockout-12953');
    expect(estado).toEqual({ locked: true, remainingMins: 2 });

    vi.setSystemTime(new Date('2026-09-25T12:01:59Z'));
    expect((await checkLockout('lockout-12953')).locked).toBe(true);

    vi.setSystemTime(new Date('2026-09-25T12:02:01Z'));
    expect(await checkLockout('lockout-12953')).toEqual({ locked: false });
  });
});
