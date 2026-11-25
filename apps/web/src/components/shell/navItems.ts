import { ARBOL_PERMISOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { NAV_ENTRADAS, SECTION_ORDER, type AreaMenu, type NavItem } from './navEntradas';

export { SECTION_ORDER, activeSectionForPath, navItemPermitido, type NavItem, type AreaMenu } from './navEntradas';

// Catálogo único de navegación. Antes vivía en Layout.tsx pero ahora lo consumen
// CommandPalette y FlitSidebar. Single source of truth.
//
// HU #13431: los NOMBRES no se escriben aquí. El rótulo de cada sección es el nombre de su elemento
// (nivel 1, `menu.*`) y el de cada ítem el de su ítem (nivel 2, `pagina.<slug>`) en `ARBOL_PERMISOS`,
// la misma fuente que pinta el panel de Roles y permisos: lo que el administrador marca es lo que el
// usuario lee. Solo llevan `etiqueta` propia los enlaces que no son un ítem del catálogo: los
// enlaces secundarios de un ítem con varias pantallas (RNDC, Privacidad) y la página Ayuda FLITO,
// que vive bajo el elemento derivado «Ayuda» sin ítem marcable y por eso toma el nombre del
// elemento (también cabe así en la fila del dock del admin a 1440 px, HU #11900).

/**
 * Elemento del catálogo (nivel 1) de cada opción del menú (Épica #14678, ADR-0048). Cubre las 11 áreas: las cinco
 * sin pantallas (Comercial, Diseño, Tecnología, Infraestructura, Producto) tienen elemento desde el PR 4 para que un
 * rol pueda activarlas y el menú pinte su aviso «Próximamente». «Ayuda» es derivado.
 */
export const ELEMENTO_DE_SECCION: Record<AreaMenu, string> = {
  operaciones: 'menu.operaciones', financiera: 'menu.financiera', comercial: 'menu.comercial', diseno: 'menu.diseno',
  tecnologia: 'menu.tecnologia', infraestructura: 'menu.infraestructura', producto: 'menu.producto',
  gerencial: 'menu.gerencial', kyverum: 'menu.kyverum', administracion: 'menu.administracion', ayuda: 'menu.ayuda',
};

const NOMBRE_ELEMENTO = new Map(ELEMENTOS_PERMISOS.map((n) => [n.codigo, n.nombre]));
const NOMBRE_ITEM = new Map(
  ARBOL_PERMISOS.filter((n) => n.tipo === 'item' && n.slug).map((n) => [n.slug as string, n.nombre]),
);

function rotuloDeSeccion(s: AreaMenu): string {
  return NOMBRE_ELEMENTO.get(ELEMENTO_DE_SECCION[s]) ?? s;
}

/**
 * Áreas sin ninguna entrada en el catálogo (PR 4). DERIVADO a propósito: el día que un área reciba su primera entrada
 * deja de ser «Próximamente» sola y vuelve a la regla de siempre (visible solo si el usuario ve alguna entrada).
 */
export const AREAS_SIN_ENTRADAS: ReadonlySet<AreaMenu> = new Set(
  SECTION_ORDER.filter((s) => s !== 'ayuda' && !NAV_ENTRADAS.some((e) => e.section === s)),
);

/** Rótulo de cada opción = nombre de su elemento en el catálogo (HU #13431, AC4). */
export const SECTION_LABEL = Object.fromEntries(
  SECTION_ORDER.map((s) => [s, rotuloDeSeccion(s)]),
) as Record<NavItem['section'], string>;

/**
 * Entradas que, sin moverse en `NAV_ENTRADAS` (su orden decide `rutaInicio`), se presentan al final de su
 * opción: Organismos STT llegó a Administración desde Tránsito y la spec la pone la última (spec UX §Mapa).
 */
const AL_FINAL_DE_SU_OPCION = new Set(['/transito/organismos']);

/**
 * Ítems del menú con su nombre resuelto: `etiqueta` (enlace secundario) → nombre del ítem en el
 * catálogo → nombre de su elemento (un enlace sin ítem marcable, como la página de Ayuda FLITO bajo
 * el elemento derivado «Ayuda»).
 */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_ENTRADAS.filter((it) => !AL_FINAL_DE_SU_OPCION.has(it.to)),
  ...NAV_ENTRADAS.filter((it) => AL_FINAL_DE_SU_OPCION.has(it.to)),
].map(({ etiqueta, ...it }) => ({
  ...it,
  label: etiqueta ?? NOMBRE_ITEM.get(it.page) ?? SECTION_LABEL[it.section],
}));

/** Nombre del menú para una ruta (lo usa `NoAccess` para «Ir a …»); `null` si no es una entrada. */
export function etiquetaDeRuta(to: string): string | null {
  return NAV_ITEMS.find((it) => it.to === to)?.label ?? null;
}
