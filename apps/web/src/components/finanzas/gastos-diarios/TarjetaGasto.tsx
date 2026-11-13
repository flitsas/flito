// Una de las cinco tarjetas de Gastos diarios (HU #12624): cantidad · valor en la misma línea y,
// debajo, qué cuenta. Sin color por categoría (doc UX): la lectura la dan el orden y el rótulo. Una
// cantidad 0 se pinta «0 · $ 0» en tono apagado, nunca vacía ni con guion (AC3).

import type { GastosDiariosCelda } from '@operaciones/shared-types';
import Monto from '../Monto';
import { ariaTarjeta, type CategoriaGasto } from './tiposGastosDiarios';

export default function TarjetaGasto({ categoria, celda }: { categoria: CategoriaGasto; celda: GastosDiariosCelda }) {
  const vacia = celda.cantidad === 0;
  return (
    // La región lleva el nombre completo; lo visible va `aria-hidden` para no leerse dos veces.
    <section role="region" aria-label={ariaTarjeta(categoria, celda.cantidad, celda.valor)}>
      {/* La pieza `.metrica` del kit (la de KpiCard), sin enlace: aquí la tarjeta solo informa. */}
      <div className="metrica h-full cursor-default" data-kit="metrica" aria-hidden="true">
        <span className="metrica__etiqueta">{categoria.titulo}</span>
        <span className="metrica__cifra whitespace-nowrap text-xl tabular-nums sm:text-2xl"
          style={vacia ? { color: 'var(--color-text-tertiary)' } : undefined}>
          {celda.cantidad} · <Monto v={Number(celda.valor)} />
        </span>
        {/* Toda la fila: auto-colocado caía en la columna `auto` de `.metrica` y medía su texto entero (407 px a 390). */}
        <span className="min-w-0 text-xs [grid-column:1/-1] [grid-row:3]" style={{ color: 'var(--color-text-secondary)' }} title={categoria.cuando}>
          {categoria.rotulo}
        </span>
      </div>
    </section>
  );
}
