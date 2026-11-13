import { useEffect, useRef } from 'react';

/**
 * Pista de desborde para tiras con scroll horizontal (pestañas, filtro segmentado). Solo presentación:
 * escribe `data-desborda="true"` en el elemento mientras quede contenido oculto a la DERECHA, y lo
 * retira al llegar al final del scroll. El desvanecido lo pinta `kit-responsive.css` (`mask-image`).
 * Escribe el atributo directo en el DOM para no re-renderizar en cada evento de scroll.
 */
export function useDesbordeScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const medir = () => {
      // +1 px de tolerancia por anchos fraccionarios (misma que `useDesbordaX` de FlitTable).
      const quedaDerecha = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
      if (quedaDerecha) el.setAttribute('data-desborda', 'true');
      else el.removeAttribute('data-desborda');
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    el.addEventListener('scroll', medir, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', medir); };
  }, []);
  return ref;
}
