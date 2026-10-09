// HU #12875 (Feature #12871, ADR-0024) — La frontera por ENLACE: quién pasa `authMiddleware` hacia qué
// montaje. Sustituye a `canal-cliente.tipo-principal.test.ts` (frontera por `tipo_principal`), cuyos
// casos de lista congelada e inventario se portan aquí (TC-03d, TC-05c) y en el centinela de montajes
// (`frontera-enlace.centinela.test.ts`).
//
// App mínima con el `authMiddleware` REAL (que llama a la `guardiaFrontera` real), el `conAlcance`
// real y el `exigirFuncion` real; solo `resolverPermisos` es un double, por `sub`. Así cada 403 se
// distingue por su ORIGEN: la frontera responde `{ error: 'Sin permisos' }` y el handler no corre;
// `exigirFuncion` responde con `funcion` en el cuerpo. Cada positivo tiene su control negativo con
// el mismo conjunto de funciones cambiando solo el enlace.
//
// Mutantes nombrados (docs/qa/hu-12875-tcs.md): M1 «ruta sin alcance declarado ⇒ next()» (TC-02a,
// TC-03a/b), M3 «`ninguno` tratado como restringido» / «`ok:false` tratado como abierto» (TC-04a/d).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router, type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermisosResueltos } from '../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>()),
  resolverPermisos: (id: number) => resolverMock(id),
}));

const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const {
  conAlcance, RUTAS_TRANSVERSALES, esRutaTransversal, moduloAbiertoA, funcionesAlcanzables, alcanceDe, soloSinEnlace,
} = await import('../../src/shared/middleware/frontera-enlace.js');
const { FRONTERA_POR_ENLACE, MODULOS_FRONTERA } = await import('@operaciones/shared-types');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const aqui = path.dirname(fileURLToPath(import.meta.url));
const fuente = (rel: string) => readFileSync(path.resolve(aqui, '../../src', rel), 'utf8');

/** Todas las funciones que la app de prueba exige: el «catálogo completo» de este laboratorio. */
const TODAS = [
  'soat.cola.ver', 'soat.solicitud.enviar', 'vehicles.vehiculos.consultar', 'impuestos.cola.ver',
  'parametrizacion.companias.listar', 'permisos.rol.listar', 'usuarios.usuarios.listar', 'tablero.tablero.ver',
];
type Enlace = 'ninguno' | 'compania' | 'proveedor' | 'organismos_transito' | null;
const ok = (userId: number, rol: string, tipoEnlace: Enlace, funciones: string[]): PermisosResueltos => ({
  ok: true, userId, rol, tipoEnlace, funciones: new Set(funciones), version: `v${userId}`, resueltoEn: new Date(),
});

/** Los usuarios del laboratorio, por `sub`. El enlace sale de aquí, NUNCA del rol del token. */
const USUARIOS: Record<number, PermisosResueltos> = {
  1: ok(1, 'aseguradora_x', 'compania', TODAS),          // rol creado en el panel, código ≠ cliente
  2: ok(2, 'gestor_x', 'proveedor', TODAS),
  3: ok(3, 'transito_x', 'organismos_transito', TODAS),
  4: ok(4, 'analista', 'ninguno', TODAS),                 // control: mismo conjunto, sin enlace
  5: ok(5, 'analista', 'ninguno', []),                    // sin enlace y SIN funciones
  6: { ok: false, userId: 6, motivo: 'resolucion' },
  7: ok(7, 'raro', null, TODAS),                          // enlace desconocido
  8: ok(8, 'aseguradora_x', 'compania', ['tablero.tablero.ver']), // compañía sin la función del listado
};

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
const token = (sub: number, role = 'admin') => new SignJWT({ username: 'u', role })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setIssuedAt().setExpirationTime('1h').sign(secret());

const handler = vi.fn((_req: Request, res: Response) => { res.json({ ok: true }); });

/** Un router «como los de verdad»: `router.use(authMiddleware)` y una guarda de función por ruta. */
function routerCon(rutas: Array<['get' | 'post' | 'patch', string, string | null]>) {
  const r = Router();
  r.use(authMiddleware);
  for (const [metodo, ruta, funcion] of rutas) {
    if (funcion) r[metodo](ruta, exigirFuncion(funcion), handler);
    else r[metodo](ruta, handler);
  }
  return r;
}

function app(): Express {
  const a = express();
  a.use(express.json());
  // Sesión (transversales): auth por ruta, como `auth.routes.ts` y `users.routes.ts`.
  a.get('/api/auth/me', authMiddleware, handler);
  a.post('/api/auth/logout', authMiddleware, handler);
  a.patch('/api/users/:id/password', authMiddleware, handler);
  a.use('/api/permisos', routerCon([['get', '/mios', null], ['get', '/roles', 'permisos.rol.listar']]));
  a.use('/api/users', routerCon([['get', '/', 'usuarios.usuarios.listar']]));
  // El único módulo abierto en #12875.
  a.use('/api/flito/soat', conAlcance('soat', routerCon([['get', '/', 'soat.cola.ver'], ['post', '/enviar', 'soat.solicitud.enviar']])));
  // Declarados pero cerrados hasta #13426.
  a.use('/api/flito/impuestos', conAlcance('impuestos', routerCon([['get', '/', 'impuestos.cola.ver']])));
  a.use('/api/flito/tablero', conAlcance('tablero', routerCon([['get', '/', 'tablero.tablero.ver']])));
  // Sin declarar: legacy, catálogo y una ruta «nueva» (AC3).
  a.use('/api/vehicles', routerCon([['get', '/', 'vehicles.vehiculos.consultar']]));
  a.use('/api/flito/parametrizacion', routerCon([['get', '/companias', 'parametrizacion.companias.listar']]));
  a.use('/__prueba', routerCon([['get', '/', 'soat.cola.ver']]));
  return a;
}

const pide = async (metodo: 'get' | 'post' | 'patch', ruta: string, sub: number, role?: string) =>
  request(app())[metodo](ruta).set('Authorization', `Bearer ${await token(sub, role)}`).send({});

const esFrontera = (r: { status: number; body: unknown }) => r.status === 403 && JSON.stringify(r.body) === JSON.stringify({ error: 'Sin permisos' });

beforeEach(() => {
  handler.mockClear();
  selectMock.mockReset();
  resolverMock.mockReset().mockImplementation(async (id) => USUARIOS[id] ?? { ok: false, userId: id, motivo: 'sin_usuario' });
});

describe('AC1 — rol de compañía: SOAT abierto; la función sigue decidiendo', () => {
  it('TC-01 (frontera): enlace compañía CON la función → GET /api/flito/soat llega al handler', async () => {
    const r = await pide('get', '/api/flito/soat', 1);
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('TC-01b: el mismo enlace SIN la función del listado → 403 de exigirFuncion (no de la frontera)', async () => {
    const r = await pide('get', '/api/flito/soat', 8);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('soat.cola.ver');
    expect(handler).not.toHaveBeenCalled();
  });

  it('TC-08d (frontera): enlace `proveedor` también alcanza SOAT', async () => {
    expect((await pide('get', '/api/flito/soat', 2)).status).toBe(200);
  });

  it('decisión (d): un rol de compañía con una función de mutación de SOAT llega a la ruta (el acotado lo prueba el servicio)', async () => {
    const r = await pide('post', '/api/flito/soat/enviar', 1);
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('AC2 / AC7 — lo que no está declarado para su enlace, cerrado', () => {
  it('TC-02a / TC-07a: enlace compañía CON la función de vehículos → GET /api/vehicles 403 de la frontera; el handler no corre', async () => {
    const r = await pide('get', '/api/vehicles', 1);
    expect(esFrontera(r)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('TC-02b: control — mismo conjunto, enlace `ninguno` → 200', async () => {
    expect((await pide('get', '/api/vehicles', 4)).status).toBe(200);
  });

  it('TC-02c: enlace compañía con todas las funciones → GET /api/users 403 de la frontera', async () => {
    expect(esFrontera(await pide('get', '/api/users', 1))).toBe(true);
  });

  it('módulo DECLARADO pero cerrado a su enlace hasta #13426 (Impuestos, Tablero) → 403 de la frontera', async () => {
    for (const sub of [1, 2, 3]) {
      expect(esFrontera(await pide('get', '/api/flito/impuestos', sub)), `sub ${sub}`).toBe(true);
      expect(esFrontera(await pide('get', '/api/flito/tablero', sub)), `sub ${sub}`).toBe(true);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('organismos_transito no alcanza SOAT (no está en su lista)', async () => {
    expect(esFrontera(await pide('get', '/api/flito/soat', 3))).toBe(true);
  });
});

describe('AC3 — lo nuevo nace cerrado', () => {
  it.each([[1, 'compania'], [2, 'proveedor'], [3, 'organismos_transito']])(
    'TC-03a/b: montaje sin declarar (`/__prueba`) con la función → 403 para el enlace %s (%s), handler en 0',
    async (sub) => {
      expect(esFrontera(await pide('get', '/__prueba', sub))).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('TC-03c: control — enlace `ninguno` con la función → 200', async () => {
    expect((await pide('get', '/__prueba', 4)).status).toBe(200);
  });

  it('enlace DESCONOCIDO (valor que el código no conoce) → cerrado como un enlace, salvo las transversales', async () => {
    expect(esFrontera(await pide('get', '/api/flito/soat', 7))).toBe(true);
    expect((await pide('get', '/api/auth/me', 7)).status).toBe(200);
  });

  it('TC-03d: la declaración es CÓDIGO: `FRONTERA_POR_ENLACE` congelada, ningún archivo de `permisos/` la modifica', () => {
    expect(Object.isFrozen(FRONTERA_POR_ENLACE)).toBe(true);
    for (const m of MODULOS_FRONTERA) expect(Object.isFrozen(FRONTERA_POR_ENLACE[m]), m).toBe(true);
    expect(() => { (FRONTERA_POR_ENLACE.impuestos as unknown as string[]).push('compania'); }).toThrow();
    // En #12875 SOLO SOAT está abierto, y solo a compañía y proveedor (decisión (b) del PO).
    const abiertos = MODULOS_FRONTERA.filter((m) => FRONTERA_POR_ENLACE[m].length > 0);
    expect(abiertos).toEqual(['soat']);
    expect([...FRONTERA_POR_ENLACE.soat].sort()).toEqual(['compania', 'proveedor']);
    // El panel no la puede ampliar: las rutas de permisos no la importan; el servicio de roles solo
    // LEE `funcionesAlcanzables` para el aviso.
    expect(fuente('modules/permisos/permisos.routes.ts')).not.toMatch(/frontera-enlace|FRONTERA_POR_ENLACE/);
    const servicio = fuente('modules/permisos/permisos-roles.service.ts');
    expect(servicio).toMatch(/import \{ funcionesAlcanzables \} from '\.\.\/\.\.\/shared\/middleware\/frontera-enlace\.js';/);
    expect(servicio).not.toMatch(/FRONTERA_POR_ENLACE/);
  });
});

describe('AC4 — sin enlace decide el permiso', () => {
  it('TC-04a: enlace `ninguno` con las funciones → 200 en un legacy, en SOAT y en un catálogo', async () => {
    for (const ruta of ['/api/vehicles', '/api/flito/soat', '/api/flito/parametrizacion/companias']) {
      expect((await pide('get', ruta, 4)).status, ruta).toBe(200);
    }
  });

  it('TC-04b: enlace `ninguno` SIN las funciones → 403 de exigirFuncion (con `funcion`), no de la frontera', async () => {
    const r = await pide('get', '/api/vehicles', 5);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('vehicles.vehiculos.consultar');
  });

  it('TC-04c: el enlace sale del resolutor, NO del JWT', async () => {
    // El token dice `cliente`, pero el `sub` resuelve a un rol sin enlace → pasa.
    expect((await pide('get', '/api/vehicles', 4, 'cliente')).status).toBe(200);
    // El token dice `admin`, pero el `sub` resuelve a un rol de compañía → cerrado.
    expect(esFrontera(await pide('get', '/api/vehicles', 1, 'admin'))).toBe(true);
  });

  it('TC-04d: `ok:false` → cerrado fuera de las transversales; /auth/me sigue pasando (mutante: «fallo abre»)', async () => {
    expect(esFrontera(await pide('get', '/api/vehicles', 6))).toBe(true);
    expect((await pide('get', '/api/auth/me', 6)).status).toBe(200);
  });
});

describe('AC5 — catálogos y configuración cerrados; la sesión, abierta', () => {
  it('TC-05a: enlace compañía con todo → catálogo (`parametrizacion`) y configuración (`permisos/roles`) 403', async () => {
    expect(esFrontera(await pide('get', '/api/flito/parametrizacion/companias', 1))).toBe(true);
    expect(esFrontera(await pide('get', '/api/permisos/roles', 1))).toBe(true);
  });

  it('TC-05b: /auth/me, /permisos/mios, /auth/logout y la contraseña propia pasan la frontera para todo enlace', async () => {
    for (const sub of [1, 2, 3, 7]) {
      expect((await pide('get', '/api/auth/me', sub)).status, `me ${sub}`).toBe(200);
      expect((await pide('get', '/api/permisos/mios', sub)).status, `mios ${sub}`).toBe(200);
      expect((await pide('post', '/api/auth/logout', sub)).status, `logout ${sub}`).toBe(200);
      expect((await pide('patch', `/api/users/${sub}/password`, sub)).status, `password ${sub}`).toBe(200);
    }
  });

  it('TC-05c: las transversales son un array congelado de cuatro, cada una con su porqué; su forma es exacta', () => {
    expect(RUTAS_TRANSVERSALES.map((r) => `${r.metodo} ${r.patron}`)).toEqual([
      'GET /api/auth/me', 'GET /api/permisos/mios', 'POST /api/auth/logout', 'PATCH /api/users/:id/password',
    ]);
    expect(Object.isFrozen(RUTAS_TRANSVERSALES)).toBe(true);
    for (const r of RUTAS_TRANSVERSALES) expect(Object.isFrozen(r)).toBe(true);
    const primera = RUTAS_TRANSVERSALES[0]!;
    expect(() => { (primera as { patron: string }).patron = '.*'; }).toThrow(TypeError);
    for (const r of RUTAS_TRANSVERSALES) expect(r.porque.length, r.patron).toBeGreaterThan(20);
    // Ni el catálogo de permisos ni otro método/segmento por vecindad.
    expect(esRutaTransversal('GET', '/api/permisos/funciones')).toBe(false);
    expect(esRutaTransversal('PUT', '/api/users/42/password')).toBe(false);
    expect(esRutaTransversal('PATCH', '/api/users/42/password/x')).toBe(false);
    expect(esRutaTransversal('GET', '/api/auth/me?x=1'.split('?')[0]!)).toBe(true);
  });
});

describe('RN-A1 — qué funciones alcanza cada enlace (el aviso del panel)', () => {
  it('`ninguno` alcanza todo; compañía y proveedor solo SOAT; organismos nada (hasta #13426)', () => {
    expect(funcionesAlcanzables('ninguno')('impuestos.cola.ver')).toBe(true);
    expect(funcionesAlcanzables('compania')('soat.cola.ver')).toBe(true);
    expect(funcionesAlcanzables('compania')('impuestos.cola.ver')).toBe(false);
    expect(funcionesAlcanzables('proveedor')('soat.solicitud.reversar')).toBe(true);
    expect(funcionesAlcanzables('organismos_transito')('soat.cola.ver')).toBe(false);
    // `soat.antiguo.*` es del módulo legacy `operaciones` del catálogo, no de SOAT: cerrado.
    expect(funcionesAlcanzables('compania')('soat.antiguo.operar')).toBe(false);
    expect(funcionesAlcanzables('compania')('no.existe.nada')).toBe(false);
  });

  it('`moduloAbiertoA` es la tabla: nada abre a `ninguno` ni a `null` (no pasan por aquí)', () => {
    expect(moduloAbiertoA('soat', 'compania')).toBe(true);
    expect(moduloAbiertoA('soat', 'organismos_transito')).toBe(false);
    expect(moduloAbiertoA(undefined, 'compania')).toBe(false);
    expect(moduloAbiertoA('soat', null)).toBe(false);
  });

  it('cada módulo de `FRONTERA_POR_ENLACE` existe como módulo del catálogo de funciones', () => {
    const modulos = new Set(catalogoCompleto().map((f) => f.modulo));
    for (const m of MODULOS_FRONTERA) expect(modulos.has(m), m).toBe(true);
  });
});

describe('Enganche de #13426 — `alcanceDe(req)` y `soloSinEnlace()`', () => {
  const req = (sub: number) => ({ user: { sub, username: 'u', role: 'x' } }) as unknown as Request;
  const chain = (filas: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) c[m] = () => c;
    (c as { then: unknown }).then = (res: (v: unknown) => void) => res(filas);
    return c;
  };

  it('compañía: lee `users.compania_id` de la base, con memo por petición (una sola lectura)', async () => {
    selectMock.mockReturnValue(chain([{ c: 7, p: null }]));
    const r = req(1);
    expect(await alcanceDe(r)).toEqual({ enlace: 'compania', companiaId: 7 });
    expect(await alcanceDe(r)).toEqual({ enlace: 'compania', companiaId: 7 });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('`ninguno` no lee nada; `ok:false` → enlace null; organismos → la lista de la puente', async () => {
    expect(await alcanceDe(req(4))).toEqual({ enlace: 'ninguno' });
    expect(await alcanceDe(req(6))).toEqual({ enlace: null });
    expect(selectMock).not.toHaveBeenCalled();
    selectMock.mockReturnValue(chain([{ c: '05001' }, { c: '11001' }]));
    expect(await alcanceDe(req(3))).toEqual({ enlace: 'organismos_transito', organismos: ['05001', '11001'] });
  });

  it('`soloSinEnlace()` cierra una ruta de un router abierto a todo enlace y la deja a `ninguno`', async () => {
    const a = express();
    const r = Router();
    r.use(authMiddleware);
    r.get('/config', soloSinEnlace(), handler);
    a.use('/api/flito/soat', conAlcance('soat', r));
    const pedir = async (sub: number) => request(a).get('/api/flito/soat/config').set('Authorization', `Bearer ${await token(sub)}`);
    expect(esFrontera(await pedir(1))).toBe(true);
    expect((await pedir(4)).status).toBe(200);
  });
});
