// HU #13428 (Feature #13416 F3, ADR-0025; diseño §5-ter) — Catálogo de Administración, Clientes y proveedores,
// Bitácora, General y Perfil en tres niveles, y paso de los permisos existentes. Sin base: el catálogo del
// código, el reparto en memoria (lo mismo que la 0237) y la partida real = las migraciones 0001..0235 plegadas.
//
// Mutantes nombrados (para QA B):
//   · quitar `lectura: true` de «Ver clientes y proveedores» → cae AC5 (auditor y financiera no la reciben).
//   · quitar `repartoUniversal` de «Cambiar mi contraseña» → cae AC5 (solo admin la recibe) y AC1 del catálogo de roles.
//   · quitar `predecesores` de «Datos fiscales» → cae AC6 (la operación nueva no existe en el plano) y AC5 de admin.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const { ARBOL_ADMINISTRACION, ARBOL_CLIENTES_Y_BITACORA, ARBOL_GENERAL, ARBOL_PERFIL, ARBOL_PERMISOS, USER_ROLES } = await import('@operaciones/shared-types');
const { catalogoCompleto, catalogoPlano, catalogoOperacionesNuevas } = await import('../../src/modules/permisos/catalogo.js');
const { OPERACIONES_DECLARADAS } = await import('../../src/modules/permisos/catalogo-operaciones.js');
const { montajesDeFunciones } = await import('../../src/modules/permisos/inventario-guardas.js');
const { ACCIONES_ADMINISTRACION, AREA_ADMINISTRACION, PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION } = await import('../../src/modules/permisos/arbol/acciones-administracion.js');
const {
  ACCIONES_LECTURA, ACCIONES_POR_AREA, ACCIONES_UNIVERSALES, CODIGOS_ABSORBIDOS, OPCIONALES_ARBOL, ROL_CON_TODAS_LAS_ACCIONES,
  expandir, operacionesDe, predecesoresDe,
} = await import('../../src/modules/permisos/arbol/expansion.js');
const { efectivasExpandidas, informeArbol, repartirPorTodos } = await import('../../src/modules/permisos/arbol/reparto-arbol.js');
const { leerRepartoSembrado, MIGRACIONES_CON_REPARTO } = await import('../helpers/permisos-seed-sql.js');

const AREA = ACCIONES_POR_AREA.administracion;

/**
 * AC1 — El catálogo aprobado, LITERAL (propuesta del 2026-10-07 con los [+]; Clientes y Bitácora en Gestión por
 * la decisión del 9-oct; «Ver clientes y proveedores» de P-21; Ayuda sin permiso propio).
 */
const ANEXO = `
Administración → Usuarios: Ver usuarios · Crear usuario · Editar usuario · Cambiar la contraseña de otro usuario · Desactivar o reactivar · Dar de baja (eliminar) · Ver el historial · Exportar a Excel · Cerrar sesiones
Administración → Roles y permisos: Ver roles · Crear rol · Editar rol · Asignar permisos · Eliminar rol
Gestión → Clientes y proveedores: Ver clientes y proveedores · Crear y editar clientes · Crear y editar proveedores · Habilitar o revocar la autogestión del cliente · Elegir proveedor de SOAT sin trámite · Datos fiscales · Activar o desactivar clientes · Eliminar clientes · Activar o desactivar proveedores
Gestión → Bitácora: Ver la bitácora
General → Tablero: Ver (solo ver)
Perfil → Perfil: Ver mis datos · Cambiar mi contraseña
`.trim().split('\n');

// «Rendimiento» (HU #13588) no es del catálogo aprobado de la #13428: lo cubre `permisos-arbol-sueltos.test.ts`.
const FUERA = new Set(['pagina.siigo_credenciales', 'pagina.admin_rendimiento']);
const ARBOL = [
  ...ARBOL_ADMINISTRACION.filter((n) => !FUERA.has(n.codigo) && !FUERA.has(n.padre ?? '')),
  ...ARBOL_CLIENTES_Y_BITACORA, ...ARBOL_GENERAL, ...ARBOL_PERFIL,
];
const NOMBRE_ELEMENTO = new Map(ARBOL_PERMISOS.filter((n) => n.tipo === 'elemento').map((n) => [n.codigo, n.nombre]));

describe('AC1 — el catálogo es exactamente la lista aprobada', () => {
  it('elemento → ítem → acciones, en orden y con el nombre literal', () => {
    const lineas = ARBOL.filter((n) => n.tipo === 'item').map((it) => {
      const acciones = ARBOL.filter((n) => n.tipo === 'accion' && n.padre === it.codigo).sort((x, y) => x.orden - y.orden);
      return `${NOMBRE_ELEMENTO.get(it.padre!)} → ${it.nombre}: ${acciones.map((a) => a.nombre).join(' · ')}`;
    });
    expect(lineas).toEqual(ANEXO);
  });

  // HU #13945: +1 («Activar o desactivar clientes», exclusiva del Administrador, nacida tras la siembra).
  // HU #13954: +1 («Eliminar clientes», ídem). HU #13958: +1 («Activar o desactivar proveedores»).
  it('el catálogo del código emite las 27 acciones (nivel 3) y marca nivel 2 a los 6 ítems; los códigos son los del mapeo', () => {
    const accionesArbol = ARBOL.filter((n) => n.tipo === 'accion').map((n) => n.codigo).sort();
    expect(accionesArbol).toHaveLength(27);
    expect(accionesArbol).toEqual([...AREA]);
    const cat = catalogoCompleto();
    const delCatalogo = cat.filter((f) => f.tipo === 'accion' && AREA.includes(f.codigo));
    expect(delCatalogo.map((f) => f.codigo).sort()).toEqual(accionesArbol);
    for (const f of delCatalogo) expect(f.nivel, f.codigo).toBe(3);
    const items = ARBOL.filter((n) => n.tipo === 'item').map((n) => n.codigo).sort();
    expect(items).toEqual(['pagina.clients', 'pagina.dashboard', 'pagina.flito_bitacora', 'pagina.perfil', 'pagina.roles_permisos', 'pagina.users']);
    expect(cat.filter((f) => f.nivel === 2 && items.includes(f.codigo)).map((f) => f.codigo).sort()).toEqual(items);
  });

  it('Ayuda no tiene permiso propio (derivada) y su página sigue fuera del catálogo; el Tablero FLITO deja de ser ítem (P-11)', () => {
    expect(ARBOL_PERMISOS.find((n) => n.codigo === 'menu.ayuda')!.derivado).toBe(true);
    const cat = new Set(catalogoCompleto().map((f) => f.codigo));
    expect(cat.has('pagina.flito_ayuda')).toBe(false);
    expect(cat.has('pagina.flito_tablero')).toBe(false);
    expect(expandir(['menu.general', 'pagina.dashboard', 'accion.dashboard.ver']).has('pagina.flito_tablero')).toBe(true); // HU #13429: con su cadena
  });
});

describe('AC6 — cobertura: los 32 códigos del área + 7 nuevos, en los dos sentidos', () => {
  const plano = catalogoPlano();
  const delArea = [...new Set(plano.filter((f) => f.tipo === 'operacion' && AREA_ADMINISTRACION.test(f.codigo)).map((f) => f.codigo))].sort();
  const cubiertas = new Set(AREA.flatMap((a) => [...operacionesDe(a), ...predecesoresDe(a), ...(ACCIONES_ADMINISTRACION[a]!.opcionales ?? [])]));

  it('son 32 en la partida, y cada uno está en ≥1 acción (grupo, predecesor, apoyo u opcional); dos opcionales', () => {
    expect(delArea).toHaveLength(32);
    expect(delArea.filter((c) => !cubiertas.has(c))).toEqual([]);
    // David, 2026-10-13: los catálogos de compañías y de proveedores SOAT son opcionales de «Ver clientes y proveedores».
    expect(AREA.flatMap((a) => ACCIONES_ADMINISTRACION[a]!.opcionales ?? [])).toEqual(['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar']);
    expect(predecesoresDe('accion.clientes.ver')).toEqual(['clients.clientes.ver']);
    for (const op of ['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar']) {
      expect(CODIGOS_ABSORBIDOS.has(op), op).toBe(false);
      expect(catalogoCompleto().some((f) => f.codigo === op), op).toBe(true);
      expect(expandir(['accion.clientes.ver']).has(op), op).toBe(false);
    }
  });

  it('las 7 operaciones nuevas las exige hoy una guarda, no existían en el plano, y su acción tiene la partida como predecesor (o es universal)', () => {
    const nuevas = Object.keys(PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION).sort();
    expect(nuevas).toEqual([
      'clients.clientes.crear', 'clients.clientes.datos_fiscales', 'clients.clientes.editar',
      'parametrizacion.companias.autogestion', 'parametrizacion.companias.soat_sin_tramite',
      'perfil.contrasena.cambiar', 'perfil.datos.ver',
    ]);
    const deHoy = new Set(catalogoOperacionesNuevas().map((f) => f.codigo));
    const montadas = new Set(montajesDeFunciones().map((m) => m.codigo));
    for (const [nueva, partida] of Object.entries(PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION)) {
      expect(deHoy.has(nueva), nueva).toBe(true);
      expect(montadas.has(nueva), nueva).toBe(true);
      expect(plano.some((f) => f.codigo === nueva), nueva).toBe(false);
      const duenas = AREA.filter((a) => (ACCIONES_ADMINISTRACION[a]!.operaciones).includes(nueva));
      expect(duenas, nueva).toHaveLength(1);
      if (!ACCIONES_ADMINISTRACION[duenas[0]!]!.repartoUniversal) expect(predecesoresDe(duenas[0]!), nueva).toContain(partida);
    }
  });

  it('toda operación del área que conceden las acciones tiene guarda viva hoy (o es una página absorbida)', () => {
    const conGuarda = new Set(OPERACIONES_DECLARADAS.map((o) => o.codigo));
    for (const a of AREA) for (const op of operacionesDe(a)) expect(conGuarda.has(op) || op === 'pagina.flito_tablero', `${a} → ${op}`).toBe(true);
  });

  it('se retira el transitorio `clients.clientes.administrar`: nadie lo monta y el catálogo de hoy no lo tiene', () => {
    expect(montajesDeFunciones().filter((m) => m.codigo === 'clients.clientes.administrar')).toEqual([]);
    expect(catalogoCompleto().some((f) => f.codigo === 'clients.clientes.administrar')).toBe(false);
    expect(CODIGOS_ABSORBIDOS.has('clients.clientes.administrar')).toBe(true);
    // Absorbidos también las dos del invariante anti-bloqueo (por eso su cuenta pasa al expandido, AC7).
    expect(CODIGOS_ABSORBIDOS.has('usuarios.usuario.editar')).toBe(true);
    expect(CODIGOS_ABSORBIDOS.has('permisos.cuadro.guardar')).toBe(true);
    // Las páginas de los ítems NO se absorben.
    for (const p of ['pagina.users', 'pagina.roles_permisos', 'pagina.clients', 'pagina.flito_bitacora', 'pagina.dashboard', 'pagina.perfil']) {
      expect(CODIGOS_ABSORBIDOS.has(p), p).toBe(false);
    }
  });
});

describe('Reglas del paso (PO, 2026-10-13): lectura explícita, reparto universal de Perfil', () => {
  it('las acciones de lectura del área son EXACTAMENTE estas (flag explícito)', () => {
    expect(AREA.filter((a) => ACCIONES_LECTURA.has(a))).toEqual([
      'accion.bitacora.ver', 'accion.clientes.ver', 'accion.dashboard.ver', 'accion.perfil.ver_datos',
      'accion.roles_permisos.ver', 'accion.usuarios.ver', 'accion.usuarios.ver_historial',
    ]);
    // «Exportar a Excel» es su única operación: modifica (regla «todos»).
    expect(ACCIONES_LECTURA.has('accion.usuarios.exportar')).toBe(false);
  });

  it('ninguna acción de lectura del área expande a exportar, descargar ni nada que escriba', () => {
    const escribe = /\.(exportar|descargar|crear|editar|guardar|borrar|baja|reactivar|activar|invalidar|cambiar\w*|desbloquear|revocar|administrar|autogestion|soat_sin_tramite|datos_fiscales)$/;
    for (const a of AREA.filter((x) => ACCIONES_LECTURA.has(x))) {
      expect(operacionesDe(a).filter((op) => escribe.test(op)), a).toEqual([]);
    }
  });

  it('P-22: las dos de Perfil (y desde la HU #13941 «Ver los manuales» de Dr. Flit) son las únicas universales, viajan con la página de su ítem y el catálogo las da a los 12 roles', () => {
    expect(ACCIONES_UNIVERSALES).toEqual([
      { accion: 'accion.dr_flit.ver_manuales', pagina: 'pagina.flito_dr_flit' },
      { accion: 'accion.perfil.cambiar_contrasena', pagina: 'pagina.perfil' },
      { accion: 'accion.perfil.ver_datos', pagina: 'pagina.perfil' },
    ]);
    const cat = new Map(catalogoCompleto().map((f) => [f.codigo, f.roles]));
    for (const c of ['accion.perfil.cambiar_contrasena', 'accion.perfil.ver_datos', 'pagina.perfil']) {
      expect([...cat.get(c)!].sort(), c).toEqual([...USER_ROLES].sort());
    }
    expect(OPCIONALES_ARBOL.has('perfil.contrasena.cambiar')).toBe(false);
  });
});

describe('AC4/AC5/AC7 — el paso sobre la partida real (0001..0235 plegadas): roles, excepciones y admin', () => {
  const partida = leerRepartoSembrado(MIGRACIONES_CON_REPARTO.filter((m) => m < '0236'));
  const filasRol = [...partida].flatMap(([rol, cs]) => [...cs].map((codigo) => ({ rol, codigo })));
  const usuarios = [...partida.keys()].map((rol, i) => ({ id: i + 1, rol }));
  const despues = repartirPorTodos(usuarios, { filasRol, filasUsuario: [] }, undefined, AREA);
  const accionesDe = (rol: string) => despues.filasRol.filter((f) => f.rol === rol && AREA.includes(f.codigo)).map((f) => f.codigo.slice('accion.'.length)).sort();

  it('AC7: admin recibe TODAS las acciones del área', () => {
    expect(ROL_CON_TODAS_LAS_ACCIONES).toBe('admin');
    expect(accionesDe('admin')).toEqual(AREA.map((a) => a.slice('accion.'.length)));
  });

  it('AC5: auditor — las lecturas que tenía (historial, bitácora, tablero, clientes) y Perfil; nada que modifique', () => {
    expect(accionesDe('auditor')).toEqual([
      'bitacora.ver', 'clientes.ver', 'dashboard.ver', 'perfil.cambiar_contrasena', 'perfil.ver_datos', 'usuarios.ver_historial',
    ]);
  });

  it('AC5: financiera — «Ver clientes y proveedores» (P-21) y Perfil', () => {
    expect(accionesDe('financiera')).toEqual(['clientes.ver', 'perfil.cambiar_contrasena', 'perfil.ver_datos']);
  });

  it('AC5 (P-22): los demás roles reciben solo Perfil, y `pagina.perfil` llega a todos', () => {
    for (const rol of usuarios.map((u) => u.rol).filter((r) => !['admin', 'auditor', 'financiera'].includes(r))) {
      expect(accionesDe(rol), rol).toEqual(['perfil.cambiar_contrasena', 'perfil.ver_datos']);
    }
    for (const u of usuarios) expect(despues.filasRol.some((f) => f.rol === u.rol && f.codigo === 'pagina.perfil'), u.rol).toBe(true);
  });

  it('AC5: pérdidas y ganancias por rol sobre la partida — nadie pierde y nadie gana (financiera tampoco: compañías y proveedores son opcionales)', () => {
    const i = informeArbol(usuarios, { filasRol, filasUsuario: [] }, undefined, AREA);
    // HU #13945: solo `admin` gana `clients.clientes.estado` («admin tiene todas las acciones»; la acción nació tras la
    // siembra y es exclusiva suya). HU #13954: lo mismo con `clients.clientes.eliminar`; HU #13958, con
    // `parametrizacion.proveedores.estado`. Nadie más gana ni pierde.
    expect(i.cambios.map((c) => ({ rol: c.rol, pierde: c.pierde, gana: [...c.gana].sort() })))
      .toEqual(i.cambios.length ? [{ rol: 'admin', pierde: [], gana: ['clients.clientes.eliminar', 'clients.clientes.estado', 'parametrizacion.proveedores.estado'] }] : []);
    // Los opcionales se conservan donde estaban y no llegan a nadie más.
    const ef = efectivasExpandidas(usuarios, despues);
    for (const op of ['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar']) {
      for (const u of usuarios) expect(ef.get(u.id)!.has(op), `${u.rol} ${op}`).toBe(partida.get(u.rol)?.has(op) || u.rol === 'admin');
      expect(ef.get(usuarios.find((u) => u.rol === 'financiera')!.id)!.has(op), op).toBe(false);
    }
    expect(i.rolesConTodo.find((r) => r.rol === 'admin')).toEqual({ rol: 'admin', faltabanAntes: [], faltan: [] });
    // Control: lo que admin tenía por el transitorio sigue efectivo por las acciones.
    const e = efectivasExpandidas(usuarios, despues).get(usuarios.find((u) => u.rol === 'admin')!.id)!;
    for (const op of Object.keys(PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION)) expect(e.has(op), op).toBe(true);
  });

  it('AC5: «todos» si modifica — con desbloquear y sin revocar NO llega la autogestión; «alguna» si es de lectura', () => {
    const r = repartirPorTodos([], { filasRol: [
      { rol: 'parcial', codigo: 'tramites.autogestion.desbloquear' }, { rol: 'parcial', codigo: 'parametrizacion.companias.editar' },
      { rol: 'lector', codigo: 'clients.clientes.ver' },
      { rol: 'solo_proveedores', codigo: 'parametrizacion.proveedores.listar' },
      { rol: 'solo_companias', codigo: 'parametrizacion.companias.listar' },
      { rol: 'ancla', codigo: 'accion.perfil.ver_datos' }, { rol: 'ancla', codigo: 'accion.perfil.cambiar_contrasena' },
    ], filasUsuario: [] }, undefined, AREA);
    const de = (rol: string) => r.filasRol.filter((f) => f.rol === rol && f.codigo.startsWith('accion.')).map((f) => f.codigo).sort();
    expect(de('parcial')).toEqual(['accion.clientes.soat_sin_tramite']);
    expect(de('lector')).toEqual(['accion.clientes.ver']);
    // Los opcionales ni agrupan ni se expanden: con solo uno de los catálogos no llega la acción, y lo conserva.
    expect(de('solo_proveedores')).toEqual([]);
    expect(de('solo_companias')).toEqual([]);
    expect(r.filasRol.filter((f) => f.rol === 'solo_proveedores').map((f) => f.codigo)).toEqual(['parametrizacion.proveedores.listar']);
    expect(r.filasRol.filter((f) => f.rol === 'solo_companias').map((f) => f.codigo)).toEqual(['parametrizacion.companias.listar']);
  });

  it('P-22: el reparto universal no corre si algún rol ya tiene la acción (segunda corrida, o quitada desde el panel)', () => {
    const r = repartirPorTodos([{ id: 1, rol: 'sin_perfil' }], { filasRol: [
      { rol: 'con_perfil', codigo: 'accion.perfil.cambiar_contrasena' }, { rol: 'con_perfil', codigo: 'accion.perfil.ver_datos' },
      { rol: 'sin_perfil', codigo: 'pagina.dashboard' },
    ], filasUsuario: [] }, undefined, AREA);
    expect(r.filasRol.filter((f) => f.rol === 'sin_perfil').map((f) => f.codigo)).toEqual(['pagina.dashboard']);
    expect(r.filasUsuario).toEqual([]);
  });

  it('AC4: el transitorio por excepción — quien lo tenía concedido recibe «Crear y editar clientes» solo si completa el grupo, y «Datos fiscales» siempre', () => {
    const r = repartirPorTodos([{ id: 9, rol: 'x' }], { filasRol: [
      { rol: 'x', codigo: 'parametrizacion.companias.editar' }, { rol: 'x', codigo: 'tramites.empresa.crear' },
      { rol: 'ancla', codigo: 'accion.perfil.ver_datos' }, { rol: 'ancla', codigo: 'accion.perfil.cambiar_contrasena' },
    ], filasUsuario: [{ userId: 9, codigo: 'clients.clientes.administrar', efecto: 'conceder' }] }, undefined, AREA);
    expect(r.filasUsuario.map((f) => `${f.codigo} ${f.efecto}`).sort()).toEqual([
      'accion.clientes.crear_editar_clientes conceder', 'accion.clientes.datos_fiscales conceder',
    ]);
    // El rol tenía `companias.editar`: recibe «SOAT sin trámite» por la regla; la autogestión no (le falta desbloquear/revocar).
    expect(r.filasRol.filter((f) => f.rol === 'x').map((f) => f.codigo).sort()).toEqual(['accion.clientes.soat_sin_tramite']);
  });
});
