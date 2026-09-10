// El pie de totales del detalle (CF-10). Recorre LAS MISMAS columnas visibles que la cabecera y el
// cuerpo, así que cada total cae debajo de su concepto aunque una sección esté compactada. Los
// números vienen agregados del API sobre el universo filtrado, no sobre la página: la pantalla no
// suma nada.

import { FlitTr } from '../flit/flitPageKit';
import type { Columna } from './TablaReporteCostos';
import type { Totales } from './tiposReporteCostos';

export default function TotalesReporteCostos({ columnas, totales, total, conCasilla }: {
  columnas: Columna[]; totales: Totales;
  /** Cuántos trámites hay en el filtro entero. */
  total: number;
  /** Si la tabla lleva la columna de casillas, el pie deja ese hueco. */
  conCasilla: boolean;
}) {
  return (
    <tfoot>
      <FlitTr>
        {conCasilla && <td />}
        {columnas.map((c, i) => (
          <td key={c.titulo} className="px-4 py-2 text-right text-xs tabular-nums">
            {i === 0
              ? (
                <span className="block text-left font-semibold whitespace-nowrap" style={{ color: 'var(--flit-text-secondary)' }}>
                  Totales ({total.toLocaleString('es-CO')} trámites del filtro)
                </span>
              )
              : c.total?.(totales)}
          </td>
        ))}
        <td />
      </FlitTr>
    </tfoot>
  );
}
