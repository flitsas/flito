// Las barras de la gráfica de Gastos diarios (HU #12625, AC1/AC3): un `<g>` por día con un `<rect>`
// por categoría visible, apilados de abajo arriba. Cada día es un `role="img"` con su detalle en
// `aria-label` y entra en el orden de tabulación con roving tabindex: Tab llega a UN día, ←/→
// recorren, Home/End saltan a los extremos. El puntero no lleva un handler por barra: el svg padre
// resuelve el índice por la abscisa (`indicePorX`) y lo pasa como `activa`.

import { useRef, type KeyboardEvent } from 'react';
import { MARGEN, anchoBarra, textoDetalleDia, type BarraDia, type EscalaValor } from './geometriaGrafica';
import { colorSerie, idPatron } from './PatronesSerie';

export type ModoActiva = 'puntero' | 'foco';

export default function BarrasDias({ barras, escala, anchoPlot, altoPlot, activa, modo, foco, onFoco, onSalirFoco }: {
  barras: BarraDia[];
  escala: EscalaValor;
  anchoPlot: number;
  altoPlot: number;
  /** El día resaltado (por puntero o por foco) o null. */
  activa: number | null;
  modo: ModoActiva | null;
  /** El día que recibe Tab (roving tabindex). */
  foco: number;
  onFoco: (i: number) => void;
  onSalirFoco: () => void;
}) {
  const grupo = useRef<SVGGElement>(null);
  const n = barras.length;
  const { ranura, barra } = anchoBarra(n, anchoPlot);
  const y = (v: number) => MARGEN.arriba + altoPlot - (v / escala.max) * altoPlot;
  const xDe = (i: number) => MARGEN.izq + i * ranura;

  const enfocar = (i: number) => {
    const destino = Math.min(n - 1, Math.max(0, i));
    onFoco(destino);
    (grupo.current?.children[destino] as SVGGElement | undefined)?.focus();
  };
  const teclas = (e: KeyboardEvent<SVGGElement>) => {
    const salto: Record<string, number | undefined> = { ArrowRight: foco + 1, ArrowLeft: foco - 1, Home: 0, End: n - 1 };
    const destino = salto[e.key];
    if (destino === undefined) return;
    e.preventDefault();
    enfocar(destino);
  };

  return (
    <g ref={grupo} role="group" aria-label="Barras por día" onKeyDown={teclas}>
      {barras.map((b) => {
        const x = xDe(b.indice);
        const esActiva = activa === b.indice;
        return (
          <g key={b.dia} role="img" aria-label={textoDetalleDia(b)} tabIndex={foco === b.indice ? 0 : -1}
            onFocus={() => onFoco(b.indice)} onBlur={onSalirFoco} style={{ outline: 'none' }}>
            {/* La ranura entera: da caja al día en 0 y resalta el activo. El foco se ve como en el kit. */}
            <rect x={x} y={MARGEN.arriba} width={ranura} height={altoPlot} rx={2}
              fill={esActiva ? 'var(--flit-bg-hover)' : 'transparent'}
              stroke={esActiva && modo === 'foco' ? 'var(--flit-border-focus)' : 'none'} strokeWidth={2} />
            {b.segmentos.map((s) => {
              const alto = y(s.desde) - y(s.hasta);
              if (alto <= 0) return null;
              return (
                <rect key={s.clave} x={x + (ranura - barra) / 2} y={y(s.hasta)} width={barra} height={alto}
                  fill={`url(#${idPatron(s.clave)})`} stroke={colorSerie(s.categoria.serie.token)} strokeWidth={1} />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
