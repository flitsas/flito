// HU #13427 — La forma común de declarar un área del árbol (ítems con sus acciones) y su paso a nodos.
// Extraída de `gestion.ts` (#12873) para que cada área no la repita.
import type { PageSlug } from '../permissions.js';
import type { NodoArbolDef } from './index.js';

export interface AccionDef { clave: string; nombre: string; descripcion: string; hijas?: AccionDef[] }
export interface ItemDef { slug: PageSlug; clave: string; nombre: string; elemento: string; orden: number; acciones: AccionDef[] }

function nodosDeAcciones(padre: string, item: string, acciones: AccionDef[]): NodoArbolDef[] {
  return acciones.flatMap((x, i) => {
    const codigo = `accion.${item}.${x.clave}`;
    const nodo: NodoArbolDef = { codigo, nombre: x.nombre, tipo: 'accion', padre, orden: (i + 1) * 10, descripcion: x.descripcion };
    return [nodo, ...nodosDeAcciones(codigo, item, x.hijas ?? [])];
  });
}

/** Ítems y acciones, padres antes que hijos. */
export function itemsANodos(items: readonly ItemDef[]): NodoArbolDef[] {
  return items.flatMap((it) => [
    { codigo: `pagina.${it.slug}`, nombre: it.nombre, tipo: 'item' as const, padre: `menu.${it.elemento}`, orden: it.orden, slug: it.slug },
    ...nodosDeAcciones(`pagina.${it.slug}`, it.clave, it.acciones),
  ]);
}
