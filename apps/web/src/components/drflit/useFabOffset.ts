import { useEffect, type RefObject } from 'react';

/**
 * HU #13764 (spec UX «Barras de acción fijas al pie en <lg»): una página con barra pegada al pie
 * eleva el botón de Dr. Flit por encima de ella fijando `--flit-fab-offset` (alto de la barra) en
 * `<html>` mientras la barra existe. El botón solo lee la variable en <lg.
 */
export function useFabOffset(ref: RefObject<HTMLElement | null>, activo: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!activo || !el) return;
    const raiz = document.documentElement;
    const fijar = () => raiz.style.setProperty('--flit-fab-offset', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    fijar();
    const obs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fijar) : null;
    obs?.observe(el);
    return () => {
      obs?.disconnect();
      raiz.style.removeProperty('--flit-fab-offset');
    };
  }, [ref, activo]);
}
