import { Component, type ErrorInfo, type ReactNode } from 'react';
import GradientButton from './flit/GradientButton';
import { Icono } from './flit/kit/Icono';

// Aísla el crash de una página: sin esto, un error de render en cualquier vista deja TODO el SPA
// en blanco (incl. la barra de navegación). Se resetea al cambiar de ruta (Layout lo keyea por
// pathname), así que navegar a otra sección recupera la app sin recargar.
interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deja rastro en consola; el shell sigue vivo para que el usuario navegue a otra parte.
    console.error('[ErrorBoundary] Falló el render de la vista:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <div className="card kit-vacio" data-kit="error">
          <span className="kit-disco h-[72px] w-[72px] !text-[color:var(--kit-naranja)]" aria-hidden="true">
            <Icono nombre="nube-alerta" size={36} />
          </span>
          <h1 className="m-0 text-xl font-bold text-[color:var(--color-text-primary)]">
            No se pudo mostrar esta vista
          </h1>
          <p className="text-sm font-normal text-[color:var(--color-text-secondary)]">
            Ocurrió un error al cargar el contenido. Puedes ir a otra sección desde el menú, o recargar.
          </p>
          <GradientButton
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2"
          >
            <Icono nombre="reintento" size={16} />
            Recargar
          </GradientButton>
        </div>
      </div>
    );
  }
}
