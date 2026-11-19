// HU #13941 (Feature #13695, decisión de David Chica del 2026-10-24) — El permiso «Dr. Flit» y sus cuatro funciones.
// AC1 (árbol), AC2 (reparto de la 0254, plegado sin base, dos pasadas; rol nuevo), AC4 (403 + intento denegado) y
// AC8 (`/permisos/mios` expone las `drflit.*`). AC3/AC5/AC6 viven en autorizacion/casos-soporte/chat y en los
// `*-buscar.test.ts`; la migración contra PostgreSQL, en la verificación P6 del HANDOFF.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const intentoMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: (...a: unknown[]) => { intentoMock(...a); return Promise.resolve(); },
}));

const { ARBOL_PERMISOS, FUNCIONES_DRFLIT, USER_ROLES } = await import('@operaciones/shared-types');
const { ACCIONES_ARBOL, ACCIONES_UNIVERSALES, ancestrosDe, expandir } = await import('../../../src/modules/permisos/arbol/expansion.js');
const { sqlRepartoDrFlit, sqlSiembraDrFlit } = await import('../../../src/modules/permisos/arbol/sql-dr-flit.js');
const { catalogoCompleto } = await import('../../../src/modules/permisos/catalogo.js');
const { bloqueGenerado, leerRepartoSembrado, MIGRACIONES_CON_REPARTO, repartoDeSql } = await import('../../helpers/permisos-seed-sql.js');
const { registrarUsuarioDePrueba } = await import('../../helpers/auth.js');
const { SignJWT } = await import('jose');

const MIGRACIONES = join(fileURLToPath(new URL('.', import.meta.url)), '../../../src/db/migrations');
const ARCHIVO = '0254_flito_dr_flit_permiso_funciones.sql';
const SQL = readFileSync(join(MIGRACIONES, ARCHIVO), 'utf8');

const ITEM = 'pagina.flito_dr_flit';
const VER = 'accion.dr_flit.ver_manuales';
const SOLO_ADMIN = ['accion.dr_flit.usar_ia', 'accion.dr_flit.consultar_gestion', 'accion.dr_flit.radicar_soporte'];

describe('AC1 — el ítem «Dr. Flit» con sus cuatro acciones en el árbol', () => {
  it('ítem `pagina.flito_dr_flit` bajo `menu.general` (orden 20) y cuatro acciones hijas en orden', () => {
    const item = ARBOL_PERMISOS.find((n) => n.codigo === ITEM)!;
    expect(item).toMatchObject({ tipo: 'item', padre: 'menu.general', orden: 20, slug: 'flito_dr_flit' });
    expect(ARBOL_PERMISOS.filter((n) => n.padre === ITEM).map((n) => [n.codigo, n.tipo, n.orden])).toEqual([
      [VER, 'accion', 10],
      ['accion.dr_flit.usar_ia', 'accion', 20],
      ['accion.dr_flit.consultar_gestion', 'accion', 30],
      ['accion.dr_flit.radicar_soporte', 'accion', 40],
    ]);
  });

  it('cada acción concede su operación `drflit.*`; solo «Ver los manuales» es de reparto universal', () => {
    expect(ACCIONES_ARBOL[VER]).toMatchObject({ operaciones: [FUNCIONES_DRFLIT.verManuales], predecesores: [], repartoUniversal: true });
    expect(ACCIONES_ARBOL['accion.dr_flit.usar_ia']!.operaciones).toEqual([FUNCIONES_DRFLIT.usarIa]);
    expect(ACCIONES_ARBOL['accion.dr_flit.consultar_gestion']!.operaciones).toEqual([FUNCIONES_DRFLIT.consultarGestion]);
    expect(ACCIONES_ARBOL['accion.dr_flit.radicar_soporte']!.operaciones).toEqual([FUNCIONES_DRFLIT.radicarSoporte]);
    for (const a of SOLO_ADMIN) expect(ACCIONES_ARBOL[a]!.repartoUniversal, a).toBeUndefined();
    expect(ACCIONES_UNIVERSALES).toContainEqual({ accion: VER, pagina: ITEM });
  });

  it('concedibles: el catálogo las tiene (ítem y acciones) y NO siembra las operaciones `drflit.*` (nacen absorbidas)', () => {
    const cat = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    expect(cat.get(ITEM)).toMatchObject({ tipo: 'pagina', padre: 'menu.general', nivel: 2, orden: 20 });
    expect([...cat.get(ITEM)!.roles].sort()).toEqual([...USER_ROLES].sort());
    expect([...cat.get(VER)!.roles].sort()).toEqual([...USER_ROLES].sort());
    for (const a of SOLO_ADMIN) expect(cat.get(a)!.roles, a).toEqual(['admin']);
    for (const op of Object.values(FUNCIONES_DRFLIT)) expect(cat.has(op), op).toBe(false);
  });

  it('marcar la acción (con su cadena) expande a su operación', () => {
    const efectivo = expandir([VER, ...ancestrosDe(VER)]);
    expect(efectivo.has(FUNCIONES_DRFLIT.verManuales)).toBe(true);
    expect(efectivo.has(FUNCIONES_DRFLIT.usarIa)).toBe(false);
  });
});

describe('AC2 — reparto inicial de la 0254 (plegado sin base)', () => {
  const plegado = leerRepartoSembrado();

  it('la 0254 está en el pliegue y su bloque generado es EXACTAMENTE la salida del generador', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(bloqueGenerado(SQL)).toBe(`${sqlSiembraDrFlit()}\n\n${sqlRepartoDrFlit()}`);
    // Ni una operación `drflit.*` sembrada en `permisos_funciones`.
    for (const op of Object.values(FUNCIONES_DRFLIT)) expect(SQL).not.toContain(`('${op}'`);
  });

  it('todos los roles con el ítem + «Ver los manuales» (y su elemento); admin con las cuatro; nadie más con IA/gestión/soporte', () => {
    expect([...plegado.keys()].sort()).toEqual([...USER_ROLES].sort());
    for (const [rol, codigos] of plegado) {
      for (const c of [ITEM, VER, 'menu.general']) expect(codigos.has(c), `${rol} ${c}`).toBe(true);
      for (const a of SOLO_ADMIN) expect(codigos.has(a), `${rol} ${a}`).toBe(rol === 'admin');
    }
  });

  it('idempotente: una segunda pasada de la 0254 no cambia el reparto', () => {
    const dos = repartoDeSql([...MIGRACIONES_CON_REPARTO, ARCHIVO].map((m) => readFileSync(join(MIGRACIONES, m), 'utf8')));
    expect(new Map([...dos].map(([r, s]) => [r, [...s].sort()]))).toEqual(new Map([...plegado].map(([r, s]) => [r, [...s].sort()])));
  });

  it('un rol creado después nace con el ítem + «Ver los manuales» y su elemento (`crearRol` → `ACCIONES_UNIVERSALES`)', () => {
    const porDefecto = new Set(ACCIONES_UNIVERSALES.flatMap((u) => [u.accion, ...ancestrosDe(u.accion)]));
    for (const c of [VER, ITEM, 'menu.general']) expect(porDefecto.has(c), c).toBe(true);
    for (const a of SOLO_ADMIN) expect(porDefecto.has(a), a).toBe(false);
  });
});

// ── Rutas: /permisos/mios (AC8) y el 403 de una función (AC4) ─────────────────────────────────────
const { default: permisosRoutes } = await import('../../../src/modules/permisos/permisos.routes.js');
const { default: drFlitRoutes } = await import('../../../src/modules/flito-dr-flit/dr-flit.routes.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/permisos', permisosRoutes);
  a.use('/api/flito/dr-flit', drFlitRoutes);
  return a;
}

/** Un usuario con EXACTAMENTE lo que la 0254 (y todo el pliegue) le deja a su rol. */
async function comoRol(sub: number, rol: string): Promise<string> {
  await registrarUsuarioDePrueba(sub, {
    rol, tipoEnlace: 'ninguno', funcionesDelRol: [...leerRepartoSembrado().get(rol)!], excepciones: [],
  });
  return `Bearer ${await new SignJWT({ username: 'u', role: rol }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub)).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))}`;
}

beforeEach(() => intentoMock.mockReset());

describe('AC8 — /permisos/mios expone las funciones drflit.*', () => {
  it('un rol no admin (financiera) ve `drflit.manuales.ver` y no `drflit.ia.usar`; admin ve las cuatro', async () => {
    const f = await request(app()).get('/api/permisos/mios').set('Authorization', await comoRol(13941_001, 'financiera'));
    expect(f.status).toBe(200);
    expect(f.body.funciones).toContain('drflit.manuales.ver');
    expect(f.body.funciones).toContain(ITEM);
    for (const op of ['drflit.ia.usar', 'drflit.gestion.consultar', 'drflit.soporte.radicar']) expect(f.body.funciones).not.toContain(op);
    const a = await request(app()).get('/api/permisos/mios').set('Authorization', await comoRol(13941_002, 'admin'));
    for (const op of Object.values(FUNCIONES_DRFLIT)) expect(a.body.funciones, op).toContain(op);
  });
});

describe('AC4 — sin la función: 403 drflit-funcion-no-habilitada y el intento queda en permisos_intentos_denegados', () => {
  it('POST /chat de un rol sin «Usar la IA» → 403 con `funcion`, e intento denegado con el código y la ruta', async () => {
    const auth = await comoRol(13941_003, 'conductor');
    const r = await request(app()).post('/api/flito/dr-flit/chat').set('Authorization', auth).send({ mensaje: 'hola', historial: [] });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: 'Su rol no tiene habilitada la IA de Dr. Flit.', codigo: 'drflit-funcion-no-habilitada', funcion: 'drflit.ia.usar',
    });
    expect(intentoMock).toHaveBeenCalledTimes(1);
    expect(intentoMock.mock.calls[0]![0]).toMatchObject({
      userId: 13941_003, rol: 'conductor', codigo: 'drflit.ia.usar', metodo: 'POST', ruta: '/api/flito/dr-flit/chat',
    });
  });

  it('POST /casos-soporte de un rol sin «Radicar casos de soporte» → 403 drflit e intento denegado', async () => {
    const r = await request(app()).post('/api/flito/dr-flit/casos-soporte').set('Authorization', await comoRol(13941_004, 'auditor')).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'drflit-funcion-no-habilitada', funcion: 'drflit.soporte.radicar' });
    expect(intentoMock.mock.calls[0]![0]).toMatchObject({ codigo: 'drflit.soporte.radicar', ruta: '/api/flito/dr-flit/casos-soporte' });
  });
});
