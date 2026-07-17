import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import FlitSidebar from './FlitSidebar';
import FlitTopbar from './FlitTopbar';
import FlitNavBar from './FlitNavBar';

// AppShell — composición FLIT del shell SIN sidebar (decisión PO 2026-06-12,
// patrón Academy ADR-0023 / CIA NavBar): topbar + FlitNavBar horizontal (lg+)
// + contenido a ancho completo sobre fondo azul claro `#EAF2FF`. En <lg la
// navegación vive en el drawer (FlitSidebar) que abre la hamburguesa.
interface AppShellProps {
  onOpenPalette: () => void;
  children: ReactNode;
}

export default function AppShell({ onOpenPalette, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Cerrar drawer al navegar.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Esc cierra el drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flit-app flex min-h-screen w-full flex-col">
      <FlitSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <FlitTopbar onOpenPalette={onOpenPalette} onOpenSidebar={() => setDrawerOpen(true)} />
      <FlitNavBar />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>

      {/* Pie legal — antes vivía en el footer del sidebar */}
      <footer
        className="hidden px-4 pb-4 text-[10px] sm:px-6 lg:block lg:px-8"
        style={{ color: 'var(--flit-text-muted)' }}
      >
        ISO 27001 · Decreto 1079/2015
      </footer>
    </div>
  );
}
