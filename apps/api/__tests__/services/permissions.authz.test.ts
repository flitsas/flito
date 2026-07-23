import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { getEffectivePages, requirePage } from '../../src/shared/permissions.js';
import type { UserRole } from '../../src/shared/middleware/auth.js';
import { testToken } from '../helpers/auth.js';

// AUTH_SKIP_SESSION_INVAL_CHECK='1' (setup.ts) → authMiddleware no consulta BD.
// Mockeamos db/redis para que importar auth.js no abra conexiones reales.
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn().mockImplementation((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn().mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

describe('getEffectivePages — unión rol + allowedPages', () => {
  it('proveedor sin allowedPages → solo defaults del rol', () => {
    const pages = getEffectivePages({ role: 'proveedor' });
    expect(pages.sort()).toEqual(['dashboard', 'soat'].sort());
  });

  it('proveedor con allowedPages extra → defaults ∪ custom, sin duplicar', () => {
    const pages = getEffectivePages({ role: 'proveedor', allowedPages: ['transito', 'dashboard'] });
    expect(pages).toContain('transito');
    expect(pages).toContain('soat');
    expect(pages.filter((p) => p === 'dashboard')).toHaveLength(1);
  });

  it('allowedPages con slugs inválidos → se filtran', () => {
    const pages = getEffectivePages({ role: 'proveedor', allowedPages: ['no_existe', 'transito'] });
    expect(pages).toContain('transito');
    expect(pages).not.toContain('no_existe' as never);
  });

  it('admin → todas las páginas, ignora allowedPages', () => {
    const all = getEffectivePages({ role: 'admin' });
    const withCustom = getEffectivePages({ role: 'admin', allowedPages: [] });
    expect(all).toEqual(withCustom);
    expect(all).toContain('users');
    expect(all).toContain('laft');
  });
});

describe('requirePage — autorización server-side por página', () => {
  const next = vi.fn();

  it('user con la página vía allowedPages → next()', () => {
    next.mockClear();
    const req = { user: { sub: 1, username: 'u', role: 'proveedor' as UserRole, allowedPages: ['transito'] } } as unknown as Request;
    const res = mockRes();
    requirePage('transito')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('user SIN la página (ni rol ni allowedPages) → 403', () => {
    next.mockClear();
    const req = { user: { sub: 1, username: 'u', role: 'proveedor' as UserRole, allowedPages: [] } } as unknown as Request;
    const res = mockRes();
    requirePage('transito')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('sin req.user → 401', () => {
    next.mockClear();
    const req = {} as Request;
    const res = mockRes();
    requirePage('transito')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('authMiddleware — propaga allowedPages del JWT a req.user', () => {
  it('token con allowedPages → req.user.allowedPages poblado y requirePage permite', async () => {
    const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
    const token = await testToken({ role: 'proveedor', allowedPages: ['transito'] });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.allowedPages).toEqual(['transito']);

    const res2 = mockRes();
    const next2 = vi.fn();
    requirePage('transito')(req, res2, next2);
    expect(next2).toHaveBeenCalledOnce();
  });

  it('token viejo SIN allowedPages → req.user.allowedPages undefined → solo defaults del rol', async () => {
    const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
    const token = await testToken({ role: 'proveedor' }); // sin allowedPages
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.allowedPages).toBeUndefined();

    // 'transito' NO está en defaults de proveedor → 403
    const res2 = mockRes();
    const next2 = vi.fn();
    requirePage('transito')(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect((res2 as Response & { statusCode?: number }).statusCode).toBe(403);
  });
});

// USR-7: gate anti-drift. Antes de la unificación, roles vivían en 3 sitios
// (8/7/4) y páginas en 2 (27/23). Estos tests fallan si el catálogo se vuelve
// a duplicar/desincronizar.
describe('paridad de catálogos y roles (anti-drift USR-7)', () => {
  it('ALL_ROLES ⊆ USER_ROLES, son 11 (8 base + FLITO gestor_impuestos/mensajero + finanzas) y contiene auditor', async () => {
    const shared = await import('@operaciones/shared-types');
    const valid = new Set<string>(shared.USER_ROLES);
    for (const r of shared.ALL_ROLES) expect(valid.has(r)).toBe(true);
    // 8 base + `gestor_impuestos` + `mensajero` (FLITO) + `financiera`. El antiguo `operaciones` se fusionó en `admin`.
    expect(shared.USER_ROLES).toHaveLength(11);
    expect(shared.ALL_ROLES).toContain('auditor');
    expect(shared.ALL_ROLES).not.toContain('operaciones');
    expect(shared.ALL_ROLES).toContain('gestor_impuestos');
  });

  it('catálogo PAGES idéntico entre API, web y la fuente única', async () => {
    const apiPerms = await import('../../src/shared/permissions.js');
    const webPerms = await import('../../../web/src/lib/permissions');
    const shared = await import('@operaciones/shared-types');
    const sharedKeys = Object.keys(shared.PAGES).sort();
    expect(Object.keys(apiPerms.PAGES).sort()).toEqual(sharedKeys);
    expect(Object.keys(webPerms.PAGES).sort()).toEqual(sharedKeys);
    // Las 4 páginas LAFT extendidas deben existir en ambos lados (raíz del drift F2).
    for (const slug of ['laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard']) {
      expect(apiPerms.PAGES).toHaveProperty(slug);
      expect(webPerms.PAGES).toHaveProperty(slug);
    }
  });

  it('los defaults de cada rol son slugs válidos del catálogo', async () => {
    const shared = await import('@operaciones/shared-types');
    for (const role of shared.USER_ROLES) {
      for (const slug of shared.ROLE_DEFAULT_PAGES[role]) {
        expect(shared.isValidPage(slug)).toBe(true);
      }
    }
  });

  it('auditor → read-only LAFT (4 páginas) + vistas FLITO de solo lectura (migración D-2)', () => {
    const pages = getEffectivePages({ role: 'auditor' }).sort();
    expect(pages).toEqual([
      'dashboard', 'laft_audit_plan', 'laft_dashboard', 'laft_manual', 'laft_oficial',
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_revisiones', 'flito_compuerta', 'flito_parametrizacion', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
    ].sort());
  });

  it('roles FLITO → páginas por defecto correctas', () => {
    // El operador FLITO ES admin: admin obtiene TODAS las páginas (incluidas las FLITO).
    const admin = getEffectivePages({ role: 'admin' });
    for (const p of ['flito_tramites', 'soat', 'flito_tablero', 'clients', 'transito_organismos']) {
      expect(admin).toContain(p);
    }
    // Gestor de impuestos: portal acotado.
    const gi = getEffectivePages({ role: 'gestor_impuestos' }).sort();
    expect(gi).toEqual(['dashboard', 'flito_impuestos'].sort());
  });
});
