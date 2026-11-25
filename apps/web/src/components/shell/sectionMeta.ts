import type { ComponentType } from 'react';
import {
  IconHome, IconClipboard, IconPackage, IconCog, IconWallet, IconHelp, type IconProps,
} from '../flit/icons';
import type { NavItem } from './navItems';
import { NAV_ENTRADAS } from './navEntradas';

// Metadatos de presentación de las opciones del menú. `navItems.ts` sigue siendo el catálogo (qué existe y quién
// lo ve); aquí vive cómo se muestra — icono, acento y subgrupos. Lo consumen el dock de escritorio, el menú lateral
// (< 1024 px) y la paleta de comandos, así que un cambio aquí se propaga a toda la navegación.
//
// Épica #14678 (ADR-0048): las opciones son áreas de la empresa + Kyverum + Administración. Los subgrupos son SOLO
// presentación (decisión 6 del ADR: el árbol de permisos sigue siendo elemento → ítem → acción); por eso viven aquí
// y no en el catálogo. Sin iconos nuevos: cada opción reutiliza el de la sección de la que vienen sus entradas.

type Seccion = NavItem['section'];

/**
 * Icono por opción (set `flit/icons`). Reutiliza el de la sección de origen: Operaciones ← Gestión, Financiera ←
 * Finanzas, Gerencial ← General (Tablero), Kyverum ← RNDC, Administración y Ayuda sin cambio. Las áreas aún sin
 * entradas no se pintan; llevan el de Gestión hasta que tengan las suyas.
 */
export const SECTION_ICON: Record<Seccion, ComponentType<IconProps>> = {
  operaciones: IconClipboard,
  financiera: IconWallet,
  comercial: IconClipboard,
  diseno: IconClipboard,
  tecnologia: IconClipboard,
  infraestructura: IconClipboard,
  producto: IconClipboard,
  gerencial: IconHome,
  kyverum: IconPackage,
  administracion: IconCog,
  ayuda: IconHelp,
};

/** Color de acento de la opción. Siempre un token de marca, nunca un HEX suelto. */
export const SECTION_ACCENT: Record<Seccion, string> = {
  operaciones:     'var(--flit-blue)',
  financiera:      'var(--flit-green)',
  comercial:       'var(--flit-blue)',
  diseno:          'var(--flit-blue)',
  tecnologia:      'var(--flit-blue)',
  infraestructura: 'var(--flit-blue)',
  producto:        'var(--flit-blue)',
  gerencial:       'var(--flit-cyan)',
  kyverum:         'var(--flit-blue-text)',
  administracion:  'var(--flit-text-secondary)',
  ayuda:           'var(--flit-text-secondary)',
};

/** Una opción con más entradas que esto se pinta con riel de subgrupos en el dock (spec UX §2). */
export const UMBRAL_RIEL = 24;

/** Torre de Control: subencabezado de Gerencial (spec UX §2). Tablero va antes, sin subencabezado. */
export const SUBGRUPO_TORRE = 'Torre de Control';

/** Subgrupos de Kyverum, por prefijo de ruta y en el orden del riel (spec UX §2). */
const SUBGRUPOS_KYVERUM: ReadonlyArray<readonly [titulo: string, prefijos: readonly string[]]> = [
  ['Tránsito', ['/transito']],
  ['Flota', ['/fleet']],
  ['Mantenimiento', ['/maintenance']],
  ['PESV', ['/pesv']],
  ['RNDC', ['/rndc']],
  ['LAFT', ['/laft']],
  ['Trámites', ['/tramite']],
];

const conPrefijo = (to: string, prefijo: string) => to === prefijo || to.startsWith(`${prefijo}/`);

/**
 * Orden de los subgrupos por opción. `null` es el sitio de las entradas sin subgrupo (en Gerencial, Tablero va
 * primero). Las opciones que no figuran aquí no tienen subgrupos: rejilla plana.
 */
const GROUP_ORDER: Partial<Record<Seccion, ReadonlyArray<string | null>>> = {
  gerencial: [null, SUBGRUPO_TORRE],
  kyverum: [...SUBGRUPOS_KYVERUM.map(([t]) => t), null],
};

/** Subgrupo de presentación de una entrada, o `null` si su opción no los tiene (o la entrada va suelta). */
export function groupOf(item: Pick<NavItem, 'section' | 'to'>): string | null {
  if (item.section === 'kyverum') {
    return SUBGRUPOS_KYVERUM.find(([, prefijos]) => prefijos.some((p) => conPrefijo(item.to, p)))?.[0] ?? null;
  }
  if (item.section === 'gerencial') return item.to.startsWith('/flito/torre/') ? SUBGRUPO_TORRE : null;
  return null;
}

export interface ItemGroup {
  /** `null` para las entradas sin subgrupo (o cuando la opción no define subgrupos). */
  title: string | null;
  items: NavItem[];
}

/**
 * Parte las entradas de una opción en subgrupos ordenados. Si la opción no tiene subgrupos devuelve un único grupo
 * sin título — así los consumidores pintan ambos casos con el mismo código. Ninguna entrada se pierde: un subgrupo
 * que no esté en `GROUP_ORDER` va al final, en orden alfabético. Dentro de cada subgrupo, el orden de las entradas
 * es el de `NAV_ITEMS` (no se reordena aquí).
 */
export function groupItems(section: Seccion, items: NavItem[]): ItemGroup[] {
  const order = GROUP_ORDER[section];
  if (!order) return [{ title: null, items }];

  const buckets = new Map<string | null, NavItem[]>();
  for (const it of items) {
    const g = groupOf(it);
    const bucket = buckets.get(g);
    if (bucket) bucket.push(it);
    else buckets.set(g, [it]);
  }
  const extras = [...buckets.keys()].filter((g): g is string => g !== null && !order.includes(g)).sort();
  const result: ItemGroup[] = [];
  for (const title of [...order, ...extras]) {
    const bucket = buckets.get(title);
    if (bucket && bucket.length > 0) result.push({ title, items: bucket });
  }
  return result;
}

/** ¿La opción se pinta con riel de subgrupos en el dock? Solo si tiene subgrupos y pasa del umbral. */
export function usaRiel(section: Seccion, items: NavItem[]): boolean {
  return section === 'kyverum' && items.length > UMBRAL_RIEL;
}

/**
 * Subgrupo de presentación de una PÁGINA (slug), para quien no tiene la ruta a mano: el panel «Roles y permisos»
 * agrupa los ítems de Kyverum con los mismos subgrupos del riel. Sale de la primera entrada del menú con ese slug en
 * esa opción; `null` si la página no tiene entrada (un ítem sin menú va suelto, al final).
 */
export function subgrupoDePagina(section: Seccion, page: string): string | null {
  const entrada = NAV_ENTRADAS.find((e) => e.page === page && e.section === section);
  return entrada ? groupOf(entrada) : null;
}

/** Los títulos de subgrupo de una opción, en su orden (sin el sitio de las sueltas). */
export function ordenDeSubgrupos(section: Seccion): string[] {
  return (GROUP_ORDER[section] ?? []).filter((t): t is string => t !== null);
}

/**
 * `end` del NavLink de una entrada: exacto en `/` y en las rutas que son prefijo de otra entrada (`/pesv` frente a
 * `/pesv/conductores`, `/rndc` frente a `/rndc/remesas`). Sin esto, en `/pesv/conductores` se marcaban a la vez
 * «Tablero PESV» y «Conductores».
 */
export function finExacto(to: string): boolean {
  return to === '/' || NAV_ENTRADAS.some((e) => e.to.startsWith(`${to}/`));
}
