// HU #13428 (Feature #13416 F3, ADR-0025; diseño §5-ter) — Qué OPERACIONES concede cada acción de
// Administración (Usuarios, Roles y permisos), de Gestión · Clientes y proveedores y Bitácora (elemento
// Gestión desde el 9-oct, mapeo de esta HU), de General · Tablero y de Perfil. Mismo contrato que
// `acciones-gestion.ts` / `acciones-finanzas.ts`: la guarda pide la operación; la tiene quien tenga una
// acción efectiva que la contenga (`arbol/expansion.ts`).
//
// Decisiones del PO (2026-10-13) que se leen aquí:
//   · P-11: «Ver el tablero» absorbe `pagina.flito_tablero` (la pantalla la abre la acción).
//   · P-21: «Ver clientes y proveedores» (lectura) con `clients.clientes.ver` y `companias.listar`;
//     `proveedores.listar` es OPCIONAL (David, 2026-10-13: financiera no gana el catálogo de proveedores).
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
  // Decisión de David (2026-10-13): el catálogo de proveedores SOAT (umbrales de OCR, SLA) es OPCIONAL de la
  // lectura: quien lo tiene lo conserva y nadie lo gana por «alguna» (financiera sigue sin él; el gestor le
  // llega resuelto por `GET /clients`). Sigue siendo apoyo de las dos acciones de admin que lo necesitan.
  'accion.clientes.ver': {
    lectura: true, operaciones: ['clients.clientes.ver', 'parametrizacion.companias.listar'],
    opcionales: ['parametrizacion.proveedores.listar'],
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
  // ── General · Tablero (P-11: absorbe la página del Tablero FLITO, patrón compuerta) ──
  'accion.dashboard.ver': { lectura: true, operaciones: ['tablero.tablero.ver', 'pagina.flito_tablero'] },
  // ── Perfil (P-22: a todos los roles) ──
  'accion.perfil.ver_datos': { lectura: true, operaciones: ['perfil.datos.ver'], predecesores: [], repartoUniversal: true },
  'accion.perfil.cambiar_contrasena': { operaciones: ['perfil.contrasena.cambiar'], predecesores: [], repartoUniversal: true },
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

/** El área de esta HU sobre `OPERACIONES_DECLARADAS` (AC6 de cobertura), por prefijo del código. */
export const AREA_ADMINISTRACION = /^(usuarios|permisos|bitacora|clients|tablero|perfil)\.|^parametrizacion\.(companias|proveedores)\.|^tramites\.(autogestion|empresa)\./;
