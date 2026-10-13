// HU #13427 (Feature #13416 F3) — Administración: por ahora solo «Integración con Siigo» (P-3), con los
// nombres literales del catálogo aprobado. La HU #13428 amplía este archivo (Usuarios, Roles y permisos…).
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

export const ITEMS_ADMINISTRACION: readonly ItemDef[] = [
  { slug: 'siigo_credenciales', clave: 'integracion_siigo', nombre: 'Integración con Siigo', elemento: 'administracion', orden: 30, acciones: [
    { clave: 'credenciales_pruebas', nombre: 'Registrar credenciales de pruebas', descripcion: 'Registrar y borrar las credenciales de Siigo del ambiente de pruebas.' },
    { clave: 'credenciales_produccion', nombre: 'Registrar credenciales de producción', descripcion: 'Registrar y borrar las credenciales de Siigo del ambiente de producción.' },
    { clave: 'probar_conexion', nombre: 'Probar la conexión', descripcion: 'Probar la conexión con Siigo con las credenciales registradas.' },
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_ADMINISTRACION: readonly NodoArbolDef[] = itemsANodos(ITEMS_ADMINISTRACION);
