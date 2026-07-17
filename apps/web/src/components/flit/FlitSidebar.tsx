import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { effectivePages } from '../../lib/permissions';
import { FLIT_PRODUCT_NAME } from '../../lib/flitBrand';
import {
  NAV_ITEMS, SECTION_LABEL, SECTION_ORDER, activeSectionForPath, type NavItem,
} from '../shell/navItems';
import {
  IconHome, IconClipboard, IconRoad, IconTruck, IconWrench, IconShield,
  IconPackage, IconScale, IconCog, IconClose, IconDot, IconChevronDown,
  type IconProps,
} from './icons';

// FlitSidebar — drawer de navegación MOBILE (off-canvas, gradiente FLIT).
// Decisión PO 2026-06-12: el rail fijo desktop se eliminó; en lg+ la navegación
// vive en FlitNavBar (horizontal, patrón Academy ADR-0023 / CIA NavBar). Este
// drawer cubre <lg vía la hamburguesa del topbar.
//
// La navegación se filtra por permisos con EXACTAMENTE la misma lógica que
// CommandPalette/FlitNavBar (effectivePages → NAV_ITEMS.filter). No se altera
// `allowedPages` ni `ProtectedRoute`.

const SECTION_ICON: Record<NavItem['section'], ComponentType<IconProps>> = {
  general: IconHome,
  gestion: IconClipboard,
  transito: IconRoad,
  flota: IconTruck,
  mantenimiento: IconWrench,
  pesv: IconShield,
  rndc: IconPackage,
  laft: IconScale,
  admin: IconCog,
};

const SIDEBAR_OPEN_KEY = 'flit-sidebar-open-sections';

function loadOpenSections(): Set<NavItem['section']> | null {
  try {
    const raw = sessionStorage.getItem(SIDEBAR_OPEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((s): s is NavItem['section'] => SECTION_ORDER.includes(s as NavItem['section'])));
  } catch {
    return null;
  }
}

interface FlitSidebarProps {
  open: boolean;       // estado del drawer mobile
  onClose: () => void; // cerrar drawer (click overlay / item / Esc)
}

export default function FlitSidebar({ open, onClose }: FlitSidebarProps) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const allowed = useMemo(() => effectivePages(user), [user]);

  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((it) => allowed.has(it.page)),
    [allowed],
  );

  // Agrupar items permitidos por sección, respetando SECTION_ORDER.
  const grouped = useMemo(() => {
    return SECTION_ORDER
      .map((section) => ({ section, items: visibleItems.filter((it) => it.section === section) }))
      .filter((g) => g.items.length > 0);
  }, [visibleItems]);

  const routeSection = useMemo(
    () => activeSectionForPath(pathname, visibleItems),
    [pathname, visibleItems],
  );

  const [openSections, setOpenSections] = useState<Set<NavItem['section']>>(() => {
    // Admin: todas las secciones visibles por defecto (superusuario debe ver el catálogo
    // completo sin depender de sessionStorage ni de expandir Gestión manualmente).
    if (user?.role === 'admin') return new Set(SECTION_ORDER);
    const saved = loadOpenSections();
    if (saved && saved.size > 0) return saved;
    return routeSection ? new Set([routeSection]) : new Set<NavItem['section']>(['general']);
  });

  // Si el usuario carga después del primer paint (token /me), aplicar política admin.
  useEffect(() => {
    if (user?.role !== 'admin') return;
    setOpenSections(new Set(SECTION_ORDER));
  }, [user?.role]);

  // Al cambiar de ruta, abrir el módulo que contiene la página activa.
  useEffect(() => {
    if (!routeSection) return;
    setOpenSections((prev) => {
      if (prev.has(routeSection)) return prev;
      const next = new Set(prev);
      next.add(routeSection);
      return next;
    });
  }, [routeSection]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SIDEBAR_OPEN_KEY, JSON.stringify([...openSections]));
    } catch {
      // sessionStorage bloqueado — sin persistencia.
    }
  }, [openSections]);

  const toggleSection = useCallback((section: NavItem['section']) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const content = (
    <nav aria-label="Navegación principal" className="flex h-full flex-col">
      {/* Logo / marca */}
      <div className="flex items-center gap-3 px-5 py-5 text-white">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15">
          <IconShield className="h-5 w-5" />
        </span>
        <span className="text-base font-semibold tracking-tight">{FLIT_PRODUCT_NAME}</span>
        {/* Cerrar (solo mobile) */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar menú"
          className="flit-focus-light ml-auto grid h-9 w-9 place-items-center rounded-lg text-white/85 hover:bg-white/15 lg:hidden"
        >
          <IconClose className="h-5 w-5" />
        </button>
      </div>

      {/* Módulos */}
      <div className="flex-1 overflow-y-auto px-3 pb-6">
        {grouped.map(({ section, items }) => {
          const SectionIcon = SECTION_ICON[section];
          const isOpen = openSections.has(section);
          const panelId = `flit-nav-section-${section}`;
          return (
            <div key={section} className="mb-1">
              <button
                type="button"
                id={`${panelId}-trigger`}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggleSection(section)}
                className="flit-focus-light flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-white/90 transition-colors hover:bg-white/10"
              >
                <SectionIcon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
                  {SECTION_LABEL[section]}
                </span>
                <span className="tabular-nums text-[10px] text-white/50" aria-hidden="true">
                  {items.length}
                </span>
                <IconChevronDown
                  className={`h-4 w-4 shrink-0 text-white/70 transition-transform duration-200 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              <div
                id={panelId}
                role="region"
                aria-labelledby={`${panelId}-trigger`}
                hidden={!isOpen}
                className={isOpen ? 'pb-2' : undefined}
              >
                <ul className="flex flex-col gap-0.5 pl-1">
                  {items.map((it) => (
                    <li key={it.to}>
                      <NavLink
                        to={it.to}
                        end={it.to === '/'}
                        onClick={onClose}
                        className="flit-focus-light group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/10 aria-[current=page]:bg-white/20 aria-[current=page]:font-semibold aria-[current=page]:text-white"
                      >
                        <IconDot className="h-3 w-3 shrink-0 opacity-70 group-aria-[current=page]:opacity-100" />
                        <span className="truncate">{it.label}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pie legal */}
      <div className="px-5 py-4 text-[10px] leading-relaxed text-white/65">
        ISO 27001 · Decreto 1079/2015
      </div>
    </nav>
  );

  return (
    <>
      {/* Drawer mobile (en lg+ la navegación es FlitNavBar) */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú de navegación">
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={onClose}
            className="absolute inset-0 bg-[rgba(22,39,68,0.45)] backdrop-blur-sm"
          />
          <div
            className="absolute inset-y-0 left-0 w-[min(84vw,300px)] shadow-2xl"
            style={{
              background: 'var(--flit-gradient-sidebar)',
              borderTopRightRadius: 'var(--flit-radius-xl)',
              borderBottomRightRadius: 'var(--flit-radius-xl)',
            }}
          >
            {content}
          </div>
        </div>
      )}
    </>
  );
}
