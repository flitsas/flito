import type { ReactNode } from 'react';
import FlitTopbar from './FlitTopbar';
import FlitNavBar from './FlitNavBar';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';

/**
 * Shell del UI Kit 2026: barra superior + contenido (`main`, máx. 1680 px, margen lateral del kit y colchón inferior
 * de 112 px —104 en teléfono— para el dock) + dock inferior flotante en TODOS los anchos (en teléfono, solo
 * íconos con desplazamiento, como la propuesta). El cajón lateral (FlitSidebar) se retira de la presentación:
 * la navegación de teléfono es el dock. Permisos y árbol de navegación: sin cambios (useNavSections).
 */
interface AppShellProps {
  onOpenPalette: () => void;
  children: ReactNode;
}

export default function AppShell({ onOpenPalette, children }: AppShellProps) {
  const reservaDrFlit = useDrFlitVisible();
  return (
    <div className="flit-app flex min-h-screen w-full flex-col">
      <a className="saltar" href="#contenido">Saltar al contenido</a>
      <FlitTopbar onOpenPalette={onOpenPalette} />
      <main id="contenido" tabIndex={-1}
        className={`kit-main mx-auto min-w-0 flex-1 outline-none ${reservaDrFlit ? 'max-lg:pb-[calc(8rem+env(safe-area-inset-bottom)+var(--flit-fab-offset,0px))]' : ''}`}>
        {children}
        <p className="mt-8 hidden text-xs text-[color:var(--color-text-tertiary)] lg:block">ISO 27001 · Decreto 1079/2015</p>
      </main>
      <FlitNavBar />
    </div>
  );
}
