import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <div
          className="card"
        >
          <h1 className="text-lg font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            No se pudo mostrar esta vista
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Ocurrió un error al cargar el contenido. Puedes ir a otra sección desde el menú, o recargar.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn mt-4"
          >
            Recargar
          </button>
        </div>
      </div>
    );
  }
}
