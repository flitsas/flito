// HU #12082 AC8 — La frontera del canal externo se dispara por `permisos_roles.tipo_principal`, que
// el resolutor devuelve cacheado, y no por el literal `'cliente'`. Un rol nuevo con tipo externo
// queda dentro sin tocar código; un fallo al leer el tipo NIEGA; y marcarle todas las funciones a un
// rol externo no lo saca de su canal, porque la lista blanca corre antes y no mira el conjunto.
//
// Tasks de QA que fija este fichero: #12271 y #12272. El cuarto mutante de §15 del diseño
// (`!p.ok || externo` → `p.ok && externo`) cae en «un fallo al leer el tipo se trata como externo».

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermisosResueltos } from '../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
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

const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
const { FUNCIONES_DEL_CANAL_EXTERNO, RUTAS_PERMITIDAS_CLIENTE, rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
const { montajesDeFunciones } = await import('../../src/modules/permisos/inventario-guardas.js');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const aqui = path.dirname(fileURLToPath(import.meta.url));
const fuente = (rel: string) => readFileSync(path.resolve(aqui, rel), 'utf8');

/** Los usuarios del laboratorio, por `sub`. El tipo sale de aquí, NUNCA del rol del token. */
const USUARIOS: Record<number, PermisosResueltos> = {
  1: { ok: true, userId: 1, rol: 'cliente', tipoPrincipal: 'externo', funciones: new Set(['pagina.flito_soat']), version: 'a', resueltoEn: new Date() },
  2: { ok: true, userId: 2, rol: 'aseguradora_x', tipoPrincipal: 'externo', funciones: new Set(['pagina.flito_soat']), version: 'b', resueltoEn: new Date() },
  3: { ok: true, userId: 3, rol: 'gestor', tipoPrincipal: 'interno', funciones: new Set(['pagina.dashboard']), version: 'c', resueltoEn: new Date() },
  4: { ok: false, userId: 4, motivo: 'resolucion' },
  // #12272: externo con el catálogo COMPLETO concedido.
  9: { ok: true, userId: 9, rol: 'aseguradora_x', tipoPrincipal: 'externo', funciones: new Set(catalogoCompleto().map((f) => f.codigo)), version: 'z', resueltoEn: new Date() },
};

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
const token = (sub: number, role: string) => new SignJWT({ username: 'u', role })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setIssuedAt().setExpirationTime('1h').sign(secret());

const handler = vi.fn((_req: Request, res: Response) => { res.json({ ok: true }); });

function app(): Express {
  const a = express();
  a.get('/api/auth/me', authMiddleware, handler);
  a.get('/api/permisos/mios', authMiddleware, handler);
  a.get('/api/flito/soat', authMiddleware, handler);
  a.get('/api/vehicles', authMiddleware, handler);
  a.get('/api/users', authMiddleware, handler);
  a.post('/api/flito/soat/enviar', authMiddleware, handler);
  return a;
}

const pide = (metodo: 'get' | 'post', ruta: string, tok: string) => request(app())[metodo](ruta).set('Authorization', `Bearer ${tok}`);

beforeEach(() => {
  handler.mockClear();
  resolverMock.mockReset().mockImplementation(async (id) => USUARIOS[id] ?? { ok: false, userId: id, motivo: 'sin_usuario' });
});

describe('TC #12271 AC8 — la frontera del canal se dispara por permisos_roles.tipo_principal = externo, no por el literal cliente: un rol externo nuevo queda dentro sin tocar código; un fallo al leer el tipo niega', () => {
  it('cliente (externo, como siempre): /auth/me pasa y /vehicles → 403 { error: Sin permisos }', async () => {
    const t = await token(1, 'cliente');
    expect((await pide('get', '/api/auth/me', t)).status).toBe(200);
    const r = await pide('get', '/api/vehicles', t);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
  });

  it('aseguradora_x (externo, creado desde el panel, sin una línea nueva de código): /auth/me pasa y /vehicles → 403', async () => {
    const t = await token(2, 'aseguradora_x');
    expect((await pide('get', '/api/auth/me', t)).status).toBe(200);
    const r = await pide('get', '/api/vehicles', t);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('gestor (interno): las dos pasan', async () => {
    const t = await token(3, 'gestor');
    expect((await pide('get', '/api/auth/me', t)).status).toBe(200);
    expect((await pide('get', '/api/vehicles', t)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('un fallo al leer el tipo (ok:false) se trata como EXTERNO: niega /vehicles y deja pasar /auth/me (mutante: p.ok && externo)', async () => {
    const t = await token(4, 'gestor');
    const r = await pide('get', '/api/vehicles', t);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect((await pide('get', '/api/auth/me', t)).status).toBe(200);
  });

  it('el tipo NO sale del JWT: un token que DICE role=gestor con sub externo sigue fuera, y uno que dice cliente con sub interno entra', async () => {
    expect((await pide('get', '/api/vehicles', await token(2, 'gestor'))).status).toBe(403);
    expect((await pide('get', '/api/vehicles', await token(3, 'cliente'))).status).toBe(200);
    for (const [arg] of resolverMock.mock.calls) expect([2, 3]).toContain(arg);
  });

  it('la guarda ya no compara con el literal: canal-cliente.ts no tiene ROL_CLIENTE ni `role !== \'cliente\'`', () => {
    const src = fuente('../../src/shared/middleware/canal-cliente.ts');
    expect(src).not.toMatch(/ROL_CLIENTE/);
    expect(src).not.toMatch(/role\s*!==\s*'cliente'/);
    expect(src).toMatch(/tipoPrincipal === 'externo'/);
    expect(src).toMatch(/!p\.ok \|\| p\.tipoPrincipal === 'externo'/);
  });
});

describe('TC #12272 AC8 — marcarle TODAS las funciones a un rol externo (CF-13) no lo saca de su canal: la lista blanca sigue mandando y es código, no configuración', () => {
  it('externo con el catálogo completo: /vehicles, /users y POST /flito/soat/enviar → 403; GET /flito/soat pasa la guarda', async () => {
    const t = await token(9, 'aseguradora_x');
    const u = USUARIOS[9]!;
    expect(u.ok && u.funciones.has('pagina.users')).toBe(true);
    expect(u.ok && u.funciones.has('soat.solicitud.crear')).toBe(true);

    expect((await pide('get', '/api/vehicles', t)).status).toBe(403);
    expect((await pide('get', '/api/users', t)).status).toBe(403);
    expect((await pide('post', '/api/flito/soat/enviar', t)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await pide('get', '/api/flito/soat', t)).status).toBe(200);
  });

  it('GET /api/permisos/mios SÍ está en la lista: el canal externo tiene menú', async () => {
    expect(rutaPermitidaParaCliente('GET', '/api/permisos/mios')).toBe(true);
    expect((await pide('get', '/api/permisos/mios', await token(2, 'aseguradora_x'))).status).toBe(200);
    // Y el catálogo entero sigue fuera.
    expect(rutaPermitidaParaCliente('GET', '/api/permisos/funciones')).toBe(false);
  });

  it('RUTAS_PERMITIDAS_CLIENTE es un array congelado, cada entrada lleva su porque, y no se lee de la base', () => {
    expect(Object.isFrozen(RUTAS_PERMITIDAS_CLIENTE)).toBe(true);
    expect(() => { (RUTAS_PERMITIDAS_CLIENTE as unknown as unknown[]).push({}); }).toThrow();
    // El freeze es también de CADA entrada: mutar `patron` lanza (módulo ESM = modo estricto) y no cambia.
    const primera = RUTAS_PERMITIDAS_CLIENTE[0]!;
    const patronOriginal = primera.patron;
    for (const r of RUTAS_PERMITIDAS_CLIENTE) expect(Object.isFrozen(r)).toBe(true);
    expect(() => { (primera as { patron: string }).patron = '.*'; }).toThrow(TypeError);
    expect(primera.patron).toBe(patronOriginal);
    expect(rutaPermitidaParaCliente('GET', '/api/users')).toBe(false);
    for (const r of RUTAS_PERMITIDAS_CLIENTE) expect(r.porque.length).toBeGreaterThan(20);
    const src = fuente('../../src/shared/middleware/canal-cliente.ts');
    expect(src).not.toMatch(/db\/client|db\/schema|permisosRolFuncion/);
  });

  it('ninguna ruta de permisos referencia la lista: el panel no la puede ampliar', () => {
    const src = fuente('../../src/modules/permisos/permisos.routes.ts');
    // El comentario de la ruta la NOMBRA (dice que entra en la lista); lo que no puede haber es un
    // import del módulo ni una escritura. Desde la HU #12084 el fichero SÍ tiene POST/PATCH/PUT/DELETE
    // (roles y su cuadro): lo que sigue vedado es tocar la lista, no escribir.
    expect(src).not.toMatch(/import .*canal-cliente/);
    expect(src).not.toMatch(/RUTAS_PERMITIDAS_CLIENTE\s*[.=[]/);
    // El servicio de roles la LEE (la constante derivada, para el aviso RN-A1) y nada más.
    const servicio = fuente('../../src/modules/permisos/permisos-roles.service.ts');
    expect(servicio).toMatch(/import \{ FUNCIONES_DEL_CANAL_EXTERNO \} from '\.\.\/\.\.\/shared\/middleware\/canal-cliente\.js';/);
    expect(servicio).not.toMatch(/RUTAS_PERMITIDAS_CLIENTE/);
  });
});

// ─────────── HU #12084 (RN-A1): la lista de funciones del canal externo, atada al montaje real ───────────
//
// `PUT /api/permisos/roles/:codigo/funciones` avisa «fuera de su canal» con `FUNCIONES_DEL_CANAL_EXTERNO`,
// que se DERIVA del `funcion` que cada entrada de `RUTAS_PERMITIDAS_CLIENTE` declara. Lo que este bloque
// fija: cada código declarado existe en el catálogo y es EXACTAMENTE el que `exigirFuncion` monta en la
// ruta correspondiente del fuente (por método y ruta relativa a `/api/flito/soat`); las tres entradas
// sin guarda (`/auth/me`, `/permisos/mios`, `/auth/logout`) no declaran ninguna; y son ocho.
// Mutación M12: quitar `funcion: 'soat.cola.ver'` de la lista → rojo aquí (y el PUT empieza a avisar de más).
describe('HU #12084 RN-A1 — FUNCIONES_DEL_CANAL_EXTERNO se deriva de la lista y coincide con la guarda montada', () => {
  const PREFIJO = '/api/flito/soat';
  const conFuncion = RUTAS_PERMITIDAS_CLIENTE.filter((r) => r.funcion !== undefined);
  const sinFuncion = RUTAS_PERMITIDAS_CLIENTE.filter((r) => r.funcion === undefined);

  it('son ocho rutas con función y tres sin ella, y el conjunto derivado son esas ocho', () => {
    expect(conFuncion).toHaveLength(8);
    expect(sinFuncion.map((r) => r.patron).sort()).toEqual(['/api/auth/logout', '/api/auth/me', '/api/permisos/mios']);
    expect([...FUNCIONES_DEL_CANAL_EXTERNO].sort()).toEqual(conFuncion.map((r) => r.funcion!).sort());
    expect(FUNCIONES_DEL_CANAL_EXTERNO.size).toBe(8);
  });

  it('cada función declarada existe en el catálogo como operación', () => {
    const catalogo = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    for (const r of conFuncion) {
      expect(catalogo.get(r.funcion!)?.tipo, `${r.metodo} ${r.patron} → ${r.funcion}`).toBe('operacion');
    }
  });

  it('cada función declarada es la que exigirFuncion monta en esa ruta del fuente (mismo método, misma ruta)', () => {
    const montajes = montajesDeFunciones().filter((m) => m.fichero.startsWith('flito-soat/'));
    for (const r of conFuncion) {
      const ruta = r.patron.slice(PREFIJO.length) || '/';
      const montaje = montajes.find((m) => m.metodo === r.metodo && m.ruta === ruta);
      expect(montaje, `${r.metodo} ${r.patron}: hay una ruta guardada en flito-soat/`).toBeDefined();
      expect(montaje!.codigo, `${r.metodo} ${r.patron}`).toBe(r.funcion);
    }
  });
});
