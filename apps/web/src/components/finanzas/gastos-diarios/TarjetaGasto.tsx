// Una de las cinco tarjetas de Gastos diarios (HU #12624): cantidad · valor en la misma línea y,
// debajo, qué cuenta. Sin color por categoría (doc UX): la lectura la dan el orden y el rótulo. Una
// cantidad 0 se pinta «0 · $ 0» en tono apagado, nunca vacía ni con guion (AC3).

import type { GastosDiariosCelda } from '@operaciones/shared-types';
import { FlitCard } from '../../flit/flitPageKit';
import Monto from '../Monto';
import { ariaTarjeta, type CategoriaGasto } from './tiposGastosDiarios';

export default function TarjetaGasto({ categoria, celda }: { categoria: CategoriaGasto; celda: GastosDiariosCelda }) {
  const vacia = celda.cantidad === 0;
  return (
    // La región lleva el nombre completo; lo visible va `aria-hidden` para no leerse dos veces.
    <section role="region" aria-label={ariaTarjeta(categoria, celda.cantidad, celda.valor)}>
      <FlitCard className="h-full">
        <div aria-hidden="true">
          <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{categoria.titulo}</p>
          <p className="mt-1 whitespace-nowrap text-2xl font-bold tabular-nums"
            style={{ color: vacia ? 'var(--flit-text-muted)' : 'var(--flit-text-primary)' }}>
            {celda.cantidad} · <Monto v={Number(celda.valor)} />
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }} title={categoria.cuando}>
            {categoria.rotulo}
          </p>
        </div>
      </FlitCard>
    </section>
  );
}
