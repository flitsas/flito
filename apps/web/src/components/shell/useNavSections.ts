import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { effectivePages } from '../../lib/permissions';
import { NAV_ITEMS, SECTION_ORDER, activeSectionForPath, navItemPermitido, type NavItem } from './navItems';

// Filtrado y agrupación de la navegación. Estaba duplicado en FlitNavBar y
// FlitSidebar; al extraerlo, cualquier variante de la barra hereda EXACTAMENTE
// el mismo filtrado por permisos que el drawer y la CommandPalette. Si esta
// lógica se toca, se toca en un solo sitio.

export interface SectionGroup {
  section: NavItem['section'];
  items: NavItem[];
}

export interface NavSections {
  /** Ítems permitidos, agrupados por módulo y en SECTION_ORDER. Sin módulos vacíos. */
  grouped: SectionGroup[];
  /** Ítems permitidos en plano (mismo filtro). */
  visibleItems: NavItem[];
  /** Módulo que corresponde a la ruta actual, o null. */
  routeSection: NavItem['section'] | null;
}

export function useNavSections(): NavSections {
  const { user } = useAuth();
  const { pathname } = useLocation();

  const allowed = useMemo(() => effectivePages(user), [user]);

  // Doble filtro: permiso de página + `roles` opcional del ítem. `flito_ayuda` usa el helper derivado.
  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((it) => navItemPermitido(it, user, allowed)),
    [allowed, user],
  );

  const grouped = useMemo(
    () => SECTION_ORDER
      .map((section) => ({ section, items: visibleItems.filter((it) => it.section === section) }))
      .filter((g) => g.items.length > 0),
    [visibleItems],
  );

  const routeSection = useMemo(
    () => activeSectionForPath(pathname, visibleItems),
    [pathname, visibleItems],
  );

  return { grouped, visibleItems, routeSection };
}
