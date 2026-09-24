// Bug #12869 — el alcance de datos de SOAT lo decide el ENLACE del rol (`permisos_roles.tipo_enlace`),
// no el tipo interno/externo ni el literal del rol.
//
// La fuga: `contextoSoat` solo acotaba a los roles EXTERNOS (por compañía) y al literal `'proveedor'`
// (por proveedor). Cualquier otro rol —un rol INTERNO creado en el panel con enlace `compania`, o uno
// con enlace `proveedor_soat` y otro código— caía en la rama de admin: cola, facetas, detalle, ZIP y
// Excel sin frontera. `organismos_transito` también veía todo.
//
// Cómo se mide: los asertos van sobre los WHERE que la consulta REALMENTE recibe (espía del `where`
// renderizado con el dialecto de Postgres), no sobre las filas que devuelve el mock —que devuelve lo
// que se le diga— ni sobre un predicado exportado renderizado aparte. Donde se llama a
// `condicionesCola` directamente es para fijar la tabla de fronteras; la prueba de que las consultas
// la usan son los bloques de la ruta, del ZIP y del Excel.
//
// Rojo con el código previo (comprobado con `git stash` del src): «interno con enlace compañía»,
// «rol propio con enlace proveedor», «organismos», «externo sin enlace» y «ok:false → nada» caen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, selectDistinct: selectMock,
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn().mockResolvedValue([]),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const wheres: SQL[] = [];
function chainEspia(rows: unknown[]) {
  const t: Record<string, unknown> = {};
  const paso = () => t;
  for (const m of ['from', 'leftJoin', 'innerJoin', 'limit', 'offset', 'orderBy', 'groupBy', 'having', '$dynamic', 'for']) {
    t[m] = paso;
  }
  t.where = (w: SQL) => { wheres.push(w); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows).catch(rej);
  t.finally = (cb: () => void) => Promise.resolve(rows).finally(cb);
  return t;
}
const dialecto = new PgDialect();
const aSql = (w: SQL) => dialecto.sqlToQuery(w);

const svc = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { contextoSoat, condicionesCola, buscarConAcceso, registrosZipSoat, alcanceSoatDe } = svc;
type SoatCtx = Awaited<ReturnType<typeof contextoSoat>>;
const { construirFilasExportSoat } = await import('../../src/modules/flito-soat/flito-soat.export.service.js');
const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');

beforeEach(() => { selectMock.mockReset(); wheres.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const PROV = '11111111-1111-1111-1111-111111111111';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

/** Un rol PROPIO (código libre del panel) con el tipo y el enlace que se pida. */
async function registrar(sub: number, rol: string, tipoPrincipal: 'interno' | 'externo', tipoEnlace: string) {
  await registrarUsuarioDePrueba(sub, {
    rol, tipoPrincipal, tipoEnlace, funcionesDelRol: ['pagina.flito_soat', 'soat.cola.ver'], excepciones: [],
  });
  const t = await new SignJWT({ username: 'u@x.co', role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

const ctxDe = async (sub: number, role: string, usuario: { c?: number | null; p?: string | null } = {}) => {
  selectMock.mockImplementationOnce(() => chainEspia([{ c: usuario.c ?? null, p: usuario.p ?? null }]));
  return contextoSoat({ sub, username: 'u', role });
};

const sqlDe = (conds: SQL[] | null) => {
  if (conds === null) return null;
  return conds.map((c) => aSql(c));
};
const contiene = (conds: SQL[] | null, fragmento: string) => (sqlDe(conds) ?? []).some((q) => q.sql.includes(fragmento));
const params = (conds: SQL[] | null) => (sqlDe(conds) ?? []).flatMap((q) => q.params);

// ─────────── La tabla: enlace → alcance ───────────

describe('Bug #12869 — alcanceSoatDe: el enlace decide, con fallo cerrado', () => {
  const ok = (tipoPrincipal: 'interno' | 'externo', tipoEnlace: string | null) => ({
    ok: true as const, userId: 1, rol: 'x', tipoPrincipal, tipoEnlace: tipoEnlace as never,
    funciones: new Set<string>(), version: 'v', resueltoEn: new Date(),
  });
  it.each([
    ['interno', 'ninguno', 'todo'],
    ['externo', 'ninguno', 'nada'], // excepción transitoria: externo sin enlace no abre
    ['interno', 'compania', 'compania'],
    ['externo', 'compania', 'compania'],
    ['interno', 'proveedor_soat', 'proveedor'],
    ['externo', 'proveedor_soat', 'proveedor'],
    ['interno', 'organismos_transito', 'nada'],
    ['interno', null, 'nada'],
  ] as const)('%s + %s → %s', (tp, te, esperado) => {
    expect(alcanceSoatDe(ok(tp, te))).toBe(esperado);
  });
  it('ok:false → nada', () => {
    expect(alcanceSoatDe({ ok: false, userId: 1, motivo: 'resolucion' })).toBe('nada');
    expect(alcanceSoatDe({ ok: false, userId: 1, motivo: 'sin_usuario' })).toBe('nada');
  });
});

// ─────────── contextoSoat + condicionesCola por enlace ───────────

describe('Bug #12869 — contextoSoat deriva la frontera del enlace', () => {
  it('rol propio INTERNO con enlace compañía → solo su compañía', async () => {
    await registrar(9101, 'aseguradora_interna', 'interno', 'compania');
    const ctx = await ctxDe(9101, 'aseguradora_interna', { c: 7 });
    expect(ctx).toMatchObject({ alcance: 'compania', companiaId: 7, proveedorSoatId: null, externo: false });
    const conds = condicionesCola(ctx, {});
    expect(contiene(conds, '"flito_soat"."compania_id" =')).toBe(true);
    expect(params(conds)).toContain(7);
  });

  it('enlace compañía SIN companiaId → nada', async () => {
    await registrar(9102, 'aseguradora_interna', 'interno', 'compania');
    const ctx = await ctxDe(9102, 'aseguradora_interna', { c: null });
    expect(condicionesCola(ctx, {})).toBeNull();
  });

  it('rol propio con enlace proveedor_soat → exactamente la frontera del gestor', async () => {
    await registrar(9103, 'gestor_soat_b', 'interno', 'proveedor_soat');
    const ctx = await ctxDe(9103, 'gestor_soat_b', { p: PROV });
    expect(ctx).toMatchObject({ alcance: 'proveedor', proveedorSoatId: PROV, companiaId: null });
    const conds = condicionesCola(ctx, {});
    expect(contiene(conds, '"flito_soat"."proveedor_soat_id" =')).toBe(true);
    expect(contiene(conds, '"flito_soat"."gestion_operaciones" =')).toBe(true);
    expect(params(conds)).toContain(PROV);
    expect(params(conds)).toContain('solicitado'); // estado por defecto del gestor
  });

  it('enlace proveedor_soat SIN proveedor → nada', async () => {
    await registrar(9104, 'gestor_soat_b', 'interno', 'proveedor_soat');
    const ctx = await ctxDe(9104, 'gestor_soat_b', { p: null });
    expect(condicionesCola(ctx, {})).toBeNull();
  });

  it('enlace organismos_transito → nada en SOAT (y no lee el usuario)', async () => {
    await registrar(9105, 'transito', 'interno', 'organismos_transito');
    const ctx = await contextoSoat({ sub: 9105, username: 'u', role: 'transito' });
    expect(ctx.alcance).toBe('nada');
    expect(condicionesCola(ctx, {})).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rol externo SIN enlace → nada (excepción transitoria)', async () => {
    await registrar(9106, 'externo_suelto', 'externo', 'ninguno');
    const ctx = await contextoSoat({ sub: 9106, username: 'u', role: 'externo_suelto' });
    expect(condicionesCola(ctx, {})).toBeNull();
  });

  it('resolverPermisos ok:false → nada', async () => {
    fijarFuenteDePermisos(async () => { throw new Error('base caída'); });
    try {
      const ctx = await contextoSoat({ sub: 9107, username: 'u', role: 'admin' });
      expect(ctx.alcance).toBe('nada');
      expect(condicionesCola(ctx, {})).toBeNull();
    } finally {
      fijarFuenteDePermisos(null);
      await testToken({ sub: 1 }); // repone el double compartido del helper
    }
  });

  it('rol propio interno con enlace ninguno → sin frontera de compañía ni proveedor', async () => {
    await registrar(9108, 'analista', 'interno', 'ninguno');
    const ctx = await contextoSoat({ sub: 9108, username: 'u', role: 'analista' });
    const conds = condicionesCola(ctx, {});
    expect(conds).not.toBeNull();
    expect(contiene(conds, 'compania_id" =')).toBe(false);
    expect(contiene(conds, 'proveedor_soat_id" =')).toBe(false);
  });
});

describe('Bug #12869 — regresión de los roles de fábrica', () => {
  it('cliente (externo + compania) → su compañía', async () => {
    await testToken({ sub: 9201, role: 'cliente' as never });
    const ctx = await ctxDe(9201, 'cliente', { c: 5 });
    expect(ctx).toMatchObject({ alcance: 'compania', externo: true, companiaId: 5 });
    const conds = condicionesCola(ctx, {});
    expect(contiene(conds, '"flito_soat"."compania_id" =')).toBe(true);
    expect(params(conds)).toContain(5);
  });

  it('proveedor (enlace proveedor_soat) → frontera del gestor', async () => {
    await testToken({ sub: 9202, role: 'proveedor' as never });
    const ctx = await ctxDe(9202, 'proveedor', { p: PROV });
    expect(ctx).toMatchObject({ alcance: 'proveedor', externo: false, proveedorSoatId: PROV });
    const conds = condicionesCola(ctx, {});
    expect(params(conds)).toContain(PROV);
    expect(contiene(conds, '"flito_soat"."gestion_operaciones" =')).toBe(true);
  });

  it('admin (ninguno) → sin frontera y sin leer el usuario', async () => {
    await testToken({ sub: 9203, role: 'admin' });
    const ctx = await contextoSoat({ sub: 9203, username: 'u', role: 'admin' });
    expect(ctx).toMatchObject({ alcance: 'todo', externo: false, companiaId: null, proveedorSoatId: null });
    const conds = condicionesCola(ctx, {});
    expect(contiene(conds, 'compania_id" =')).toBe(false);
    expect(contiene(conds, 'proveedor_soat_id" =')).toBe(false);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

// ─────────── Las consultas reales reciben esa frontera ───────────

describe('Bug #12869 — la cola HTTP, el ZIP y el Excel reciben la frontera del enlace', () => {
  it('GET /api/flito/soat con rol INTERNO enlace compañía → conteo y página llevan SU compania_id', async () => {
    const auth = await registrar(9301, 'aseguradora_interna', 'interno', 'compania');
    selectMock.mockImplementationOnce(() => chainEspia([{ c: 7, p: null }]));
    selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));
    selectMock.mockImplementationOnce(() => chainEspia([]));
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', auth);
    expect(r.status).toBe(200);
    const deLaCola = wheres.slice(1);
    expect(deLaCola).toHaveLength(2);
    for (const w of deLaCola) {
      const { sql, params: ps } = aSql(w);
      expect(sql).toContain('"flito_soat"."compania_id" =');
      expect(ps).toContain(7);
    }
  });

  it('GET /api/flito/soat con enlace organismos_transito → vacío y ninguna consulta a flito_soat', async () => {
    const auth = await registrar(9302, 'transito_propio', 'interno', 'organismos_transito');
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('ZIP: el WHERE del lote lleva la compañía del rol interno con enlace compañía', async () => {
    await registrar(9303, 'aseguradora_interna', 'interno', 'compania');
    const ctx = await ctxDe(9303, 'aseguradora_interna', { c: 7 });
    wheres.length = 0;
    selectMock.mockImplementationOnce(() => chainEspia([]));
    await registrosZipSoat([PROV], ctx);
    expect(wheres).toHaveLength(1);
    const { sql, params: ps } = aSql(wheres[0]!);
    expect(sql).toContain('"flito_soat"."compania_id" =');
    expect(ps).toContain(7);
  });

  it('ZIP y Excel con alcance nada → vacío sin consultar', async () => {
    const nada: SoatCtx = { userId: 1, username: 'u', role: 'transito', externo: false, alcance: 'nada', proveedorSoatId: null, companiaId: null };
    expect(await registrosZipSoat([PROV], nada)).toEqual([]);
    expect(await construirFilasExportSoat(nada, {})).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('Excel: la consulta base lleva la compañía del rol interno con enlace compañía', async () => {
    await registrar(9304, 'aseguradora_interna', 'interno', 'compania');
    const ctx = await ctxDe(9304, 'aseguradora_interna', { c: 7 });
    wheres.length = 0;
    selectMock.mockImplementation(() => chainEspia([]));
    await construirFilasExportSoat(ctx, {});
    expect(wheres.length).toBeGreaterThanOrEqual(1);
    const { sql, params: ps } = aSql(wheres[0]!);
    expect(sql).toContain('"flito_soat"."compania_id" =');
    expect(ps).toContain(7);
  });
});

describe('Bug #12869 — buscarConAcceso (detalle, historial, soportes) por enlace', () => {
  const fila = (companiaId: number) => ({
    soat: { id: 's1', companiaId, proveedorSoatId: PROV, gestionOperaciones: false, estado: 'solicitado' },
    dentroDeFrontera: true,
  });
  const base: SoatCtx = { userId: 1, username: 'u', role: 'aseguradora_interna', externo: false, alcance: 'compania', proveedorSoatId: null, companiaId: 7 };

  it('interno con enlace compañía: SOAT de OTRA compañía → null (404); de la suya → la fila', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([fila(9)]));
    expect(await buscarConAcceso('s1', base)).toBeNull();
    selectMock.mockImplementationOnce(() => chainEspia([fila(7)]));
    expect(await buscarConAcceso('s1', base)).toMatchObject({ id: 's1', companiaId: 7 });
  });

  it('alcance nada → null aunque la fila exista', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([fila(7)]));
    expect(await buscarConAcceso('s1', { ...base, alcance: 'nada', companiaId: null })).toBeNull();
  });

  it('enlace proveedor con otro código de rol: proveedor ajeno → null; el suyo → la fila', async () => {
    const gestor: SoatCtx = { ...base, role: 'gestor_soat_b', alcance: 'proveedor', companiaId: null, proveedorSoatId: PROV };
    selectMock.mockImplementationOnce(() => chainEspia([{ ...fila(3), soat: { ...fila(3).soat, proveedorSoatId: 'otro' } }]));
    expect(await buscarConAcceso('s1', gestor)).toBeNull();
    selectMock.mockImplementationOnce(() => chainEspia([fila(3)]));
    expect(await buscarConAcceso('s1', gestor)).toMatchObject({ id: 's1' });
  });

  it('admin (todo): cualquier compañía → la fila', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([fila(9)]));
    expect(await buscarConAcceso('s1', { ...base, role: 'admin', alcance: 'todo', companiaId: null })).toMatchObject({ id: 's1' });
  });
});
