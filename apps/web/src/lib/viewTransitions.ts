import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => { finished: Promise<void> };
};

/**
 * Ejecuta `callback` envuelto en la View Transitions API si el navegador la soporta.
 * Caso contrario, ejecuta el callback de forma directa (fallback graceful).
 */
export function startViewTransition(callback: () => void): void {
  if (typeof document === 'undefined') {
    callback();
    return;
  }
  // WCAG 2.2 — respeta preferencia explícita de movimiento reducido.
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    callback();
    return;
  }
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(callback);
    return;
  }
  callback();
}

/**
 * Hook para navegar entre rutas con View Transition.
 * Usa los keyframes `aura-fade-in` / `aura-fade-out` definidos en index.css.
 */
export function useViewTransitionNavigate(): (path: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (path: string) => {
      startViewTransition(() => navigate(path));
    },
    [navigate],
  );
}
