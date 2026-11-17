/* Pinta el árbol de nodos de un glifo del kit con createElement (sin innerHTML). Sin importar el juego completo,
 * para que piezas del chunk de entrada (Ingreso) puedan usar un subconjunto sin pagar los 101 glifos. */
import { createElement, useId, type ReactNode } from 'react';
import type { Glifo, NodoSvg } from './iconos-kit.generated';

function nodos(lista: NodoSvg[], k: string, ruta = ''): ReactNode[] {
  return lista.map(([tag, attrs, hijos], i) => {
    const props: Record<string, string> = { key: `${ruta}${i}` };
    for (const [a, v] of Object.entries(attrs)) props[a] = v.includes('__K__') ? v.replace(/__K__/g, k) : v;
    return createElement(tag, props, ...(hijos ? nodos(hijos, k, `${ruta}${i}.`) : []));
  });
}

export function pintarGlifo(g: Glifo, k: string): ReactNode[] {
  return nodos(g.n, k);
}

/** Glifo suelto, decorativo, 1em por defecto. */
export function GlifoSvg({ glifo, className, size = '1em' }: { glifo: Glifo; className?: string; size?: number | string }) {
  const k = `k${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={glifo.vb} width={size} height={size} focusable="false" aria-hidden="true" className={`kit-icono ${className ?? ''}`}>
      {pintarGlifo(glifo, k)}
    </svg>
  );
}
