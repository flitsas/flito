import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { getEffectivePages, isValidPage, paginasPorDefecto, requirePage } from '../../src/shared/permissions.js';
// HU #12169 — la tabla de defaults y la tupla de los doce, para el caso «ninguna regresión» del AC5.
import { ROLE_DEFAULT_PAGES, USER_ROLES } from '@operaciones/shared-types';
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
    // `flito_soat` se SUMÓ a `soat` en el Feature #11912 (portal FLITO con slug propio). Que las dos
    // sigan aquí es el AC4 por el lado del gestor: no pierde ninguna de las pantallas que abría.
    expect(pages.sort()).toEqual(['dashboard', 'soat', 'flito_soat'].sort());
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

  // HU #12081 AC4 — Este caso decía «admin → todas las páginas, ignora allowedPages», y era la
  // prueba del comodín que esta HU retira. Ahora afirma lo contrario, y a propósito: en el módulo
  // PURO `admin` ya no es especial. Sus páginas se las repone `permisos_rol_funcion`, y quien lo
  // comprueba contra la base es `__tests__/db/migracion-0179.test.ts`.
  it('admin ya NO tiene comodín: en el módulo puro es un rol más', () => {
    expect(getEffectivePages({ role: 'admin' })).toEqual([]);
    expect(getEffectivePages({ role: 'admin', allowedPages: ['users', 'laft'] }).sort())
      .toEqual(['laft', 'users']);
    // La otra mitad del mismo atajo: la fila `admin` de la tabla tampoco existe.
    expect(ROLE_DEFAULT_PAGES.admin).toBeUndefined();
    expect(paginasPorDefecto('admin')).toEqual([]);
  });
});

describe('requirePage — autorización server-side por página', () => {
  // HU #12082: `requirePage` es `exigirFuncion('pagina.<slug>')` y decide con `resolverPermisos(sub)`,
  // que aquí lee del registro del helper (`testToken` registra al usuario). Ya no hay `allowedPages`
  // en `req.user` que mirar: el mutante «volver a getEffectivePages(req.user)» deja estos casos rojos.
  const next = vi.fn();

  it('user con la página vía allowedPages (users.allowed_pages) → next()', async () => {
    next.mockClear();
    await testToken({ sub: 31, role: 'proveedor', allowedPages: ['transito'] });
    const req = { user: { sub: 31, username: 'u', role: 'proveedor' as UserRole } } as unknown as Request;
    const res = mockRes();
    await requirePage('transito')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('user SIN la página (ni rol ni allowedPages) → 403 con el cuerpo unificado de exigirFuncion', async () => {
    next.mockClear();
    await testToken({ sub: 32, role: 'proveedor', allowedPages: [] });
    const req = { user: { sub: 32, username: 'u', role: 'proveedor' as UserRole } } as unknown as Request;
    const res = mockRes();
    await requirePage('transito')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ funcion: 'pagina.transito', motivo: expect.any(String) });
  });

  it('un `allowedPages` en req.user (token viejo) NO decide: el registro manda', async () => {
    next.mockClear();
    await testToken({ sub: 33, role: 'proveedor', allowedPages: [] });
    const req = { user: { sub: 33, username: 'u', role: 'proveedor' as UserRole, allowedPages: ['transito'] } } as unknown as Request;
    const res = mockRes();
    await requirePage('transito')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('sin req.user → 401', async () => {
    next.mockClear();
    const req = {} as Request;
    const res = mockRes();
    await requirePage('transito')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('authMiddleware — el JWT ya no lleva allowedPages y, si lo trae, se ignora (HU #12082)', () => {
  it('token del helper → req.user SIN allowedPages; requirePage decide con el registro y permite', async () => {
    const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
    const token = await testToken({ sub: 34, role: 'proveedor', allowedPages: ['transito'] });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).not.toHaveProperty('allowedPages');

    const res2 = mockRes();
    const next2 = vi.fn();
    await requirePage('transito')(req, res2, next2);
    expect(next2).toHaveBeenCalledOnce();
  });

  it('token con un claim allowedPages manipulado → el claim no llega a req.user y la página se niega igual', async () => {
    const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
    const { SignJWT } = await import('jose');
    await testToken({ sub: 35, role: 'proveedor', allowedPages: [] }); // lo que la base dice
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const manipulado = await new SignJWT({ username: 'u', role: 'proveedor', allowedPages: ['transito'] })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('35').setExpirationTime('1h').sign(secret);
    const req = { headers: { authorization: `Bearer ${manipulado}` } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).not.toHaveProperty('allowedPages');

    // 'transito' NO está en defaults de proveedor ni en el registro → 403
    const res2 = mockRes();
    const next2 = vi.fn();
    await requirePage('transito')(req, res2, next2);
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
    // 8 base + `gestor_impuestos` + `mensajero` (FLITO) + `financiera` + `cliente` (#11912).
    // El antiguo `operaciones` se fusionó en `admin`.
    expect(shared.USER_ROLES).toHaveLength(12);
    expect(shared.ALL_ROLES).toContain('auditor');
    // AC4 de la HU #11913: el catálogo que el producto OFRECE no incluye `operaciones`. El valor
    // sigue existiendo en el enum de Postgres (quitarlo obligaría a recrear el tipo) y eso no lo
    // vuelve asignable: `z.enum(ALL_ROLES)` del alta de usuarios sale de aquí.
    expect(shared.ALL_ROLES).not.toContain('operaciones');
    expect(shared.ALL_ROLES).toContain('gestor_impuestos');
    expect(shared.ALL_ROLES).toContain('cliente');
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
      // HU #12081: la tabla es PARCIAL y `admin` no tiene fila. `?? []` y no un `!`: si mañana falta
      // otra fila, lo que debe ponerse rojo es el caso de abajo, no reventar aquí con un TypeError.
      for (const slug of shared.ROLE_DEFAULT_PAGES[role] ?? []) {
        expect(shared.isValidPage(slug)).toBe(true);
      }
    }
    // Y las once que SÍ están, están: la parcialidad es de `admin` y de nadie más.
    const sinFila = shared.USER_ROLES.filter((r) => shared.ROLE_DEFAULT_PAGES[r] === undefined);
    expect(sinFila).toEqual(['admin']);
  });

  it('auditor → read-only LAFT (4 páginas) + vistas FLITO de solo lectura (migración D-2)', () => {
    const pages = getEffectivePages({ role: 'auditor' }).sort();
    expect(pages).toEqual([
      'dashboard', 'laft_audit_plan', 'laft_dashboard', 'laft_manual', 'laft_oficial',
      // #11912: `flito_soat` se SUMA a `soat`, no la sustituye. El auditor lee exactamente las
      // mismas pantallas que antes de la HU #11913.
      'flito_tramites', 'soat', 'flito_soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones', 'flito_compuerta', 'clients', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
      // HU #10967: el reporte consolida datos que el auditor ya ve uno a uno.
      'finanzas_reporte_costos',
      // HU #11287: ver la parametrización que respalda una factura emitida es parte de auditar.
      // El backend le concede lectura en las tres rutas de Siigo; la pantalla no le deja escribir.
      'siigo_parametrizacion',
      // HU #11342: la bandeja de operación de facturación electrónica. VER las facturas y su línea
      // de tiempo es auditar; las acciones que las mueven se las niega la tabla de siigo.permisos.ts.
      'siigo_operacion',
    ].sort());
  });

  it('roles FLITO → páginas por defecto correctas', () => {
    // El operador FLITO ES admin y sigue obteniendo TODAS las páginas FLITO, pero desde la HU #12081
    // eso ya no lo dice una rama cableada: lo dice el reparto sembrado. Aquí se comprueba sobre el
    // catálogo que esas páginas EXISTEN y son concedibles; que `admin` las tiene concedidas una a una
    // se comprueba contra la base en `__tests__/db/migracion-0179.test.ts`.
    for (const p of ['flito_tramites', 'soat', 'flito_tablero', 'clients', 'transito_organismos']) {
      expect(isValidPage(p)).toBe(true);
    }
    // Gestor de impuestos: portal acotado.
    const gi = getEffectivePages({ role: 'gestor_impuestos' }).sort();
    expect(gi).toEqual(['dashboard', 'flito_impuestos'].sort());
  });

  // ── AC1 y AC4 de la HU #11913, sobre el catálogo y no sobre la pantalla ──────────────────────
  //
  // Estas tres afirmaciones son la RED de toda la cadena del Feature #11912: si alguien devuelve
  // `ROLE_DEFAULT_PAGES.cliente` a `['soat']` —que es lo que decía el refinamiento y de lo que el
  // ADR-0008 §4 se aparta a propósito—, el `cliente` entra al legado `Soat.tsx` y las dos primeras
  // fallan. No hay ninguna regla en el router que nombre al rol: el AC4 se cumple por construcción,
  // y esto es lo que lo comprueba.
  it('cliente → SOLO el portal FLITO; ni dashboard ni el SOAT legado (AC1/AC4)', () => {
    const pages = getEffectivePages({ role: 'cliente' });
    expect(pages).toEqual(['flito_soat']);
    expect(pages).not.toContain('soat');
    expect(pages).not.toContain('dashboard');
    expect(pages).not.toContain('users');
    expect(pages).not.toContain('clients');
  });

  it('cliente con allowedPages inventadas → sigue sin el legado (la unión no lo cuela)', () => {
    // Un admin no puede concederle `soat` sin saberlo: la página existe, así que `isValidPage` la
    // deja pasar. Lo que esta prueba fija es que no se la da NADIE por defecto — la concesión a mano
    // es una decisión explícita y auditada, no el estado inicial del rol.
    const pages = getEffectivePages({ role: 'cliente', allowedPages: ['no_existe'] });
    expect(pages).toEqual(['flito_soat']);
  });

  it('el portal FLITO tiene slug PROPIO y `soat` deja de estar en dos grupos', async () => {
    const shared = await import('@operaciones/shared-types');
    expect(shared.PAGES).toHaveProperty('flito_soat');
    const grupos = shared.PAGE_GROUPS.filter((g) => g.pages.includes('soat')).map((g) => g.label);
    expect(grupos).toEqual(['Operaciones']);
    const flito = shared.PAGE_GROUPS.find((g) => g.label === 'FLITO (SOAT e Impuestos)')!;
    expect(flito.pages).toContain('flito_soat');
    expect(flito.pages).not.toContain('soat');
  });
});

// ───────── HU #12169 (AC5): la frontera entre lo que es TIPO y lo que es DATO ─────────
//
// `UserRole` deja de ser la fuente de verdad de qué roles existen —eso es la tabla `permisos_roles`—
// y pasa a ser la lista de los doce que el CÓDIGO conoce por su nombre. La consecuencia práctica está
// aquí: `getEffectivePages` recibe un `RoleCode`, que puede ser un rol creado por el administrador.
//
// **Mutante nombrado:** cambiar el `?? []` de `paginasPorDefecto` por `?? Object.keys(PAGES)` deja en
// rojo el primer caso — y es la mutación que de verdad da miedo, porque convierte «rol nuevo sin
// pantallas» en «rol nuevo con TODAS», que es exactamente el fallo por defecto al revés.
describe('paginasPorDefecto — roles como dato (HU #12169, AC5)', () => {
  it('un rol que creó el administrador no tiene defaults: `[]`, no todo', () => {
    expect(paginasPorDefecto('consulta_cliente')).toEqual([]);
    // Y por el camino largo: sus páginas son EXACTAMENTE sus allowedPages, ni una más.
    expect(getEffectivePages({ role: 'consulta_cliente', allowedPages: ['flito_soat'] }))
      .toEqual(['flito_soat']);
    expect(getEffectivePages({ role: 'consulta_cliente' })).toEqual([]);
  });

  it('los doce de sistema devuelven lo MISMO que la tabla, uno por uno (ninguna regresión)', () => {
    for (const rol of USER_ROLES) {
      // HU #12081: `admin` ya no tiene fila, y `paginasPorDefecto` devuelve `[]` por su `?? []`.
      // `toEqual(undefined)` habría fallado; lo correcto es afirmar la equivalencia REAL.
      expect(paginasPorDefecto(rol)).toEqual(ROLE_DEFAULT_PAGES[rol] ?? []);
    }
  });

  it('un rol nuevo NO hereda las páginas de nadie ni por parecido de nombre', () => {
    // `admin_regional` empieza por `admin`: si alguien "optimizara" con un `startsWith` o un
    // `includes`, este caso lo caza. El fallo por defecto es no ver nada.
    expect(paginasPorDefecto('admin_regional')).toEqual([]);
    expect(getEffectivePages({ role: 'admin_regional' })).toEqual([]);
  });

  it('un rol nuevo con páginas concedidas ve solo las VÁLIDAS del catálogo de páginas', () => {
    expect(getEffectivePages({ role: 'rol_nuevo', allowedPages: ['dashboard', 'pagina_que_no_existe'] }))
      .toEqual(['dashboard']);
  });
});
