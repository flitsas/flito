import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { NavItem } from './navItems';

// Comportamiento del disclosure de navegación (patrón WAI-ARIA APG: button
// aria-expanded + lista de links, SIN role="menu"). Extraído de FlitNavBar para
// que todas las variantes de la barra compartan un único contrato de teclado y
// de cierre — es lo que verifica e2e/tests/shell-navbar.spec.ts.
//
// Reglas, en orden de sutileza:
//  · navegar cierra el panel abierto;
//  · pointerdown fuera cierra (pointer y no mouse, para cubrir touch en
//    tablets con viewport lg+; un dropdown de navegación no es un modal, así
//    que no aplica la regla de "cierre explícito");
//  · Escape cierra y DEVUELVE EL FOCO al trigger;
//  · ⌘K/Ctrl+K cierra, para que el Escape de la CommandPalette no compita con
//    el listener de Escape de la barra.

export interface DisclosureNav<S extends string = NavItem['section']> {
  /** Módulo con el panel abierto, o null. */
  openSection: S | null;
  /** Abre el módulo, o lo cierra si ya estaba abierto. */
  toggle: (section: S) => void;
  close: () => void;
  /** Va en el contenedor <nav>: delimita el "fuera" del click-outside. */
  navRef: React.RefObject<HTMLElement>;
  /** id del trigger de un módulo; el refoco tras Escape depende de él. */
  triggerId: (section: S) => string;
  panelId: (section: S) => string;
}

export function useDisclosureNav<S extends string = NavItem['section']>(
  idPrefix: string,
  /** Paneles que viven fuera de `navRef` (portal a <body>): pulsar dentro de ellos no cierra. */
  extraRefs: ReadonlyArray<React.RefObject<HTMLElement | null>> = [],
): DisclosureNav<S> {
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const extraRefsRef = useRef(extraRefs);
  extraRefsRef.current = extraRefs;
  const [openSection, setOpenSection] = useState<S | null>(null);

  const triggerId = useCallback(
    (section: S) => `${idPrefix}-trigger-${section}`,
    [idPrefix],
  );
  const panelId = useCallback(
    (section: S) => `${idPrefix}-panel-${section}`,
    [idPrefix],
  );

  const close = useCallback(() => setOpenSection(null), []);
  const toggle = useCallback((section: S) => {
    setOpenSection((prev) => (prev === section ? null : section));
  }, []);

  useEffect(() => { setOpenSection(null); }, [pathname]);

  useEffect(() => {
    if (!openSection) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!navRef.current?.contains(t) && !extraRefsRef.current.some((r) => r.current?.contains(t))) setOpenSection(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openSection]);

  useEffect(() => {
    if (!openSection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const trigger = navRef.current?.querySelector<HTMLButtonElement>(
          `#${CSS.escape(triggerId(openSection))}`,
        );
        setOpenSection(null);
        trigger?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') setOpenSection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSection, triggerId]);

  return { openSection, toggle, close, navRef, triggerId, panelId };
}
