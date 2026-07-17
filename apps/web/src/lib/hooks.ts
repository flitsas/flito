import { useEffect, useRef, type RefObject } from 'react';

/**
 * Cierra un modal/diálogo cuando el usuario presiona ESC.
 * Solo se aplica si `enabled` es true (típicamente cuando el modal está abierto).
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  // Usamos ref para evitar re-suscribir el listener si el handler cambia entre renders.
  const handlerRef = useRef(onEscape);
  useEffect(() => { handlerRef.current = onEscape; }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handlerRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}

/**
 * Hook deshabilitado a propósito: los modales del sistema ya no se cierran
 * al hacer click en el backdrop. El usuario reportó cierres accidentales
 * que perdían datos. Solo se cierra con botón ✕ o tecla ESC.
 *
 * Se mantiene la firma para no tocar los call sites; retorna un objeto vacío.
 */
export function useBackdropClose(_onClose: () => void): Record<string, never> {
  void _onClose;
  return {};
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Atrapa el foco dentro de `containerRef` mientras `enabled` (WCAG 2.4.3 / 2.1.2):
 * - Al activarse, mueve el foco al contenedor (que debe tener `tabIndex={-1}`),
 *   para que el lector de pantalla anuncie el diálogo y el Tab empiece arriba.
 * - Cicla el foco con Tab/Shift+Tab sin salir del contenedor.
 * - Al desmontarse/desactivarse, restaura el foco al elemento previo (el disparador).
 *
 * Pensado para FlitModal y cualquier diálogo compartido. No cierra con backdrop
 * (decisión de producto en useBackdropClose) — el cierre es ✕ o Esc.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const getFocusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Foco inicial en el contenedor (anuncia aria-label del diálogo).
    container.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = getFocusables();
      if (items.length === 0) { e.preventDefault(); container.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || active === container || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [enabled, containerRef]);
}
