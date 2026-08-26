import type { ComponentType } from 'react';
import {
  IconHome, IconClipboard, IconRoad, IconTruck, IconWrench, IconShield,
  IconPackage, IconScale, IconCog, IconWallet, type IconProps,
} from '../flit/icons';
import type { NavItem } from './navItems';

// Metadatos de presentación de los módulos de navegación. `navItems.ts` sigue
// siendo el catálogo (qué existe y quién lo ve); aquí vive cómo se muestra —
// icono, acento y subgrupos. Lo consumen el dock de escritorio y el drawer
// mobile, así que un cambio aquí se propaga a toda la navegación.

/** Icono por módulo. Antes vivía dentro de FlitSidebar.tsx. */
export const SECTION_ICON: Record<NavItem['section'], ComponentType<IconProps>> = {
  general: IconHome,
  gestion: IconClipboard,
  transito: IconRoad,
  flota: IconTruck,
  mantenimiento: IconWrench,
  pesv: IconShield,
  rndc: IconPackage,
  laft: IconScale,
  // Antes IconScale, igual que `laft`: con iconos visibles en desktop la
  // colisión se notaba. Finanzas pasa a IconWallet.
  finanzas: IconWallet,
  admin: IconCog,
};

/** Color de acento del módulo. Siempre un token de marca, nunca un HEX suelto. */
export const SECTION_ACCENT: Record<NavItem['section'], string> = {
  general:       'var(--flit-cyan)',
  gestion:       'var(--flit-blue)',
  transito:      'var(--flit-blue-text)',
  flota:         'var(--flit-cyan)',
  mantenimiento: 'var(--flit-warning)',
  pesv:          'var(--flit-green)',
  rndc:          'var(--flit-blue)',
  laft:          'var(--flit-blue-text)',
  finanzas:      'var(--flit-green)',
  admin:         'var(--flit-text-secondary)',
};

// Subgrupos dentro de un módulo, indexados por ruta. Solo los necesitan los
// módulos grandes: PESV (25 ítems) y Gestión (11). El resto no se agrupa y cae
// en `null`, que el panel renderiza como una única columna sin título.
//
// Vive aquí y no en NAV_ITEMS porque es una decisión de presentación del panel:
// el catálogo no cambia y los otros dos consumidores (drawer y ⌘K) siguen
// leyendo `navItems.ts` sin tocar nada.
const ITEM_GROUP: Record<string, string> = {
  // — PESV —
  '/pesv':                       'Dirección',
  '/pesv/tablero':               'Dirección',
  '/pesv/diagnostico':           'Dirección',
  '/pesv/plan':                  'Dirección',
  '/pesv/politica':              'Dirección',
  '/pesv/comite':                'Dirección',
  '/pesv/raci':                  'Dirección',
  '/pesv/normativa':             'Cumplimiento',
  '/pesv/auditorias':            'Cumplimiento',
  '/pesv/retencion':             'Cumplimiento',
  '/pesv/comunicaciones':        'Cumplimiento',
  '/pesv/contratistas':          'Cumplimiento',
  '/pesv/conductores':           'Personas',
  '/pesv/capacitaciones':        'Personas',
  '/pesv/alcoholimetria':        'Personas',
  '/pesv/jornadas':              'Personas',
  '/pesv/mi-jornada':            'Personas',
  '/pesv/incidentes':            'Operación',
  '/pesv/incidentes/stats':      'Operación',
  '/pesv/reportar':              'Operación',
  '/pesv/checklists':            'Operación',
  '/pesv/emergencias':           'Operación',
  '/pesv/rutas':                 'Operación',
  '/pesv/pernocta':              'Operación',
  '/pesv/operacion-indicadores': 'Operación',
  // — Gestión —
  '/vehicles':          'Maestros',
  '/clients':           'Maestros',
  '/tramite':           'Trámites',
  '/flito/tramites':    'Trámites',
  '/flito/derechos':    'Trámites',
  '/flito/revisiones':  'Trámites',
  // El subgrupo se llamaba «Colas de gestor» cuando solo entraban el proveedor y el gestor del
  // organismo. Desde la contingencia (HU #11151) también entra Operaciones, así que el título pasa a
  // nombrar el contenido y no a quién lo atiende.
  '/flito/soat':        'SOAT e Impuestos',
  '/flito/impuestos':   'SOAT e Impuestos',
  '/flito/logistica':   'Logística',
  '/flito/ruta':        'Logística',
  // Comparendos es monitoreo de lo que reportan las fuentes, no un trámite que se despacha: su
  // subgrupo propio evita que caiga en la columna sin título del final del panel. Un subgrupo de un
  // solo ítem ya existe («Auditoría»), así que no es un patrón nuevo.
  '/flito/comparendos': 'Comparendos',
  '/flito/bitacora':    'Auditoría',
};

/** Orden estable de los subgrupos por módulo (los no listados van al final). */
const GROUP_ORDER: Record<string, string[]> = {
  pesv:    ['Dirección', 'Operación', 'Personas', 'Cumplimiento'],
  gestion: ['Trámites', 'Logística', 'Maestros', 'SOAT e Impuestos', 'Comparendos', 'Auditoría'],
};

export function groupOf(item: NavItem): string | null {
  return ITEM_GROUP[item.to] ?? null;
}

export interface ItemGroup {
  /** `null` cuando el módulo no define subgrupos. */
  title: string | null;
  items: NavItem[];
}

/**
 * Parte los ítems de un módulo en subgrupos ordenados. Si el módulo no tiene
 * subgrupos definidos devuelve un único grupo sin título — así las variantes
 * renderizan ambos casos con el mismo código.
 */
export function groupItems(section: NavItem['section'], items: NavItem[]): ItemGroup[] {
  const order = GROUP_ORDER[section];
  if (!order) return [{ title: null, items }];

  const buckets = new Map<string, NavItem[]>();
  const ungrouped: NavItem[] = [];
  for (const it of items) {
    const g = groupOf(it);
    if (!g) { ungrouped.push(it); continue; }
    const bucket = buckets.get(g);
    if (bucket) bucket.push(it);
    else buckets.set(g, [it]);
  }

  // Primero los subgrupos conocidos en su orden; luego cualquiera que aparezca
  // por una ruta nueva sin entrada en GROUP_ORDER (no se pierde ningún ítem).
  const extras = [...buckets.keys()].filter((g) => !order.includes(g)).sort();
  const result: ItemGroup[] = [];
  for (const title of [...order, ...extras]) {
    const bucket = buckets.get(title);
    if (bucket && bucket.length > 0) result.push({ title, items: bucket });
  }
  if (ungrouped.length > 0) result.push({ title: null, items: ungrouped });
  return result;
}
