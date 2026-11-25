import { ARBOL_PERMISOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { NAV_ENTRADAS, SECTION_ORDER, type NavItem } from './navEntradas';

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
 * Elemento del catálogo (nivel 1) de cada opción del menú (Épica #14678, ADR-0048). Las áreas de la empresa
 * que aún no tienen elemento (Comercial, Diseño, Tecnología, Infraestructura, Producto) no tienen entradas, así
 * que no se pintan; su rótulo vive en `ROTULO_SIN_ELEMENTO` para el día que las tengan. «Ayuda» es derivado.
 */
const ELEMENTO_DE_SECCION: Partial<Record<NavItem['section'], string>> = {
  operaciones: 'menu.operaciones', financiera: 'menu.financiera', gerencial: 'menu.gerencial',
  kyverum: 'menu.kyverum', administracion: 'menu.administracion', ayuda: 'menu.ayuda',
};

const NOMBRE_ELEMENTO = new Map(ELEMENTOS_PERMISOS.map((n) => [n.codigo, n.nombre]));
const NOMBRE_ITEM = new Map(
  ARBOL_PERMISOS.filter((n) => n.tipo === 'item' && n.slug).map((n) => [n.slug as string, n.nombre]),
);

/** Áreas de la empresa sin elemento propio en el catálogo todavía (ocultas mientras no tengan entradas). */
const ROTULO_SIN_ELEMENTO: Partial<Record<NavItem['section'], string>> = {
  comercial: 'Comercial', diseno: 'Diseño', tecnologia: 'Tecnología', infraestructura: 'Infraestructura', producto: 'Producto',
};

function rotuloDeSeccion(s: NavItem['section']): string {
  const elemento = ELEMENTO_DE_SECCION[s];
  return (elemento ? NOMBRE_ELEMENTO.get(elemento) : undefined) ?? ROTULO_SIN_ELEMENTO[s] ?? elemento ?? s;
}

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
