import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PAGES, rutaInicio, PageSlug } from '../lib/permissions';
import { useAuth } from '../lib/auth';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm } from './flit/flitPageKit';

/**
 * HU #12872 (UX §1): la primera carga de `/permisos/mios` falló. «No saber no es no tener»: no se
 * pinta «sin acceso», se avisa en la página y se ofrece reintentar. Aviso persistente, no toast.
 */
export function AvisoPermisosNoComprobados() {
  const { refrescarSesion } = useAuth();
  const [reintentando, setReintentando] = useState(false);
  const reintentar = async () => {
    setReintentando(true);
    try { await refrescarSesion(); } finally { setReintentando(false); }
  };
  return (
    <div
      role="status"
      data-testid="aviso-permisos-error"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-danger-text)' }}
    >
      <span>No pudimos comprobar tus permisos. Revisa tu conexión e inténtalo de nuevo.</span>
      <button type="button" className={flitBtnSecondarySm} onClick={reintentar} disabled={reintentando}>
        {reintentando ? 'Reintentando…' : 'Reintentar'}
      </button>
    </div>
  );
}

/**
 * Estado "sin acceso a sección" — reemplaza el redirect mudo a "/" de ProtectedRoute.
 * Se renderiza dentro del Layout (conserva la navegación), explica qué pasó y ofrece salida.
 * Accesibilidad: el encabezado recibe foco al montar y se anuncia vía aria-live.
 */
export default function NoAccess({ page, label }: { page?: PageSlug; label?: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { user, funciones } = useAuth();
  // La salida es la página de INICIO del usuario, no `/` fijo (HU #11913). Con `/` fijo, un rol sin
  // `dashboard` volvía al `NoAccess` del tablero: el botón de escape devolvía al mismo callejón.
  // Quien tiene `dashboard` sigue viendo «Volver al tablero», palabra por palabra.
  const inicio = rutaInicio(user, funciones);

  useEffect(() => {
    headingRef.current?.focus();
  }, [page, label]);

  const nombre = label ?? (page ? PAGES[page] : 'esta sección');

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
          No tienes acceso a {nombre}
        </h1>

        <p className="mt-3 flit-tone-secondary">
          Tu usuario no tiene el permiso para ver esta sección. Si la necesitas para tu trabajo,
          pídele a un administrador que te la habilite.
        </p>

        <div className="mt-8 flex justify-center">
          <Link
            to={inicio.to}
            className={flitBtnPrimary}
            style={flitBtnPrimaryStyle}
          >
            {inicio.to === '/' ? 'Volver al tablero' : `Ir a ${inicio.etiqueta}`}
          </Link>
        </div>
      </div>
    </div>
  );
}
