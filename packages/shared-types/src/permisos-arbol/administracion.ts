// HU #13427 / #13428 (Feature #13416 F3) — Administración: Usuarios, Roles y permisos (#13428) e
// «Integración con Siigo» (#13427, P-3) y «Rendimiento» (#13588, P-37), con los nombres literales del catálogo aprobado. Clientes y
// proveedores y Bitácora cuelgan de Gestión (decisión del PO del 9-oct): viven en `gestion.ts`.
// Épica #14678 (ADR-0048): «Integración con Siigo» cuelga ahora de Financiera (sigue aquí por su historia, #13427);
// Torre · Umbrales sale a Gerencial y Organismos STT entra a Administración (`gestion.ts`).
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

export const ITEMS_ADMINISTRACION: readonly ItemDef[] = [
  { slug: 'users', clave: 'usuarios', nombre: 'Usuarios', elemento: 'administracion', orden: 10, acciones: [
    { clave: 'ver', nombre: 'Ver usuarios', descripcion: 'Consultar la lista de usuarios y su resumen.' },
    { clave: 'crear', nombre: 'Crear usuario', descripcion: 'Dar de alta un usuario nuevo.' },
    { clave: 'editar', nombre: 'Editar usuario', descripcion: 'Editar los datos, el rol y las excepciones de permisos de un usuario.' },
    { clave: 'cambiar_contrasena', nombre: 'Cambiar la contraseña de otro usuario', descripcion: 'Asignar una contraseña nueva a otro usuario.' },
    { clave: 'desactivar_reactivar', nombre: 'Desactivar o reactivar', descripcion: 'Suspender el acceso de un usuario o devolvérselo.' },
    { clave: 'dar_de_baja', nombre: 'Dar de baja (eliminar)', descripcion: 'Dar de baja a un usuario o deshacer la baja.' },
    { clave: 'ver_historial', nombre: 'Ver el historial', descripcion: 'Consultar el historial de cambios de los usuarios.' },
    { clave: 'exportar', nombre: 'Exportar a Excel', descripcion: 'Descargar la lista de usuarios en Excel.' },
    { clave: 'cerrar_sesiones', nombre: 'Cerrar sesiones', descripcion: 'Cerrar todas las sesiones abiertas de un usuario.' },
  ] },
  { slug: 'roles_permisos', clave: 'roles_permisos', nombre: 'Roles y permisos', elemento: 'administracion', orden: 20, acciones: [
    { clave: 'ver', nombre: 'Ver roles', descripcion: 'Consultar los roles, sus permisos y el catálogo de permisos.' },
    { clave: 'crear', nombre: 'Crear rol', descripcion: 'Crear un rol nuevo.' },
    { clave: 'editar', nombre: 'Editar rol', descripcion: 'Editar el nombre, la descripción y el enlace de un rol.' },
    { clave: 'asignar', nombre: 'Asignar permisos', descripcion: 'Guardar los permisos de un rol.' },
    { clave: 'eliminar', nombre: 'Eliminar rol', descripcion: 'Eliminar un rol sin usuarios.' },
  ] },
  { slug: 'siigo_credenciales', clave: 'integracion_siigo', nombre: 'Integración con Siigo', elemento: 'financiera', orden: 100, acciones: [
    { clave: 'credenciales_pruebas', nombre: 'Registrar credenciales de pruebas', descripcion: 'Registrar y borrar las credenciales de Siigo del ambiente de pruebas.' },
    { clave: 'credenciales_produccion', nombre: 'Registrar credenciales de producción', descripcion: 'Registrar y borrar las credenciales de Siigo del ambiente de producción.' },
    { clave: 'probar_conexion', nombre: 'Probar la conexión', descripcion: 'Probar la conexión con Siigo con las credenciales registradas.' },
  ] },
  // HU #13588 (P-37): el resumen de rendimiento (RUM), orden 60 (Privacidad 40 y Google Drive 50 son ítems antiguos de
  // `legado.ts` bajo el mismo elemento). Sin nivel 3: el ítem concede `rum.resumen.ver` (lo expande
  // el API, `ITEMS_ADMINISTRACION_OPS`), como un ítem antiguo.
  { slug: 'admin_rendimiento', clave: 'rendimiento', nombre: 'Rendimiento', elemento: 'administracion', orden: 60, acciones: [] },
  // Épica #14548 (ADR-0051): visor de solo lectura de los registros de consumo de IA. Orden 70 (libre en Administración).
  // Solo `admin` recibe sus acciones por defecto (D4); las operaciones y la cadena están en `arbol/acciones-ia-consumo.ts`.
  { slug: 'ia_consumo', clave: 'ia_consumo', nombre: 'Consumo de IA', elemento: 'administracion', orden: 70, acciones: [
    { clave: 'ver', nombre: 'Ver los registros de consumo de IA', descripcion: 'Consultar la lista y el detalle de los registros de consumo de IA, sin su contenido.' },
    { clave: 'exportar', nombre: 'Exportar los registros de consumo de IA', descripcion: 'Descargar en CSV los metadatos de los registros de consumo de IA, sin su contenido.' },
    { clave: 'ver_contenido', nombre: 'Ver el contenido de un registro de consumo de IA', descripcion: 'Leer el prompt y la respuesta de un registro, con un motivo, dejando rastro en la auditoría.' },
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_ADMINISTRACION: readonly NodoArbolDef[] = itemsANodos(ITEMS_ADMINISTRACION);
