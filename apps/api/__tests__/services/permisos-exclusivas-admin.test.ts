// HU #13944 (Feature #13939) — Funciones exclusivas del Administrador: lo que depende de la LISTA del código
// (`FUNCIONES_EXCLUSIVAS_ADMIN`): el catálogo (`catalogoCompleto`), el árbol (`GET /arbol`, `GET /roles/:codigo/arbol`),
// el catálogo agrupado (`GET /funciones`, lee la columna) y la comprobación de arranque (lista ↔ columna, 0253).
//
// En producción la lista está VACÍA (las primeras exclusivas nacen con sus rutas en #13945/#13954). Para probar el
// mecanismo sin dejar código de test en producción, este archivo sustituye la lista con `vi.mock` por una función de
// prueba que ya existe y que el reparto de partida solo da a `admin` (`accion.clientes.autogestion`).
// Las escrituras (409 en el cuadro, en `crearRol` y en las excepciones por usuario) leen la columna y viven en
// `permisos-roles.routes.test.ts` y `users.routes.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { NodoArbolDef, NodoArbolRol } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const EXCLUSIVA = 'accion.clientes.autogestion';
const lista = vi.hoisted(() => ({ exclusivas: ['accion.clientes.autogestion'] as string[] }));

vi.mock('../../src/modules/permisos/catalogo-operaciones.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/permisos/catalogo-operaciones.js')>();
  return { ...actual, FUNCIONES_EXCLUSIVAS_ADMIN: lista.exclusivas };
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { default: permisosRoutes } = await import('../../src/modules/permisos/permisos.routes.js');
const { catalogoCompleto, CatalogoIncoherenteError } = await import('../../src/modules/permisos/catalogo.js');
const { verificarCatalogoAlArrancar, ArranquePermisosError } = await import('../../src/modules/permisos/permisos.service.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/permisos', permisosRoutes);
  return a;
}
const admin = async () => `Bearer ${await testToken({ role: 'admin', username: 'admin@flit.test' })}`;

beforeEach(() => {
  kdb.reset();
  lista.exclusivas.splice(0, lista.exclusivas.length, EXCLUSIVA);
});

function aplanar<T extends { hijos: T[] }>(nodos: T[]): T[] {
  return nodos.flatMap((n) => [n, ...aplanar(n.hijos)]);
}

describe('AC5 — el catálogo y el árbol traen `exclusivaAdmin`', () => {
  it('catalogoCompleto marca la exclusiva y solo ella; su reparto de partida es [admin]', () => {
    const cat = catalogoCompleto();
    const marcadas = cat.filter((f) => f.exclusivaAdmin);
    expect(marcadas.map((f) => f.codigo)).toEqual([EXCLUSIVA]);
    expect(marcadas[0]!.roles).toEqual(['admin']);
  });

  it('GET /arbol: el nodo de la exclusiva trae `exclusivaAdmin: true` y el resto `false`', async () => {
    const r = await request(app()).get('/api/permisos/arbol').set('Authorization', await admin());
    expect(r.status).toBe(200);
    const arbol = r.body.arbol as NodoArbolDef[];
    expect(arbol.find((n) => n.codigo === EXCLUSIVA)).toMatchObject({ exclusivaAdmin: true });
    const resto = arbol.filter((n) => n.codigo !== EXCLUSIVA);
    expect(resto.length).toBeGreaterThan(0);
    expect(resto.every((n) => n.exclusivaAdmin === false)).toBe(true);
  });

  it('GET /roles/:codigo/arbol: el nodo anidado hereda la marca', async () => {
    kdb.when.select('permisos_roles', [{ codigo: 'admin', nombre: 'Administrador', tipoEnlace: 'ninguno' }])
      .select('permisos_rol_funcion', [{ codigo: EXCLUSIVA }]);
    const r = await request(app()).get('/api/permisos/roles/admin/arbol').set('Authorization', await admin());
    expect(r.status).toBe(200);
    const nodos = aplanar(r.body.arbol as NodoArbolRol[]);
    expect(nodos.find((n) => n.codigo === EXCLUSIVA)).toMatchObject({ exclusivaAdmin: true, marcado: true });
    expect(nodos.filter((n) => n.exclusivaAdmin).map((n) => n.codigo)).toEqual([EXCLUSIVA]);
  });

  it('GET /funciones: cada función del catálogo agrupado trae `exclusivaAdmin` (de la columna): true la exclusiva, false el resto', async () => {
    kdb.when.select('permisos_funciones', [
      { codigo: EXCLUSIVA, modulo: 'clientes', nombreNegocio: 'Habilitar o revocar la autogestión del cliente', descripcion: 'd', tipo: 'accion', exclusivaAdmin: true },
      { codigo: 'accion.clientes.crear_editar_clientes', modulo: 'clientes', nombreNegocio: 'Crear y editar clientes', descripcion: 'd', tipo: 'accion', exclusivaAdmin: false },
    ]);
    const r = await request(app()).get('/api/permisos/funciones').set('Authorization', await admin());
    expect(r.status).toBe(200);
    const funciones = (r.body.grupos as { funciones: { codigo: string; exclusivaAdmin: boolean }[] }[]).flatMap((g) => g.funciones);
    expect(funciones.map((f) => [f.codigo, f.exclusivaAdmin])).toEqual([
      [EXCLUSIVA, true], ['accion.clientes.crear_editar_clientes', false],
    ]);
  });
});

describe('la lista del código es coherente con el catálogo', () => {
  it('una exclusiva que no existe en el catálogo → CatalogoIncoherenteError que la nombra', () => {
    lista.exclusivas.push('clients.clientes.no_existe');
    expect(() => catalogoCompleto()).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoCompleto()).toThrow(/no está en el catálogo: clients\.clientes\.no_existe/);
  });

  it('una exclusiva cuyo reparto de partida no es solo [admin] → CatalogoIncoherenteError', () => {
    const compartida = catalogoCompleto().find((f) => f.roles.length > 1)!;
    lista.exclusivas.push(compartida.codigo);
    expect(() => catalogoCompleto()).toThrow(new RegExp(`debe ser \\[admin\\]\\): ${compartida.codigo.replace(/\./g, '\\.')}`));
  });
});

describe('arranque — la columna `exclusiva_admin` (0253) coincide con la lista del código', () => {
  const filasAlDia = (marcadas: string[]) => catalogoCompleto().map((f) => ({ codigo: f.codigo, modulo: f.modulo, exclusivaAdmin: marcadas.includes(f.codigo) }));

  it('con la base al día (la exclusiva marcada) no protesta', async () => {
    kdb.when.select('permisos_funciones', filasAlDia([EXCLUSIVA]));
    await expect(verificarCatalogoAlArrancar()).resolves.toBeUndefined();
  });

  it('la base sin la marca (falta la migración) → ArranquePermisosError que nombra la función y la 0253', async () => {
    kdb.when.select('permisos_funciones', filasAlDia([]));
    const e = await verificarCatalogoAlArrancar().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArranquePermisosError);
    expect((e as Error).message).toMatch(/El código las declara exclusivas y la base no: accion\.clientes\.autogestion/);
    expect((e as Error).message).toMatch(/0253_permisos_funciones_exclusiva_admin\.sql/);
  });

  it('la base marca de más una función que el código no declara exclusiva → ArranquePermisosError que la nombra', async () => {
    kdb.when.select('permisos_funciones', filasAlDia([EXCLUSIVA, 'accion.clientes.crear_editar_clientes']));
    await expect(verificarCatalogoAlArrancar()).rejects.toThrow(/La base las marca exclusivas y el código no: accion\.clientes\.crear_editar_clientes/);
  });
});
