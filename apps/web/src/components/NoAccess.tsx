import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { PAGES, PageSlug } from '../lib/permissions';

/**
 * Estado "sin acceso a sección" — reemplaza el redirect mudo a "/" de ProtectedRoute.
 * Se renderiza dentro del Layout (conserva la navegación), explica qué pasó y ofrece salida.
 * Accesibilidad: el encabezado recibe foco al montar y se anuncia vía aria-live.
 */
export default function NoAccess({ page }: { page: PageSlug }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [page]);

  const label = PAGES[page];

  return (
    <div
      className="flex min-h-[70vh] items-center justify-center px-6"
      role="region"
      aria-live="assertive"
      aria-labelledby="noaccess-title"
    >
      <div className="w-full max-w-md text-center">
        <div
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full flit-tone-active-bg"
          aria-hidden="true"
        >
          <svg
            className="h-7 w-7 text-[color:var(--flit-blue)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="11" width="16" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>

        <h1
          id="noaccess-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold flit-tone-primary outline-none"
        >
          No tienes acceso a {label}
        </h1>

        <p className="mt-3 flit-tone-secondary">
          Tu rol actual no incluye esta sección. Si crees que deberías tener acceso, pídele a un
          administrador que la habilite.
        </p>

        <div className="mt-8 flex justify-center">
          <Link
            to="/"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-[color:var(--flit-blue)] px-5 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors hover:bg-[color:var(--flit-blue)]-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-surface)]"
          >
            Volver al tablero
          </Link>
        </div>
      </div>
    </div>
  );
}
