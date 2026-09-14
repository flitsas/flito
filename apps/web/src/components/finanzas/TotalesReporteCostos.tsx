// El pie de totales del detalle (CF-10). Recorre LAS MISMAS columnas visibles que la cabecera y el
// cuerpo, así que cada total cae debajo de su concepto aunque una sección esté compactada. Los
// números vienen agregados del API sobre el universo filtrado, no sobre la página: la pantalla no
// suma nada.
//
// El rótulo «Totales (N trámites del filtro)» ya no vive en la celda de Empresa (HU #12539, D-15):
// medía más que cualquier razón social y ensanchaba esa columna en todas las filas. Va en un
// `th[scope=row]` con `colSpan` sobre las columnas que no llevan total —las que hay ANTES de la
// primera con `total`—, que es lo que es: la cabecera de la fila de totales. Un lector de pantalla
// lo lee así, y no hay celdas vacías de relleno delante.

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
  // Calculado, no escrito: 5 en compacta y 18 en ampliada hoy, y lo que toque si una columna se
  // mueve. Sin ninguna con total (no pasa: Valores siempre trae Total), el rótulo ocupa la fila.
  const primeraConTotal = columnas.findIndex((c) => c.total);
  const sinTotal = primeraConTotal === -1 ? columnas.length : primeraConTotal;

  return (
    <tfoot>
      <FlitTr>
        {conCasilla && <td />}
        <th scope="row" colSpan={sinTotal} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap"
          style={{ color: 'var(--flit-text-secondary)' }}>
          Totales ({total.toLocaleString('es-CO')} trámites del filtro)
        </th>
        {columnas.slice(sinTotal).map((c) => (
          <td key={c.titulo} className="px-3 py-2 text-right text-xs tabular-nums">{c.total?.(totales)}</td>
        ))}
        <td />
      </FlitTr>
    </tfoot>
  );
}
