import { useLayoutEffect, useRef, useState } from 'react';

// Los paneles del dock cuelgan de su trigger, así que se salen del viewport
// cuando el módulo está a la derecha y el panel es ancho — PESV, con sus cuatro
// columnas de subgrupo, es el caso que lo destapa. Este hook devuelve el
// desplazamiento horizontal mínimo para que el panel quepa.
//
// Mide con offsetWidth y con el rect del ancla (no con el rect del propio
// panel) para que el desplazamiento ya aplicado no contamine la medida y el
// cálculo no oscile.
//
// El resultado se aplica sobre `left`, NO sobre `transform`: los paneles entran
// con la animación `flit-panel-up`, que anima transform con fill-mode both, y
// una animación CSS gana sobre el estilo inline — un translateX inline quedaría
// pisado para siempre por el fotograma final.

/** Margen que se respeta contra el borde del viewport. */
const GUTTER = 12;

export function useEdgeClamp<T extends HTMLElement>(open: string | null) {
  const ref = useRef<T>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    if (!open) { setShift(0); return; }
    const el = ref.current;
    const anchor = el?.offsetParent as HTMLElement | null;
    if (!el || !anchor) return;

    const compute = () => {
      const left = anchor.getBoundingClientRect().left;
      const overflow = left + el.offsetWidth - (window.innerWidth - GUTTER);
      setShift(overflow > 0 ? -overflow : 0);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  return { ref, shift };
}
