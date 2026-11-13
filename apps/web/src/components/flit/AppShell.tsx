import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import FlitTopbar from './FlitTopbar';
import FlitNavBar from './FlitNavBar';
import FlitSidebar from './FlitSidebar';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';
import { useDesdeLg } from '../shell/useDesdeLg';

/**
 * Shell del UI Kit 2026: barra superior + contenido (`main`, máx. 1680 px, margen lateral del kit) + navegación.
 * Navegación (Épica #14560): desde 1024 px, dock inferior flotante con «Más» (FlitNavBar); por debajo, sin dock
 * —como en develop— y el ☰ del topbar abre el menú lateral (FlitSidebar). El colchón inferior de `.kit-main` solo
 * reserva el dock donde lo hay; sin dock, solo el botón de Dr. Flit si está (`kit-main--drflit`, kit-react.css).
 * Permisos y árbol de navegación: sin cambios (useNavSections).
 */
interface AppShellProps {
  onOpenPalette: () => void;
  children: ReactNode;
}

export default function AppShell({ onOpenPalette, children }: AppShellProps) {
  const reservaDrFlit = useDrFlitVisible();
  const desdeLg = useDesdeLg();
  const { pathname } = useLocation();
  const [menuAbierto, setMenuAbierto] = useState(false);
  const menuBotonRef = useRef<HTMLButtonElement>(null);

  // Navegar cierra el menú lateral; también pasar a ≥1024 px (ahí manda el dock).
  useEffect(() => { setMenuAbierto(false); }, [pathname]);
  useEffect(() => { if (desdeLg) setMenuAbierto(false); }, [desdeLg]);

  return (
    <div className="flit-app flex min-h-screen w-full flex-col">
      <a className="saltar" href="#contenido">Saltar al contenido</a>
      <FlitTopbar onOpenPalette={onOpenPalette} onOpenSidebar={desdeLg ? undefined : () => setMenuAbierto(true)}
        sidebarAbierto={menuAbierto} menuBotonRef={menuBotonRef} />
      <main id="contenido" tabIndex={-1}
        className={`kit-main mx-auto min-w-0 flex-1 outline-none${reservaDrFlit ? ' kit-main--drflit' : ''}`}>
        {children}
        <p className="mt-8 hidden text-xs text-[color:var(--color-text-tertiary)] lg:block">ISO 27001 · Decreto 1079/2015</p>
      </main>
      <FlitNavBar />
      <FlitSidebar open={menuAbierto && !desdeLg} onClose={() => setMenuAbierto(false)} botonRef={menuBotonRef} />
    </div>
  );
}
