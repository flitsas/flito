// HU #12082 — `requirePage(slug)` es `exigirFuncion('pagina.<slug>')`: las páginas pasan por el
// mismo motor que las operaciones (AC7, RN-A4). El admin ve todo porque el seed le marcó `pagina.*`,
// no por una rama `role === 'admin'`; y el `allowedPages` de un token viejo no decide nada (RN-A5).
//
// Task de QA que fija este fichero: #12269. Decisión declarada en el PR: el 403 de `requirePage`
// cambia de `{ error: 'Sin permiso para acceder a "<Label>"' }` al cuerpo unificado de `exigirFuncion`
// (`{ error, funcion: 'pagina.<slug>', motivo }`); medido: nadie en apps/web ni en __tests__ leía
// el texto viejo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { PermisosResueltos } from '../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve([]) }) })), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/permisos-efectivos.js', () => ({
  resolverPermisos: (id: number) => resolverMock(id),
  invalidarPermisosDe: vi.fn(),
  invalidarPermisosDeRol: vi.fn(),
  paginasEfectivasDeUsuario: vi.fn().mockResolvedValue([]),
}));

const { requirePage } = await import('../../src/shared/permissions.js');
const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const { authMiddleware } = await import('../../src/shared/middleware/auth.js');

const ok = (funciones: string[], rol = 'gestor'): PermisosResueltos => ({
  ok: true, userId: 7, rol, tipoPrincipal: 'interno', funciones: new Set(funciones),
  version: 'v1', resueltoEn: new Date(), ...({} as object),
});

const handler = vi.fn((_req: Request, res: Response) => { res.json({ ok: true }); });

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
const firmar = (claims: Record<string, unknown>, role = 'gestor') => new SignJWT({ username: 'u', role, ...claims })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('7').setIssuedAt().setExpirationTime('1h').sign(secret());

function app(): Express {
  const a = express();
  a.get('/p', authMiddleware, requirePage('dashboard'), handler);
  a.get('/f', authMiddleware, exigirFuncion('pagina.dashboard'), handler);
  a.get('/sin-auth', requirePage('dashboard'), handler);
  return a;
}

beforeEach(() => { resolverMock.mockReset(); handler.mockClear(); });

describe('TC #12269 AC7 — requirePage(slug) delega en el conjunto efectivo (pagina.<slug>): admin con base vacía recibe 403 (no hay rama dura) y el allowedPages del token no decide', () => {
  it('(1) conjunto {pagina.dashboard} → 200', async () => {
    resolverMock.mockResolvedValue(ok(['pagina.dashboard']));
    const r = await request(app()).get('/p').set('Authorization', `Bearer ${await firmar({})}`);
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('(2) conjunto {pagina.users} → 403 con el cuerpo unificado de exigirFuncion', async () => {
    resolverMock.mockResolvedValue(ok(['pagina.users']));
    const r = await request(app()).get('/p').set('Authorization', `Bearer ${await firmar({})}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: 'No tiene acceso a este módulo («general»).',
      funcion: 'pagina.dashboard',
      motivo: 'sin_modulo',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('(3) rol admin con conjunto vacío en la base → 403: no hay rama role === admin', async () => {
    resolverMock.mockResolvedValue(ok([], 'admin'));
    const r = await request(app()).get('/p').set('Authorization', `Bearer ${await firmar({}, 'admin')}`);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('pagina.dashboard');
    expect(handler).not.toHaveBeenCalled();
  });

  it('(4) conjunto vacío pero JWT con allowedPages [dashboard] → 403: el token no decide (RN-A5)', async () => {
    resolverMock.mockResolvedValue(ok([]));
    const r = await request(app()).get('/p')
      .set('Authorization', `Bearer ${await firmar({ allowedPages: ['dashboard'] })}`);
    expect(r.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('requirePage y exigirFuncion resuelven por el MISMO resolutor: el mismo spy en los dos caminos, mismo cuerpo', async () => {
    resolverMock.mockResolvedValue(ok(['pagina.users']));
    const tok = await firmar({});
    const rp = await request(app()).get('/p').set('Authorization', `Bearer ${tok}`);
    const rf = await request(app()).get('/f').set('Authorization', `Bearer ${tok}`);
    expect(rp.status).toBe(403);
    expect(rf.body).toEqual(rp.body);
    // Frontera + guarda en cada petición, siempre con el sub verificado.
    expect(resolverMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [arg] of resolverMock.mock.calls) expect(arg).toBe(7);
  });

  it('sin req.user → 401 y no se llama al resolutor', async () => {
    const r = await request(app()).get('/sin-auth');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Token requerido' });
    expect(resolverMock).not.toHaveBeenCalled();
  });
});
