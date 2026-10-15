// HU #13588 (Feature #13416, Épica #13411; P-35..P-37) — Ningún permiso suelto fuera del menú. Las 5 operaciones
// TRANSVERSALES de la #13429 se conceden con su ítem: `vehicles.vehiculos.consultar` con Vehículos, SOAT, Flota y
// Trámite Digital; las búsquedas RUNT/Fasecolda con Trámite Digital; `rum.resumen.ver` con Administración ·
// Rendimiento (ítem nuevo). Resolutor puro, catálogo del código, la 0240 en memoria (reporte en seco) y las guardas
// por HTTP contra el motor real (`exigirFuncion` → `resolverPermisos`, filas del double o fijadas a mano).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, fuenteDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

const { ARBOL_PERMISOS, PAGE_GROUPS, PAGES } = await import('@operaciones/shared-types');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');
const {
  CODIGOS_ABSORBIDOS, SUELTAS_INCORPORADAS_13588, alternativasDe, claseDe, expandir,
} = await import('../../src/modules/permisos/arbol/expansion.js');
const { informeSueltos, repartirSueltos } = await import('../../src/modules/permisos/arbol/reparto-sueltos.js');
const { arbolDef, arbolDeUsuario } = await import('../../src/modules/permisos/permisos-arbol.service.js');
const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');

const VEH = 'vehicles.vehiculos.consultar';
const BUSQUEDAS = ['runt.persona.consultar', 'runt.cedula.leer', 'integraciones.fasecolda.buscar'];
const RUM = 'rum.resumen.ver';

let app: any;
beforeEach(async () => {
  selectMock.mockReset();
  selectMock.mockImplementation(() => chain([]));
  fijarFuenteDePermisos(fuenteDePrueba);
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

async function jwt(sub: number, rol: string): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return `Bearer ${await new SignJWT({ username: `u${sub}`, role: rol }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub)).setExpirationTime('1h').sign(secret)}`;
}

describe('AC1 — `vehicles.vehiculos.consultar` llega con su ítem, sin casilla propia', () => {
  it.each([
    ['Vehículos', ['menu.gestion', 'pagina.vehicles']],
    ['SOAT (antiguo)', ['menu.gestion', 'pagina.soat']],
    ['Flota (decisión del 2026-10-15: «si está en varios módulos, en cada uno»)', ['menu.flota', 'pagina.fleet']],
    ['Trámite Digital', ['menu.gestion', 'pagina.tramite']],
  ])('rol con solo %s + cadena → la tiene', (_n, marcados) => {
    expect(expandir(marcados).has(VEH)).toBe(true);
  });

  it('sin casilla propia: no es nodo, ni opcional, ni va aparte; ya no se concede directo', () => {
    expect(claseDe(VEH)).toBeNull();
    expect(CODIGOS_ABSORBIDOS.has(VEH)).toBe(true);
    expect(ARBOL_PERMISOS.some((n) => n.codigo === VEH)).toBe(false);
    expect(alternativasDe(VEH).map((a) => a[0]).sort()).toEqual(['pagina.fleet', 'pagina.soat', 'pagina.tramite', 'pagina.vehicles']);
  });

  it('el ítem sin su elemento no la da (la cadena manda)', () => {
    expect(expandir(['pagina.vehicles']).has(VEH)).toBe(false);
  });
});

describe('AC2 — Trámite Digital trae las búsquedas RUNT y Fasecolda', () => {
  it('rol con solo Trámite Digital + cadena → las tres', () => {
    const e = expandir(['menu.gestion', 'pagina.tramite']);
    for (const b of BUSQUEDAS) expect(e.has(b), b).toBe(true);
  });

  it('ningún otro ítem las da: Vehículos, SOAT y Flota no', () => {
    const e = expandir(['menu.gestion', 'pagina.vehicles', 'pagina.soat', 'menu.flota', 'pagina.fleet']);
    for (const b of BUSQUEDAS) expect(e.has(b), b).toBe(false);
    for (const b of BUSQUEDAS) expect(alternativasDe(b).map((a) => a[0]), b).toEqual(['pagina.tramite']);
  });
});

describe('AC3 — una fila directa heredada ya no da nada (fallo cerrado)', () => {
  it.each([VEH, ...BUSQUEDAS, RUM])('%s marcada sin su ítem → no entra', (codigo) => {
    expect(expandir(['menu.gestion', 'menu.administracion', 'pagina.users', codigo]).has(codigo)).toBe(false);
  });

  it('la ruta que la exige responde 403 aunque el rol tenga la fila directa (fuente sin cadena)', async () => {
    fijarFuenteDePermisos(async () => ({
      rol: 'rol_heredado', tipoEnlace: 'ninguno', excepciones: [],
      funcionesDelRol: ['menu.administracion', 'pagina.users', 'menu.gestion', 'pagina.dashboard', VEH, RUM, ...BUSQUEDAS],
    }));
    const auth = await jwt(9201, 'rol_heredado');
    const v = await request(app).get('/api/vehicles').set('Authorization', auth);
    expect(v.status).toBe(403);
    expect(v.body).toMatchObject({ funcion: VEH });
    const f = await request(app).get('/api/fasecolda/buscar?marca=x').set('Authorization', auth);
    expect(f.status).toBe(403);
    expect(f.body).toMatchObject({ funcion: 'integraciones.fasecolda.buscar' });
    const r = await request(app).get('/api/rum/summary').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: RUM });
  });
});

describe('AC4 — la excepción de usuario que revoca el ítem se lleva la operación', () => {
  it('rol con «Vehículos» + revocar `pagina.vehicles` → sin `vehicles.vehiculos.consultar`', () => {
    const delRol = ['menu.gestion', 'pagina.vehicles'];
    expect(expandir(delRol).has(VEH)).toBe(true);
    const m = delRol.filter((c) => c !== 'pagina.vehicles');
    expect(expandir(m, ['pagina.vehicles']).has(VEH)).toBe(false);
  });

  it('por HTTP: el mismo usuario recibe 403 en el listado de vehículos', async () => {
    await registrarUsuarioDePrueba(9202, {
      rol: 'gestor_vehiculos', tipoEnlace: 'ninguno', funcionesDelRol: ['menu.gestion', 'pagina.vehicles'],
      excepciones: [{ codigo: 'pagina.vehicles', efecto: 'revocar' }],
    });
    const r = await request(app).get('/api/vehicles').set('Authorization', await jwt(9202, 'gestor_vehiculos'));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: VEH });
  });
});

describe('AC5 — «Rendimiento» (Administración) da el resumen RUM', () => {
  it('el ítem existe en el árbol bajo Administración, sin nivel 3, y su página es concedible', () => {
    expect(ARBOL_PERMISOS.find((n) => n.codigo === 'pagina.admin_rendimiento'))
      .toMatchObject({ tipo: 'item', padre: 'menu.administracion', nombre: 'Rendimiento', slug: 'admin_rendimiento' });
    expect(ARBOL_PERMISOS.filter((n) => n.padre === 'pagina.admin_rendimiento')).toEqual([]);
    expect(PAGES.admin_rendimiento).toBe('Rendimiento');
    expect(PAGE_GROUPS.find((g) => g.label === 'Administración')!.pages).toContain('admin_rendimiento');
    expect(alternativasDe(RUM)).toEqual([['pagina.admin_rendimiento', 'menu.administracion']]);
  });

  it('rol con Rendimiento + cadena → GET /api/rum/summary 200', async () => {
    await registrarUsuarioDePrueba(9203, { rol: 'analista', tipoEnlace: 'ninguno', funcionesDelRol: ['pagina.admin_rendimiento'], excepciones: [] });
    selectMock.mockImplementation(() => chain([{ total: 0 }]));
    const r = await request(app).get('/api/rum/summary').set('Authorization', await jwt(9203, 'analista'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, totalRows: 0 });
  });

  it('rol sin Rendimiento pero con los demás ítems de Administración → 403', async () => {
    await registrarUsuarioDePrueba(9204, {
      rol: 'administrador_parcial', tipoEnlace: 'ninguno', excepciones: [],
      funcionesDelRol: ['pagina.users', 'pagina.roles_permisos', 'pagina.siigo_credenciales', 'pagina.privacy', 'accion.usuarios.ver', 'accion.roles_permisos.ver'],
    });
    const r = await request(app).get('/api/rum/summary').set('Authorization', await jwt(9204, 'administrador_parcial'));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: RUM });
  });
});

describe('AC6 — todo código concedible es nodo, opcional u operación de ítem/acción; `transversales: []`', () => {
  it('el catálogo del arranque no lanza y no deja ninguna operación sin padre', () => {
    const cat = catalogoCompleto();
    expect(cat.filter((f) => f.tipo === 'operacion' && !f.padre).map((f) => f.codigo)).toEqual([]);
    for (const f of cat.filter((x) => x.tipo === 'operacion')) expect(claseDe(f.codigo), f.codigo).toBe('opcional');
    for (const s of SUELTAS_INCORPORADAS_13588) expect(cat.some((f) => f.codigo === s), s).toBe(false);
    expect(cat.find((f) => f.codigo === 'pagina.admin_rendimiento')).toMatchObject({ tipo: 'pagina', padre: 'menu.administracion', nivel: 2, orden: 40 });
  });

  it('la estructura del panel de roles mantiene el campo `transversales`, vacío', () => {
    expect(arbolDef().transversales).toEqual([]);
  });

  it('el árbol de un usuario (excepciones) también devuelve `transversales: []`', async () => {
    selectMock.mockImplementationOnce(() => chain([{ rol: 'admin' }]));
    const u = await arbolDeUsuario(7);
    expect(u.transversales).toEqual([]);
    expect(u.arbol.length).toBeGreaterThan(0);
  });
});

describe('AC7 — la 0240 en memoria y su reporte en seco: toda pérdida nombrada con su rol', () => {
  const usuarios = [{ id: 1, rol: 'admin' }, { id: 2, rol: 'flota' }, { id: 3, rol: 'suelto' }, { id: 4, rol: 'admin' }, { id: 5, rol: 'admin' }];
  const antes = {
    filasRol: [
      ...['menu.gestion', 'pagina.vehicles', 'menu.administracion', RUM, VEH].map((codigo) => ({ rol: 'admin', codigo })),
      ...['menu.flota', 'pagina.fleet', VEH].map((codigo) => ({ rol: 'flota', codigo })),
      ...['menu.general', 'pagina.dashboard', VEH, 'runt.cedula.leer'].map((codigo) => ({ rol: 'suelto', codigo })),
    ],
    filasUsuario: [
      { userId: 4, codigo: RUM, efecto: 'revocar' as const },
      { userId: 5, codigo: VEH, efecto: 'revocar' as const },
    ],
  };

  it('reparto: quien tenía RUM recibe el ítem; las 5 salen de rol y de usuario; el `revocar` RUM pasa al ítem', () => {
    const d = repartirSueltos(usuarios, antes);
    expect(d.filasRol.filter((f) => f.rol === 'admin').map((f) => f.codigo).sort())
      .toEqual(['menu.administracion', 'menu.gestion', 'pagina.admin_rendimiento', 'pagina.vehicles']);
    expect(d.filasRol.some((f) => SUELTAS_INCORPORADAS_13588.includes(f.codigo))).toBe(false);
    expect(d.filasUsuario).toEqual([{ userId: 4, codigo: 'pagina.admin_rendimiento', efecto: 'revocar' }]);
  });

  it('informe: el rol sin el ítem pierde (nombrado); Flota no pierde; admin gana solo la pantalla Rendimiento', () => {
    const i = informeSueltos(usuarios, antes);
    const rol = (r: string) => i.roles.find((x) => x.rol === r)!;
    expect(rol('suelto')).toMatchObject({ usuarios: 1, pierde: ['runt.cedula.leer', VEH], gana: [] });
    expect(rol('flota')).toMatchObject({ pierde: [], gana: [] });
    expect(rol('admin')).toMatchObject({ usuarios: 3, pierde: [], gana: ['pagina.admin_rendimiento'] });
    // Usuario 4: tenía RUM revocado y lo sigue sin ver. Usuario 5: su revocación de la consulta se pierde → la gana.
    expect(i.usuarios.map((u) => u.userId)).toEqual([5]); // el 4 no cambia: no sale
    expect(i.usuarios.find((u) => u.userId === 5)).toMatchObject({ rol: 'admin', gana: ['pagina.admin_rendimiento', VEH] });
    expect(i.perdidas).toBe(2);
    expect(i.otrasGanancias).toBe(1);
  });
});
