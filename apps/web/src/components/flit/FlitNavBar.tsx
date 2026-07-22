import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { effectivePages } from '../../lib/permissions';
import {
  NAV_ITEMS, SECTION_LABEL, SECTION_ORDER, activeSectionForPath, type NavItem,
} from '../shell/navItems';
import { IconChevronDown } from './icons';

// FlitNavBar — navegación horizontal bajo el topbar (patrón Academy ADR-0023 /
// CIA NavBar, adaptado a identidad FLIT). Reemplaza al sidebar fijo en desktop:
// cada módulo con varios ítems es un disclosure dropdown (patrón APG "disclosure
// navigation menu": button aria-expanded + lista de links, sin role=menu);
// los módulos de un solo ítem son link directo. El filtrado por permisos usa
// EXACTAMENTE la misma lógica que FlitSidebar/CommandPalette (effectivePages).
// Solo visible en lg+; en mobile la navegación sigue en el drawer (hamburguesa).

// PESV supera 20 ítems: el panel pasa a multi-columna a partir de este umbral.
const MULTI_COLUMN_THRESHOLD = 8;

interface SectionGroup {
  section: NavItem['section'];
  items: NavItem[];
}

export default function FlitNavBar() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [openSection, setOpenSection] = useState<NavItem['section'] | null>(null);

  const allowed = useMemo(() => effectivePages(user), [user]);
  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((it) => allowed.has(it.page) && (!it.roles || (user != null && it.roles.includes(user.role)))),
    [allowed, user],
  );

  const grouped: SectionGroup[] = useMemo(
    () =>
      SECTION_ORDER
        .map((section) => ({ section, items: visibleItems.filter((it) => it.section === section) }))
        .filter((g) => g.items.length > 0),
    [visibleItems],
  );

  const routeSection = useMemo(
    () => activeSectionForPath(pathname, visibleItems),
    [pathname, visibleItems],
  );

  // Navegar cierra el dropdown abierto.
  useEffect(() => { setOpenSection(null); }, [pathname]);

  // Click/tap fuera cierra (es un dropdown de navegación, no un modal — la regla
  // "cierre explícito" aplica a modales; los disclosures siguen el patrón APG).
  // pointerdown (no mousedown) para cubrir touch en tablets con viewport lg+.
  useEffect(() => {
    if (!openSection) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenSection(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openSection]);

  // Esc cierra y devuelve el foco al trigger de la sección abierta.
  useEffect(() => {
    if (!openSection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const trigger = navRef.current?.querySelector<HTMLButtonElement>(
        `#flit-navbar-trigger-${openSection}`,
      );
      setOpenSection(null);
      trigger?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSection]);

  // ⌘K/Ctrl+K abre la CommandPalette: cerramos el dropdown para que el Escape
  // de la palette nunca compita con el listener de Escape del navbar.
  useEffect(() => {
    if (!openSection) return;
    const onPaletteKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') setOpenSection(null);
    };
    window.addEventListener('keydown', onPaletteKey);
    return () => window.removeEventListener('keydown', onPaletteKey);
  }, [openSection]);

  const toggle = useCallback((section: NavItem['section']) => {
    setOpenSection((prev) => (prev === section ? null : section));
  }, []);

  if (grouped.length === 0) return null;

  return (
    <nav
      ref={navRef}
      aria-label="Navegación principal"
      className="sticky z-20 hidden lg:block"
      style={{
        top: 'var(--flit-topbar-height)',
        background: 'var(--flit-gradient-primary)',
        boxShadow: '0 6px 18px rgba(22, 39, 68, 0.12)',
      }}
    >
      {/* flex-wrap (no overflow-x-auto): un contenedor con scroll recortaría
          los dropdowns absolutos. En anchos lg ajustados la barra crece a 2 filas.
          Altura de 1 fila = h-9 (36px) + my-1.5 (12px) = 48px = --flit-navbar-height
          (token consumido por los offsets sticky de páginas internas). Si la barra
          envuelve a 2 filas, esos offsets quedan cortos: caso aceptado y documentado
          en flit-tokens.css — solo ocurre en lg justos con los 9 módulos visibles. */}
      <ul className="flex flex-wrap items-stretch gap-1 px-4 sm:px-6 lg:px-8">
        {grouped.map(({ section, items }) => {
          const isRouteSection = routeSection === section;
          const isOpen = openSection === section;

          // FLITO (§correcciones-UX): NO se encierra en un único desplegable. Cada ítem del dominio es
          // un tab de primer nivel — la vista unificada de Trámites es el centro del flujo, no una
          // entrada más escondida bajo "FLITO".
          if (section === 'flito') {
            return items.map((it) => (
              <li key={it.to} className="flex">
                <NavLink
                  to={it.to}
                  className="flit-focus-light my-1.5 flex h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/15 aria-[current=page]:bg-white/20 aria-[current=page]:font-semibold aria-[current=page]:text-white"
                >
                  {it.label}
                </NavLink>
              </li>
            ));
          }

          // Módulo de un solo ítem → link directo, sin dropdown.
          if (items.length === 1) {
            const it = items[0];
            return (
              <li key={section} className="flex">
                <NavLink
                  to={it.to}
                  end={it.to === '/'}
                  className="flit-focus-light my-1.5 flex h-9 items-center whitespace-nowrap rounded-lg px-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/15 aria-[current=page]:bg-white/20 aria-[current=page]:font-semibold aria-[current=page]:text-white"
                >
                  {it.label}
                </NavLink>
              </li>
            );
          }

          const panelId = `flit-navbar-panel-${section}`;
          const multiColumn = items.length > MULTI_COLUMN_THRESHOLD;
          return (
            <li key={section} className="relative flex">
              <button
                type="button"
                id={`flit-navbar-trigger-${section}`}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(section)}
                className={`flit-focus-light my-1.5 flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors hover:bg-white/15 ${
                  isRouteSection || isOpen ? 'bg-white/20 font-semibold text-white' : 'text-white/90'
                }`}
              >
                {SECTION_LABEL[section]}
                <IconChevronDown
                  className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>

              <div
                id={panelId}
                hidden={!isOpen}
                className="absolute left-0 top-full z-30 mt-1 bg-white p-1.5"
                style={{
                  borderRadius: 'var(--flit-radius-md)',
                  border: '1px solid var(--flit-border-soft)',
                  boxShadow: 'var(--flit-shadow-card)',
                  minWidth: multiColumn ? undefined : '15rem',
                }}
              >
                <ul
                  className={multiColumn ? 'grid gap-x-2 gap-y-0.5' : 'flex flex-col gap-0.5'}
                  style={multiColumn ? {
                    gridTemplateColumns: `repeat(${Math.ceil(items.length / 10)}, minmax(13rem, 1fr))`,
                    gridAutoFlow: 'column',
                    gridTemplateRows: `repeat(${Math.min(items.length, 10)}, auto)`,
                  } : undefined}
                >
                  {items.map((it) => (
                    <li key={it.to}>
                      <NavLink
                        to={it.to}
                        end={it.to === '/'}
                        className="flit-focus block truncate rounded-lg px-3 py-2 text-sm text-[var(--flit-text-secondary)] transition-colors hover:bg-[var(--flit-bg-app)] hover:text-[var(--flit-text-primary)] aria-[current=page]:bg-[var(--flit-bg-app)] aria-[current=page]:font-semibold aria-[current=page]:text-[var(--flit-text-primary)]"
                      >
                        {it.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
