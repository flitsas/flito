import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { effectivePages } from '../../lib/permissions';
import {
  AREAS_SIN_ENTRADAS, ELEMENTO_DE_SECCION, NAV_ITEMS, SECTION_ORDER, activeSectionForPath, navItemPermitido, type NavItem,
} from './navItems';

// Filtrado y agrupación de la navegación. Estaba duplicado en FlitNavBar y
// FlitSidebar; al extraerlo, cualquier variante de la barra hereda EXACTAMENTE
// el mismo filtrado por permisos que el drawer y la CommandPalette. Si esta
// lógica se toca, se toca en un solo sitio.

export interface SectionGroup {
  section: NavItem['section'];
  items: NavItem[];
  /**
   * Área sin ninguna entrada en el catálogo cuyo elemento (`menu.*`) el usuario tiene efectivo (Épica #14678, PR 4):
   * se pinta con el aviso «Próximamente». Un área CON entradas y ninguna permitida nunca lo es: sigue oculta.
   */
  proximamente: boolean;
}

export interface NavSections {
  /** Ítems permitidos, agrupados por módulo y en SECTION_ORDER. Sin módulos vacíos, salvo las áreas «Próximamente». */
  grouped: SectionGroup[];
  /** Ítems permitidos en plano (mismo filtro). */
  visibleItems: NavItem[];
  /** Módulo que corresponde a la ruta actual, o null. */
  routeSection: NavItem['section'] | null;
}

export function useNavSections(): NavSections {
  const { user, funciones } = useAuth();
  const { pathname } = useLocation();

  const allowed = useMemo(() => effectivePages(user), [user]);

  // Doble filtro: permiso de página + `funcion` opcional del ítem (HU #12872, sin nombre de rol).
  // `flito_ayuda` usa el helper derivado.
  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((it) => navItemPermitido(it, user, allowed, funciones)),
    [allowed, user, funciones],
  );

  const grouped = useMemo(
    () => SECTION_ORDER
      .map((section) => {
        const items = visibleItems.filter((it) => it.section === section);
        const proximamente = items.length === 0 && AREAS_SIN_ENTRADAS.has(section)
          && (funciones?.includes(ELEMENTO_DE_SECCION[section]) ?? false);
        return { section, items, proximamente };
      })
      .filter((g) => g.items.length > 0 || g.proximamente),
    [visibleItems, funciones],
  );

  const routeSection = useMemo(
    () => activeSectionForPath(pathname, visibleItems),
    [pathname, visibleItems],
  );

  return { grouped, visibleItems, routeSection };
}
