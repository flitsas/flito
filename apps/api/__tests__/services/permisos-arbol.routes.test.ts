// HU #13429 (diseño §5-quater.5) — El contrato del árbol para el panel de #13430, por HTTP: la estructura
// (`GET /api/permisos/arbol`), el árbol de un rol con `marcado`/`efectivo`/`sinAcciones`, el de un usuario con
// herencia y excepciones, el `PUT` que desmarca un nivel y conserva lo de dentro, y el 409 con `nodo`.
// TCs de `docs/qa/hu-13429-tcs.md`: TC-01, TC-03, TC-10, TC-11, TC-13, TC-17 (forma del 409).
//
// Mutantes nombrados:
//   · `sinAcciones` sobre `efectivo` en vez de `marcado` → cae «un ítem FLITO marcado bajo un elemento desmarcado».
//   · `guardarCuadro` que borra en cascada los hijos del nodo desmarcado → cae «desmarcar el nivel 1 conserva».
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { NodoArbolDef, NodoArbolRol } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { default: permisosRoutes } = await import('../../src/modules/permisos/permisos.routes.js');
const { arbolDeUsuario } = await import('../../src/modules/permisos/permisos-arbol.service.js');
const espia = crearEspia(kdb);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/permisos', permisosRoutes);
  return a;
}
const admin = async () => `Bearer ${await testToken({ role: 'admin', username: 'admin@flit.test' })}`;

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(kdb.db));
});

/** Busca un nodo en el árbol anidado. */
function buscar<T extends { codigo: string; hijos: T[] }>(nodos: T[], codigo: string): T | undefined {
  for (const n of nodos) {
    if (n.codigo === codigo) return n;
    const h = buscar(n.hijos, codigo);
    if (h) return h;
  }
  return undefined;
}

describe('AC1 / TC-01 — GET /arbol: la estructura del árbol sin marcas', () => {
  it('nivel 1 en el orden del menú, «Ayuda» derivada; ítems, acciones (la anidada en nivel 4) y opcionales colgados', async () => {
    const r = await request(app()).get('/api/permisos/arbol').set('Authorization', await admin());
    expect(r.status).toBe(200);
    const arbol = r.body.arbol as NodoArbolDef[];
    const raices = arbol.filter((n) => n.padre === null).sort((a, b) => a.orden - b.orden).map((n) => n.codigo);
    expect(raices).toEqual(['menu.general', 'menu.gestion', 'menu.transito', 'menu.flota', 'menu.mantenimiento', 'menu.pesv',
      'menu.rndc', 'menu.laft', 'menu.finanzas', 'menu.administracion', 'menu.ayuda', 'menu.perfil']);
    const por = new Map(arbol.map((n) => [n.codigo, n]));
    expect(por.get('menu.ayuda')).toMatchObject({ derivado: true, nivel: 1 });
    expect(por.get('pagina.flito_soat')).toMatchObject({ tipo: 'item', padre: 'menu.gestion', nivel: 2 });
    expect(por.get('accion.soat.exportar_pago')).toMatchObject({ tipo: 'accion', padre: 'accion.soat.exportar', nivel: 4 });
    expect(por.get('vehicles.propietario.ver_documento')).toMatchObject({ tipo: 'operacion', opcional: true, padre: 'pagina.vehicles', nivel: 3 });
    expect(por.get('pagina.fleet')).toMatchObject({ tipo: 'item', legado: true, padre: 'menu.flota' });
    // TC-03: los ítems antiguos no tienen nivel 3, salvo «Administrar» en los PESV con operaciones (A1).
    const accionesBajoAntiguos = arbol.filter((n) => n.tipo === 'accion' && por.get(n.padre!)?.legado).map((n) => n.codigo);
    expect(accionesBajoAntiguos.every((c) => /^accion\.pesv_[a-z_]+\.administrar$/.test(c))).toBe(true);
    expect(accionesBajoAntiguos).toHaveLength(20);
    // HU #13588 (AC6) + HU #13589: ya no hay transversales; la respuesta ya no trae el campo.
    expect(r.body).not.toHaveProperty('transversales');
  });
});

describe('AC1, AC4, AC5, AC6 — GET /roles/:codigo/arbol', () => {
  const pedir = async (filas: string[]) => {
    kdb.when.select('permisos_roles', [{ codigo: 'rol_a', nombre: 'Rol A', tipoEnlace: 'ninguno' }])
      .select('permisos_rol_funcion', filas.map((codigo) => ({ codigo })));
    return request(app()).get('/api/permisos/roles/rol_a/arbol').set('Authorization', await admin());
  };

  it('TC-01: marcado y efectivo por nodo, anidado en `hijos` y ordenado', async () => {
    const r = await pedir(['menu.gestion', 'pagina.flito_soat', 'accion.soat.exportar']);
    expect(r.status).toBe(200);
    expect(r.body.rol).toEqual({ codigo: 'rol_a', nombre: 'Rol A', tipoEnlace: 'ninguno' });
    const arbol = r.body.arbol as NodoArbolRol[];
    expect(buscar(arbol, 'accion.soat.exportar')).toMatchObject({ marcado: true, efectivo: true });
    expect(buscar(arbol, 'accion.soat.exportar_pago')).toMatchObject({ marcado: false, efectivo: false });
    expect(buscar(arbol, 'menu.gestion')!.hijos.map((h) => h.codigo)).toContain('pagina.flito_soat');
    expect(buscar(arbol, 'menu.ayuda')).toMatchObject({ derivado: true, marcado: false });
  });

  it('TC-10 (AC4): con `menu.gestion` desmarcado, lo de dentro sigue MARCADO pero no efectivo', async () => {
    const arbol = (await pedir(['pagina.flito_soat', 'accion.soat.exportar'])).body.arbol as NodoArbolRol[];
    expect(buscar(arbol, 'pagina.flito_soat')).toMatchObject({ marcado: true, efectivo: false });
    expect(buscar(arbol, 'accion.soat.exportar')).toMatchObject({ marcado: true, efectivo: false });
  });

  it('TC-11 (AC5): con el ítem desmarcado, sus acciones siguen marcadas e inactivas', async () => {
    const arbol = (await pedir(['menu.gestion', 'accion.soat.exportar'])).body.arbol as NodoArbolRol[];
    expect(buscar(arbol, 'accion.soat.exportar')).toMatchObject({ marcado: true, efectivo: false });
  });

  it('TC-13 (AC6): `sinAcciones` = ítem FLITO marcado sin acción marcada (aunque el elemento esté desmarcado); antiguo nunca', async () => {
    const arbol = (await pedir(['pagina.flito_soat', 'menu.gestion', 'pagina.flito_impuestos', 'accion.impuestos.ver_listado', 'pagina.fleet'])).body.arbol as NodoArbolRol[];
    expect(buscar(arbol, 'pagina.flito_soat')!.sinAcciones).toBe(true);
    expect(buscar(arbol, 'pagina.flito_impuestos')!.sinAcciones).toBe(false);
    expect(buscar(arbol, 'pagina.fleet')!.sinAcciones).toBe(false);
    expect(buscar(arbol, 'pagina.flito_derechos')!.sinAcciones).toBe(false); // no marcado
    const sinElemento = (await pedir(['pagina.flito_soat'])).body.arbol as NodoArbolRol[];
    expect(buscar(sinElemento, 'pagina.flito_soat')).toMatchObject({ sinAcciones: true, efectivo: false });
  });

  it('opcionales: el opcional es efectivo solo con su padre; HU #13588: la antigua transversal no es nodo ni aparte', async () => {
    const r = await pedir(['vehicles.propietario.ver_documento', 'vehicles.vehiculos.consultar']);
    expect(buscar(r.body.arbol as NodoArbolRol[], 'vehicles.propietario.ver_documento')).toMatchObject({ marcado: true, efectivo: false });
    expect(buscar(r.body.arbol as NodoArbolRol[], 'vehicles.vehiculos.consultar')).toBeUndefined();
    expect(r.body).not.toHaveProperty('transversales');
  });

  it('404 si el rol no existe', async () => {
    kdb.when.select('permisos_roles', []);
    const r = await request(app()).get('/api/permisos/roles/nadie/arbol').set('Authorization', await admin());
    expect(r.status).toBe(404);
  });
});

describe('Usuario — heredado de su rol y excepción propia (P-25, opción A)', () => {
  it('conceder una acción sin su ítem: marcada, no efectiva; revocar el elemento apaga lo heredado', async () => {
    kdb.when.select('users', [{ rol: 'rol_a' }])
      .select('permisos_rol_funcion', [{ codigo: 'menu.gestion' }, { codigo: 'menu.flota' }, { codigo: 'pagina.fleet' }])
      .select('permisos_usuario_funcion', [{ codigo: 'accion.soat.exportar', efecto: 'conceder' }, { codigo: 'menu.flota', efecto: 'revocar' }]);
    const r = await arbolDeUsuario(7);
    expect(r).toMatchObject({ userId: 7, rol: 'rol_a' });
    expect(buscar(r.arbol, 'accion.soat.exportar')).toMatchObject({ marcado: true, efectivo: false, heredado: false, excepcion: 'conceder' });
    expect(buscar(r.arbol, 'menu.flota')).toMatchObject({ marcado: false, heredado: true, excepcion: 'revocar' });
    expect(buscar(r.arbol, 'pagina.fleet')).toMatchObject({ marcado: true, efectivo: false, heredado: true, excepcion: null });
  });
});

describe('AC4 / AC5 — PUT …/funciones conserva lo de dentro al desmarcar un nivel', () => {
  it('desmarcar `menu.gestion` escribe el conjunto tal cual llega: los ítems y acciones de dentro siguen guardados', async () => {
    const pedidas = ['pagina.flito_soat', 'accion.soat.exportar', 'accion.soat.exportar_pago'];
    kdb.when.select('permisos_funciones', pedidas.map((codigo) => ({ codigo })))
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }])
      .select('users', [{ n: 1, todas: 1, f0: 1, f1: 1, f2: 1, f3: 1 }])
      .select('permisos_rol_funcion', [...pedidas, 'menu.gestion'].map((codigo) => ({ codigo })));
    const r = await request(app()).put('/api/permisos/roles/rol_a/funciones').set('Authorization', await admin()).send({ funciones: pedidas });
    expect(r.status).toBe(200);
    const escritas = espia.insertsEn('permisos_rol_funcion').flatMap((m) => m.datos as unknown as { funcionCodigo: string }[]).map((f) => f.funcionCodigo);
    expect(escritas.sort()).toEqual([...pedidas].sort());
  });
});

describe('AC8 / TC-17 — el 409 del anti-bloqueo dice además el `nodo` desmarcado (aditivo)', () => {
  it('quitar `menu.administracion` al último rol que administra → 409 con `funcion` y `nodo: menu.administracion`', async () => {
    const pedidas = ['pagina.users', 'pagina.roles_permisos', 'accion.usuarios.editar', 'accion.roles_permisos.asignar'];
    kdb.when.select('permisos_funciones', pedidas.map((codigo) => ({ codigo })))
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }])
      .select('users', [{ n: 1, todas: 0, f0: 0, f1: 0, f2: 0, f3: 0 }])
      .select('permisos_rol_funcion', [...pedidas, 'menu.administracion'].map((codigo) => ({ codigo })));
    const r = await request(app()).put('/api/permisos/roles/admin/funciones').set('Authorization', await admin()).send({ funciones: pedidas });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ funcion: 'pagina.users', nodo: 'menu.administracion' });
  });
});
