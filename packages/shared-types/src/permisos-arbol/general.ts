// HU #13428 (Feature #13416 F3) — General → Tablero. «Ver el tablero» absorbe la página del Tablero FLITO
// (P-11): esa pantalla la abre la acción, sin ítem propio.
import type { NodoArbolDef } from './index.js';
import { itemsANodos, type ItemDef } from './nodos.js';

export const ITEMS_GENERAL: readonly ItemDef[] = [
  { slug: 'dashboard', clave: 'dashboard', nombre: 'Tablero', elemento: 'general', orden: 10, acciones: [
    { clave: 'ver', nombre: 'Ver (solo ver)', descripcion: 'Ver el tablero con los bloques de los módulos a los que tiene acceso.' },
  ] },
];

/** Ítems y acciones del área, padres antes que hijos. */
export const ARBOL_GENERAL: readonly NodoArbolDef[] = itemsANodos(ITEMS_GENERAL);
