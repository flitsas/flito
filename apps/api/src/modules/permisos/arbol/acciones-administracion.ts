// HU #13428 (Feature #13416 F3, ADR-0025; diseño §5-ter) — Qué OPERACIONES concede cada acción de
// Administración (Usuarios, Roles y permisos), de Gestión · Clientes y proveedores y Bitácora (elemento
// Gestión desde el 9-oct, mapeo de esta HU), de General · Tablero y de Perfil. Mismo contrato que
// `acciones-gestion.ts` / `acciones-finanzas.ts`: la guarda pide la operación; la tiene quien tenga una
// acción efectiva que la contenga (`arbol/expansion.ts`).
//
// Decisiones del PO (2026-10-13) que se leen aquí:
//   · P-11: «Ver el tablero» absorbe `pagina.flito_tablero` (la pantalla la abre la acción).
//   · P-21: «Ver clientes y proveedores» (lectura) con `clients.clientes.ver`; `companias.listar` y
//     `proveedores.listar` son OPCIONALES (David, 2026-10-13: financiera no gana nada en el paso).
//   · P-22: «Ver mis datos» y «Cambiar mi contraseña» (y `pagina.perfil`) se reparten a TODOS los roles
//     (`repartoUniversal`, sin literales de rol). P-23: la guarda de la propia contraseña, sin excepción.
//   · Regla vigente: modifica → «todos»; lectura (flag) → «alguna». «Exportar a Excel» de Usuarios es su
//     única operación: modifica. Opcionales del área: ninguno.
// Decisiones de diseño (no cambian el reparto de nadie: los grupos son solo de admin): `usuarios.usuario.reactivar`
// va en «Dar de baja» (deshace la BAJA, no la desactivación); `tramites.empresa.crear` va en «Crear y editar
// clientes»; el transitorio `clients.clientes.administrar` y `PATCH /companias/:id` se parten por grupo de
// campos en operaciones NUEVAS cuyo código viejo es el predecesor (§5-ter.1 punto 2).
import type { AccionArbol } from './acciones-gestion.js';

const TRANSITORIO_CLIENTES = 'clients.clientes.administrar';
const COMPANIAS_EDITAR = 'parametrizacion.companias.editar';

export const ACCIONES_ADMINISTRACION: Readonly<Record<string, AccionArbol>> = {
  // ── Administración · Usuarios ──
  'accion.usuarios.ver': { lectura: true, operaciones: ['usuarios.usuario.listar', 'usuarios.usuario.ver_resumen'] },
  'accion.usuarios.crear': { operaciones: ['usuarios.usuario.crear'] },
  'accion.usuarios.editar': { operaciones: ['usuarios.usuario.editar'] },
  'accion.usuarios.cambiar_contrasena': { operaciones: ['usuarios.contrasena.cambiar_ajena'] },
  'accion.usuarios.desactivar_reactivar': { operaciones: ['usuarios.usuario.activar'] },
  'accion.usuarios.dar_de_baja': { operaciones: ['usuarios.usuario.baja', 'usuarios.usuario.reactivar'] },
  'accion.usuarios.ver_historial': { lectura: true, operaciones: ['usuarios.auditoria.ver', 'usuarios.auditoria.filtrar'] },
  'accion.usuarios.exportar': { operaciones: ['usuarios.usuario.exportar'] },
  'accion.usuarios.cerrar_sesiones': { operaciones: ['usuarios.sesiones.invalidar'] },
  // ── Administración · Roles y permisos ──
  'accion.roles_permisos.ver': { lectura: true, operaciones: ['permisos.rol.listar', 'permisos.cuadro.ver', 'permisos.catalogo.ver'] },
  'accion.roles_permisos.crear': { operaciones: ['permisos.rol.crear'] },
  'accion.roles_permisos.editar': { operaciones: ['permisos.rol.editar'] },
  'accion.roles_permisos.asignar': { operaciones: ['permisos.cuadro.guardar'] },
  'accion.roles_permisos.eliminar': { operaciones: ['permisos.rol.borrar'] },
  // ── Gestión · Bitácora ──
  'accion.bitacora.ver': { lectura: true, operaciones: ['bitacora.bitacora.ver', 'bitacora.bitacora.ver_recurso'] },
  // ── Gestión · Clientes y proveedores ──
  // Decisiones de David (2026-10-13): el catálogo de proveedores SOAT (umbrales de OCR, SLA) y el de compañías
  // (su configuración) son OPCIONALES de la lectura: quien los tiene los conserva y nadie los gana por «alguna»
  // (financiera no gana nada; el gestor le llega resuelto por `GET /clients`). Siguen siendo apoyo de las
  // acciones de admin que los necesitan.
  'accion.clientes.ver': {
    lectura: true, operaciones: ['clients.clientes.ver'],
    opcionales: ['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar'],
  },
  'accion.clientes.crear_editar_clientes': {
    operaciones: ['clients.clientes.crear', 'clients.clientes.editar', COMPANIAS_EDITAR, 'tramites.empresa.crear'],
    predecesores: [TRANSITORIO_CLIENTES, COMPANIAS_EDITAR, 'tramites.empresa.crear'],
    apoyo: ['clients.clientes.ver', 'parametrizacion.companias.listar'],
  },
  'accion.clientes.crear_editar_proveedores': {
    operaciones: ['parametrizacion.proveedores.crear', 'parametrizacion.proveedores.editar'], apoyo: ['parametrizacion.proveedores.listar'],
  },
  'accion.clientes.autogestion': {
    operaciones: ['tramites.autogestion.desbloquear', 'tramites.autogestion.revocar', 'parametrizacion.companias.autogestion'],
    predecesores: ['tramites.autogestion.desbloquear', 'tramites.autogestion.revocar', COMPANIAS_EDITAR],
    apoyo: ['parametrizacion.companias.listar'],
  },
  'accion.clientes.soat_sin_tramite': {
    operaciones: ['parametrizacion.companias.soat_sin_tramite'], predecesores: [COMPANIAS_EDITAR],
    apoyo: ['parametrizacion.companias.listar', 'parametrizacion.proveedores.listar'],
  },
  'accion.clientes.datos_fiscales': {
    operaciones: ['clients.clientes.datos_fiscales'], predecesores: [TRANSITORIO_CLIENTES], apoyo: ['clients.clientes.ver'],
  },
  // HU #13945 — exclusiva del Administrador (HU #13944, `FUNCIONES_EXCLUSIVAS_ADMIN`). Nace tras la siembra del árbol
  // (`predecesores: []`, nadie la tenía): solo `admin` la recibe (0255). Apoyo: la lectura del padrón.
  'accion.clientes.activar_desactivar': {
    operaciones: ['clients.clientes.estado'], predecesores: [], apoyo: ['clients.clientes.ver'],
  },
  // ── General · Tablero (P-11: absorbe la página del Tablero FLITO, patrón compuerta) ──
  'accion.dashboard.ver': { lectura: true, operaciones: ['tablero.tablero.ver', 'pagina.flito_tablero'] },
  // ── Perfil (P-22: a todos los roles) ──
  'accion.perfil.ver_datos': { lectura: true, operaciones: ['perfil.datos.ver'], predecesores: [], repartoUniversal: true },
  'accion.perfil.cambiar_contrasena': { operaciones: ['perfil.contrasena.cambiar'], predecesores: [], repartoUniversal: true },
};

/**
 * HU #13588 (P-37) — Ítems de Administración SIN nivel 3 que conceden operaciones al ser efectivos (como un ítem
 * antiguo): «Rendimiento» da el resumen RUM, que deja de ser transversal. La 0240 borra sus filas directas.
 */
export const ITEMS_ADMINISTRACION_OPS: Readonly<Record<string, { operaciones: readonly string[] }>> = {
  'pagina.admin_rendimiento': { operaciones: ['rum.resumen.ver'] },
};

/**
 * Las operaciones NUEVAS de esta HU y el código de PARTIDA del que salen (mismo contrato que en
 * `acciones-finanzas.ts`). Las de Perfil no existían en el mundo plano: su partida es `pagina.perfil` (no
 * se leen en `catalogoPlano()`); las de compañía parten una guarda que SIGUE viva (`companias.editar`).
 */
export const PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION: Readonly<Record<string, string>> = {
  'clients.clientes.crear': TRANSITORIO_CLIENTES,
  'clients.clientes.editar': TRANSITORIO_CLIENTES,
  'clients.clientes.datos_fiscales': TRANSITORIO_CLIENTES,
  'parametrizacion.companias.autogestion': COMPANIAS_EDITAR,
  'parametrizacion.companias.soat_sin_tramite': COMPANIAS_EDITAR,
  'perfil.datos.ver': 'pagina.perfil',
  'perfil.contrasena.cambiar': 'pagina.perfil',
};

/**
 * HU #13945 — Lo que Clientes estrena DESPUÉS de la siembra del árbol (mismo contrato que
 * `OPERACIONES_NACIDAS_EN_EL_ARBOL` de `acciones-finanzas.ts`, que las une): la operación nace absorbida (no se siembra,
 * no existió en el mundo plano) y la acción la siembra la 0255, solo para `admin`, con `exclusiva_admin = true`.
 */
export const OPERACIONES_NACIDAS_EN_EL_ARBOL_ADMINISTRACION: readonly string[] = ['clients.clientes.estado'];
export const ACCIONES_NACIDAS_TRAS_LA_SIEMBRA_ADMINISTRACION: readonly string[] = ['accion.clientes.activar_desactivar'];

/** El área de esta HU sobre `OPERACIONES_DECLARADAS` (AC6 de cobertura), por prefijo del código. */
export const AREA_ADMINISTRACION = /^(usuarios|permisos|bitacora|clients|tablero|perfil)\.|^parametrizacion\.(companias|proveedores)\.|^tramites\.(autogestion|empresa)\./;
