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
import type { Columna } from './definicionColumnasReporteCostos';

/** Mismo `sticky` que las celdas fijas del cuerpo (`TablaReporteCostos`), con fondo de tarjeta. */
const FIJA = 'lg:sticky lg:z-10 bg-flit-card';
import type { Totales, TotalesCostosProveedor } from './tiposReporteCostos';

export default function TotalesReporteCostos({ columnas, totales, costos, total, conCasilla }: {
  columnas: Columna[]; totales: Totales;
  /** El costo de proveedor del filtro: va bajo su grupo, aparte del cobro (no se suma a él). */
  costos: TotalesCostosProveedor;
  /** Cuántos trámites hay en el filtro entero. */
  total: number;
  /** Si la tabla lleva la columna de casillas, el pie deja ese hueco. */
  conCasilla: boolean;
}) {
  // Calculado, no escrito: las columnas visibles antes de la primera con total (las fijas y Esencial
  // por defecto). Sin ninguna con total (Cobro oculto entero), el rótulo ocupa la fila.
  const primeraConTotal = columnas.findIndex((c) => c.total);
  const sinTotal = primeraConTotal === -1 ? columnas.length : primeraConTotal;
  // El rótulo va en las columnas FIJAS y es `sticky` como ellas (desde `lg`): al desplazar la tabla
  // hasta el costo de proveedor, el pie no se corría por debajo de Trámite/Placa y cada suma seguía
  // bajo su columna (segunda pasada, Épica #13763). El resto de columnas sin total, una celda vacía.
  const fijas = columnas.slice(0, sinTotal).filter((c) => c.grupo === 'fija').length;
  const rotuloSpan = fijas > 0 ? fijas : sinTotal;
  const huecoSpan = sinTotal - rotuloSpan;
  const t = { cobro: totales, costo: costos };

  return (
    <tfoot>
      <FlitTr>
        {conCasilla && <td className={`${FIJA} lg:left-0`} />}
        <th scope="row" colSpan={rotuloSpan}
          className={`px-3 py-2 text-left text-xs font-semibold ${fijas > 0 ? `${FIJA} lg:shadow-[inset_-1px_0_0_var(--flit-border-input)]` : 'whitespace-nowrap'}`}
          style={{ color: 'var(--flit-text-secondary)', left: fijas > 0 ? 'var(--rc-izq)' : undefined }}>
          Totales ({total.toLocaleString('es-CO')} trámites del filtro)
        </th>
        {huecoSpan > 0 && <td colSpan={huecoSpan} />}
        {columnas.slice(sinTotal).map((c) => {
          const nombre = c.totalNombre?.(t);
          return (
            <td key={c.id} className="px-3 py-2 text-right text-xs tabular-nums whitespace-nowrap"
              data-pie={c.id} aria-label={nombre} title={nombre}>
              {c.total?.(t)}
            </td>
          );
        })}
        <td className={`${FIJA} lg:right-0`} />
      </FlitTr>
    </tfoot>
  );
}
