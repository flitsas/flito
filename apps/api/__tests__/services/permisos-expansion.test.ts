// HU #13429 (diseño §5-quater.1) — El resolutor en CADENA, puro: `efectivo(n) = marcado(n) ∧ efectivo(padre(n))`
// en elemento → ítem → acción (→ anidada), la excepción del usuario según la opción A (P-25), opcionales y
// transversales, y el `nodo` del 409. TCs de `docs/qa/hu-13429-tcs.md`: TC-10, TC-11, TC-12, TC-14, TC-15.
//
// Mutantes nombrados:
//   · `efectivoDeNodos` sin mirar el padre (`p === null || efectivo(p)` → `true`) → cae «tabla de verdad 1∧2∧3».
//   · `expandir` que vuelve a aceptar un código suelto (fallo abierto) → cae «una operación absorbida suelta no entra».
//   · aplicar la excepción DESPUÉS de la cadena (conceder una acción la habilita sin su ítem) → cae TC-12.
import { describe, it, expect } from 'vitest';
import {
  alternativasDe, ancestrosDe, claseDe, efectivoDeNodos, expandir, nodoDesmarcado, nodoRevocado, PADRE,
} from '../../src/modules/permisos/arbol/expansion.js';

/** El conjunto efectivo de un usuario: `expandir((R ∪ C) \ V, V)`, como `conjuntoEfectivo`. */
function efectivo(rol: string[], conceder: string[] = [], revocar: string[] = []): Set<string> {
  const m = new Set([...rol, ...conceder]);
  for (const r of revocar) m.delete(r);
  return expandir(m, revocar);
}

const EXPORTAR = ['menu.gestion', 'pagina.flito_soat', 'accion.soat.exportar'];

describe('la cadena del árbol', () => {
  it('menu.* → pagina.* → accion.* → anidada; los elementos no cuelgan de nadie', () => {
    expect(ancestrosDe('accion.soat.exportar_pago')).toEqual(['accion.soat.exportar', 'pagina.flito_soat', 'menu.gestion']);
    expect(ancestrosDe('accion.pesv_plan.administrar')).toEqual(['pagina.pesv_plan', 'menu.pesv']);
    expect(PADRE.get('menu.gestion')).toBeNull();
    expect(PADRE.has('menu.ayuda')).toBe(false); // derivada: no es un permiso
    expect(claseDe('vehicles.vehiculos.consultar')).toBe('transversal');
    expect(claseDe('vehicles.propietario.ver_documento')).toBe('opcional');
    expect(claseDe('soat.excel.exportar')).toBeNull();
  });
});

describe('AC7 / TC-14 — tabla de verdad: la acción es efectiva ⇔ niveles 1 ∧ 2 ∧ 3 marcados', () => {
  it.each([
    [[true, true, true], true], [[false, true, true], false], [[true, false, true], false], [[true, true, false], false],
  ] as const)('marcados %j → %s', (marcas, esperado) => {
    const m = EXPORTAR.filter((_, i) => marcas[i]);
    expect(efectivo(m).has('soat.excel.exportar')).toBe(esperado);
    expect(efectivoDeNodos(m).has('accion.soat.exportar')).toBe(esperado);
  });

  it('la anidada exige también a su madre: «Exportar con pago» sin «Exportar» no vale', () => {
    expect(efectivo([...EXPORTAR, 'accion.soat.exportar_pago']).has('soat.excel.exportar_pago')).toBe(true);
    expect(efectivo(['menu.gestion', 'pagina.flito_soat', 'accion.soat.exportar_pago']).has('soat.excel.exportar_pago')).toBe(false);
  });

  it('una operación absorbida marcada suelta NO entra (fallo cerrado); un transversal sí, sin cadena', () => {
    expect(efectivo(['soat.excel.exportar']).has('soat.excel.exportar')).toBe(false);
    expect(efectivo(['vehicles.vehiculos.consultar']).has('vehicles.vehiculos.consultar')).toBe(true);
  });

  it('un opcional vale solo si su acción o su ítem antiguo es efectivo', () => {
    const op = 'vehicles.propietario.ver_documento';
    expect(efectivo(['menu.gestion', 'pagina.vehicles', op]).has(op)).toBe(true);
    expect(efectivo(['pagina.vehicles', op]).has(op)).toBe(false);
    // Si lo declaran dos acciones, basta una (`siigo.conceptos.confirmar`: «Ver» o «Mapeo de conceptos»).
    const ver = ['menu.finanzas', 'pagina.siigo_parametrizacion', 'accion.facturacion_parametrizacion.ver'];
    expect(efectivo([...ver, 'siigo.conceptos.confirmar']).has('siigo.conceptos.confirmar')).toBe(true);
  });
});

describe('AC4 / TC-10 y AC5 / TC-11 — desmarcar el nivel 1 o 2 corta lo de dentro y al volver lo recupera exacto', () => {
  const rol = [...EXPORTAR, 'accion.soat.ver_listado', 'menu.flota', 'pagina.fleet', 'menu.pesv', 'pagina.pesv_plan', 'accion.pesv_plan.administrar'];
  const antes = efectivo(rol);

  it('TC-10: sin `menu.gestion` caen la página y sus acciones; el resto del rol sigue; al remarcar, idéntico', () => {
    const sin = efectivo(rol.filter((c) => c !== 'menu.gestion'));
    for (const c of ['pagina.flito_soat', 'accion.soat.exportar', 'soat.excel.exportar', 'soat.cola.ver']) expect(sin.has(c), c).toBe(false);
    expect(sin.has('fleet.flota.administrar')).toBe(true);
    expect([...efectivo([...rol.filter((c) => c !== 'menu.gestion'), 'menu.gestion'])].sort()).toEqual([...antes].sort());
  });

  it('TC-11: sin `pagina.flito_soat` caen sus acciones; con el ítem de vuelta, idéntico', () => {
    const sin = efectivo(rol.filter((c) => c !== 'pagina.flito_soat'));
    expect(sin.has('menu.gestion')).toBe(true);
    expect(sin.has('soat.excel.exportar')).toBe(false);
    expect([...efectivo([...rol.filter((c) => c !== 'pagina.flito_soat'), 'pagina.flito_soat'])].sort()).toEqual([...antes].sort());
  });
});

describe('AC2 — un ítem antiguo concede todo, sin transitorio marcado', () => {
  it('Flota expande `fleet.flota.administrar`; Órdenes de trabajo, también el pago manual (P-14)', () => {
    expect(efectivo(['menu.flota', 'pagina.fleet']).has('fleet.flota.administrar')).toBe(true);
    const ordenes = efectivo(['menu.mantenimiento', 'pagina.maintenance_ordenes']);
    expect(ordenes.has('maintenance.ordenes.administrar')).toBe(true);
    expect(ordenes.has('liquidacion.pago_manual.administrar')).toBe(true);
  });

  it('P-24 A1: el ítem PESV da la pantalla; la administración, solo su acción «Administrar»', () => {
    const solo = efectivo(['menu.pesv', 'pagina.pesv_plan']);
    expect(solo.has('pagina.pesv_plan')).toBe(true);
    expect(solo.has('pesv.plan.administrar')).toBe(false);
    expect(efectivo(['menu.pesv', 'pagina.pesv_plan', 'accion.pesv_plan.administrar']).has('pesv.plan.administrar')).toBe(true);
  });
});

describe('AC7 / TC-15 y TC-12 — opción A (P-25): la excepción entra en M y después manda la cadena', () => {
  it('TC-15: `revocar menu.gestion` apaga todo Gestión aunque el rol lo tenga', () => {
    expect(efectivo(EXPORTAR, [], ['menu.gestion']).has('soat.excel.exportar')).toBe(false);
  });

  it('TC-15: `conceder` del elemento que el rol no tiene enciende lo que el rol ya marca debajo', () => {
    const rol = ['pagina.flito_soat', 'accion.soat.exportar'];
    expect(efectivo(rol).has('soat.excel.exportar')).toBe(false);
    expect(efectivo(rol, ['menu.gestion']).has('soat.excel.exportar')).toBe(true);
  });

  it('TC-12: `conceder` de una acción cuyo ítem no tiene NO la habilita', () => {
    expect(efectivo(['menu.gestion'], ['accion.soat.exportar']).has('soat.excel.exportar')).toBe(false);
    expect(efectivo(['menu.gestion'], ['accion.soat.exportar', 'pagina.flito_soat']).has('soat.excel.exportar')).toBe(true);
  });

  it('revocar una operación suelta (transversal) sigue valiendo, al final', () => {
    expect(efectivo(['vehicles.vehiculos.consultar'], [], ['vehicles.vehiculos.consultar']).has('vehicles.vehiculos.consultar')).toBe(false);
  });
});

describe('AC8 — alternativas con cadena y `nodo` del 409', () => {
  it('las cuatro funciones de administración: cada una con su cadena hasta `menu.administracion`', () => {
    expect(alternativasDe('pagina.users')).toEqual([['pagina.users', 'menu.administracion']]);
    expect(alternativasDe('usuarios.usuario.editar')).toEqual([['accion.usuarios.editar', 'pagina.users', 'menu.administracion']]);
    expect(alternativasDe('pagina.roles_permisos')).toEqual([['pagina.roles_permisos', 'menu.administracion']]);
    expect(alternativasDe('permisos.cuadro.guardar')).toEqual([['accion.roles_permisos.asignar', 'pagina.roles_permisos', 'menu.administracion']]);
  });

  it('`nodo` = el eslabón más alto que falta en lo pedido; el que la petición revoca, en el PATCH', () => {
    const todo = new Set(['menu.administracion', 'pagina.users', 'accion.usuarios.editar']);
    expect(nodoDesmarcado('usuarios.usuario.editar', todo)).toBeUndefined();
    expect(nodoDesmarcado('usuarios.usuario.editar', new Set(['pagina.users', 'accion.usuarios.editar']))).toBe('menu.administracion');
    expect(nodoDesmarcado('usuarios.usuario.editar', new Set(['menu.administracion', 'accion.usuarios.editar']))).toBe('pagina.users');
    expect(nodoRevocado('pagina.users', new Set(['menu.administracion']))).toBe('menu.administracion');
    expect(nodoRevocado('pagina.users', new Set())).toBeUndefined();
  });
});
