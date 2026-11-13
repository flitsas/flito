import type { ReactNode } from 'react';

/**
 * Layout público sin shell (portales públicos y seguimiento por enlace, `#seguimiento` de la propuesta): barra con
 * la marca por tema, contenido centrado y pie. Sin dock ni menús: quien llega no tiene cuenta.
 */
export default function LayoutPublico({ children, producto = 'FLITO', ancho = 960 }: { children: ReactNode; producto?: string; ancho?: number }) {
  return (
    <div className="min-h-dvh bg-[var(--color-surface)]">
      <a className="saltar" href="#contenido">Saltar al contenido</a>
      <header className="barra" data-kit="barra-publica">
        <span className="barra__marca">
          <img className="logo logo--claro" src="/kit/logo-claro.svg" alt="FLIT" />
          <img className="logo logo--oscuro" src="/kit/logo-oscuro.svg" alt="FLIT" />
          <span className="barra__producto">{producto}</span>
        </span>
      </header>
      <main id="contenido" tabIndex={-1} className="mx-auto w-full px-[var(--kit-margen)] py-6 outline-none" style={{ maxWidth: ancho }}>
        {children}
      </main>
    </div>
  );
}
