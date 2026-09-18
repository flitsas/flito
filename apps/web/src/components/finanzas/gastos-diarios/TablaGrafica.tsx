// La tabla equivalente de la gráfica (HU #12625, AC4): día × categorías visibles + total del día.
// SIEMPRE está en el DOM —la figura la referencia por `aria-describedby`—: cerrada es `sr-only`
// (el lector la tiene, la vista no), abierta se ve. Por eso es un botón `aria-expanded` y no un
// `<details>`: el `<details>` cerrado esconde su contenido también al lector.

import { FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import Monto from '../Monto';
import type { CategoriaGasto } from './tiposGastosDiarios';
import type { FilaTabla } from './geometriaGrafica';

export const ID_TABLA_GRAFICA = 'gastos-grafica-tabla';

export default function TablaGrafica({ filas, visibles, abierta, onAlternar }: {
  filas: FilaTabla[];
  visibles: readonly CategoriaGasto[];
  abierta: boolean;
  onAlternar: () => void;
}) {
  return (
    <div className="mt-3">
      <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
        aria-expanded={abierta} aria-controls={ID_TABLA_GRAFICA} onClick={onAlternar}>
        {abierta ? 'Ocultar tabla' : 'Ver como tabla'}
      </button>
      {/* Abierta desplaza en vertical: región con foco (como `FlitTable`), o axe la marca sin teclado. */}
      <div className={abierta ? 'flit-focus-inset mt-3 max-h-80 overflow-auto' : 'sr-only'}
        role={abierta ? 'region' : undefined} aria-label={abierta ? 'Tabla de gastos por día' : undefined}
        tabIndex={abierta ? 0 : undefined}
        style={abierta ? { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)' } : undefined}>
        <table id={ID_TABLA_GRAFICA} className="w-full text-sm">
          <caption className="sr-only">Gastos por día y categoría, con el total de cada día</caption>
          <thead>
            <tr>
              <FlitTh estrecha>Día</FlitTh>
              {visibles.map((c) => <FlitTh key={c.clave} estrecha className="text-right">{c.titulo}</FlitTh>)}
              <FlitTh estrecha className="text-right">Total del día</FlitTh>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <FlitTr key={f.dia}>
                <th scope="row" className="px-3 py-1.5 text-left font-normal tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                  {f.diaTexto}
                </th>
                {f.celdas.map((c) => (
                  <td key={c.clave} className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                    {c.cantidad} · <Monto v={c.valor} />
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                  <Monto v={f.total} negrita />
                </td>
              </FlitTr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
