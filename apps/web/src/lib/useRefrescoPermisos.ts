import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './auth';

/**
 * Throttle del refresco por navegación. La caché de permisos del servidor dura 60 s por proceso
 * (`PERMISOS_CACHE_TTL_MS`): bajar de 15 s no acelera nada y multiplica peticiones.
 */
export const REFRESCO_NAVEGACION_MS = 15_000;

/**
 * HU #12872 (AC7): refresca páginas y funciones de la sesión sin cerrar sesión.
 *
 * Disparadores: (1) la pestaña vuelve a estar visible → siempre; (2) cambio de ruta → como mucho
 * una vez cada {@link REFRESCO_NAVEGACION_MS}. Sin `setInterval` ni polling. Va DENTRO del Router
 * (usa `useLocation`), en el Layout autenticado. Solo decide qué se PINTA: el servidor sigue
 * negando por `exigirFuncion`.
 */
export function useRefrescoPermisos(): void {
  const { user, refrescarSesion } = useAuth();
  const { pathname } = useLocation();
  const activo = user != null;
  // La carga inicial de la sesión cuenta como el último refresco.
  const ultimo = useRef(Date.now());
  const primeraRuta = useRef(true);

  useEffect(() => {
    if (!activo) return;
    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      ultimo.current = Date.now();
      void refrescarSesion();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [activo, refrescarSesion]);

  useEffect(() => {
    if (!activo) return;
    if (primeraRuta.current) { primeraRuta.current = false; return; }
    if (Date.now() - ultimo.current < REFRESCO_NAVEGACION_MS) return;
    ultimo.current = Date.now();
    void refrescarSesion();
  }, [pathname, activo, refrescarSesion]);
}
