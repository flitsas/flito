// El detalle del día activo de la gráfica (HU #12625, AC3): día, cantidad y valor por categoría
// visible y la suma del día, con `Monto`. Alto mínimo fijo para que aparecer y desaparecer no mueva
// la tabla de abajo. El anuncio para lector de pantalla va en un `role="status"` FUERA del svg: un
// `aria-live` dentro de un `<svg>` no lo leen todos los lectores.

import Monto from '../Monto';
import { diaCorto } from './tiposGastosDiarios';
import { textoDetalleDia, type BarraDia } from './geometriaGrafica';

export default function DetalleDia({ barra }: { barra: BarraDia | null }) {
  return (
    <>
      <div className="mt-2 min-h-12 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {barra
          ? (
            <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <div className="flex gap-1">
                <dt className="sr-only">Día</dt>
                <dd className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{diaCorto(barra.dia, true)}</dd>
              </div>
              {barra.segmentos.map((s) => (
                <div key={s.clave} className="flex gap-1">
                  <dt>{s.categoria.titulo}</dt>
                  <dd className="tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                    {s.cantidad} · <Monto v={s.valor} />
                  </dd>
                </div>
              ))}
              <div className="flex gap-1">
                <dt>Total del día</dt>
                <dd className="tabular-nums" style={{ color: 'var(--flit-text-primary)' }}><Monto v={barra.total} negrita /></dd>
              </div>
            </dl>
          )
          : <p>Pasa el puntero por una barra, o Tab y las flechas, para ver el detalle de un día.</p>}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{barra ? textoDetalleDia(barra) : ''}</p>
    </>
  );
}
