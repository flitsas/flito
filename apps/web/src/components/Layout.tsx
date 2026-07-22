import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AppShell from './flit/AppShell';
import CommandPalette from './shell/CommandPalette';
import ErrorBoundary from './ErrorBoundary';
import { prefetchCoreRoutes } from '../lib/prefetchCoreRoutes';

// Layout FLIT 2026 — AppShell sin sidebar (decisión PO 2026-06-12): topbar +
// FlitNavBar horizontal en desktop, drawer en mobile. El CommandPalette (⌘K)
// se CONSERVA como atajo de poder. La lógica de rutas/permisos no cambia.
export default function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  // SPRINT-PERF-UX-NAV-2026: Layout solo monta dentro de ProtectedRoute (usuario
  // autenticado), así que prefetcheamos los chunks de rutas core en idle una vez.
  // Idempotente (guard de módulo) — no compite con el render inicial.
  useEffect(() => { prefetchCoreRoutes(); }, []);

  // Cmd+K / Ctrl+K abre paleta global. Bloquea binding del navegador.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => { setPaletteOpen(false); }, [location.pathname]);

  // Scroll restoration suave al cambiar de ruta. Skip si hay hash/query.
  useEffect(() => {
    if (location.hash || location.search) return;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  }, [location.pathname, location.hash, location.search]);

  return (
    <>
      <AppShell onOpenPalette={() => setPaletteOpen(true)}>
        <div
          key={location.pathname}
          data-vt="page-main"
          className="animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out motion-reduce:animate-none"
        >
          {/* Keyed por ruta → un crash de página no tumba el shell y se recupera al navegar. */}
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </AppShell>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
