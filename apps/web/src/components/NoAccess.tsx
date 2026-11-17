import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { PAGES, rutaInicio, PageSlug } from '../lib/permissions';
import { etiquetaDeRuta } from './shell/navItems';
import { useAuth } from '../lib/auth';
import { claseBoton } from './flit/GradientButton';
import { Icono } from './flit/kit/Icono';

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
      <div className="card kit-vacio w-full max-w-md" data-kit="vacio">
        <Icono nombre="candado" disco size={72} />

        <h1
          id="noaccess-title"
          ref={headingRef}
          tabIndex={-1}
          className="m-0 text-xl font-bold text-[color:var(--color-text-primary)] outline-none"
        >
          No tienes acceso a {nombre}
        </h1>

        <p className="text-base font-normal text-[color:var(--color-text-secondary)]">
          Tu usuario no tiene el permiso para ver esta sección. Si la necesitas para tu trabajo,
          pídele a un administrador que te la habilite.
        </p>

        <div className="mt-4 flex justify-center">
          <Link
            to={inicio.to}
            className={claseBoton('primary')}
            data-variante="primario"
          >
            {inicio.to === '/' ? 'Volver al tablero' : `Ir a ${etiquetaDeRuta(inicio.to) ?? 'inicio'}`}
          </Link>
        </div>
      </div>
    </div>
  );
}
