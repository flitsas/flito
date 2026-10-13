// HU #13428 (Feature #13416 F3) — Perfil: ver los datos propios y cambiar la contraseña propia. En el paso
// se reparten a TODOS los roles (P-22, PO 2026-10-13): nadie pierde cambiar su contraseña.
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

export const ITEMS_PERFIL: readonly ItemDef[] = [
  { slug: 'perfil', clave: 'perfil', nombre: 'Perfil', elemento: 'perfil', orden: 10, acciones: [
    { clave: 'ver_datos', nombre: 'Ver mis datos', descripcion: 'Ver el nombre, el usuario, el correo y el rol propios.' },
    { clave: 'cambiar_contrasena', nombre: 'Cambiar mi contraseña', descripcion: 'Cambiar la contraseña propia.' },
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_PERFIL: readonly NodoArbolDef[] = itemsANodos(ITEMS_PERFIL);
