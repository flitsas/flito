// Helpers compartidos por DiagnosticoEvaluacionDrawer y DiagnosticoCierreModal.
//
// Aislados aquí para mantener cada componente bajo el budget de 400 líneas
// (memoria feedback_400_lineas_27001.md). No agregar lógica de negocio aquí.

import { useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

/** Tiempo relativo en español ("hace 3m", "ahora"). Fallback ISO si parsea mal. */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d}d`;
  return new Date(iso).toLocaleDateString('es-CO');
}

/**
 * Focus trap manual para modales/drawers. Captura Tab/Shift+Tab y cicla
 * focusables dentro del contenedor. No usa libs externas.
 * Llamar el handler retornado en onKeyDown del wrapper raíz del diálogo.
 */
export function makeFocusTrapHandler(containerRef: RefObject<HTMLElement>) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !containerRef.current) return;
    const focusables = containerRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Restaura el foco al elemento que tenía foco antes de abrir el diálogo.
 * Llamar dentro de un useEffect con dependencia [open].
 */
export function useRestoreFocusOnClose(open: boolean) {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      return () => { previousFocusRef.current?.focus?.(); };
    }
  }, [open]);
}

/** Spinner inline (3.5 unidades, respeta reduced motion). */
export function SpinnerIcon() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path strokeLinecap="round" d="M12 2a10 10 0 0110 10" />
    </svg>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M7 7h10v10" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

export const FASE_LABEL = {
  planear: 'Planear',
  hacer: 'Hacer',
  verificar: 'Verificar',
  actuar: 'Actuar',
} as const;

export const HISTORIAL_ACTION_LABEL: Record<string, string> = {
  create: 'Creación',
  update: 'Edición',
  upload: 'Subió evidencia',
  delete: 'Eliminó evidencia',
  view: 'Visualización',
  cerrar: 'Cierre WORM',
};
