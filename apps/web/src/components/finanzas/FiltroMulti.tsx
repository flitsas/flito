// Un filtro de varias casillas plegado en un desplegable, con resumen visible sin abrirlo.
//
// Nació como `FiltroEstados` del reporte de costos —ocho pastillas siempre desplegadas, una banda
// entera del panel para un filtro que casi nunca se toca— y se generaliza (HU #12434) para que el
// organismo de tránsito use EXACTAMENTE el mismo control: la selección viaja por `valor` (el
// código) y se lee por `nombre`, que es lo que enseña la columna «OT».
//
// Es un `<details>`, el mismo patrón de `RangoFechas` y `ThFiltroMulti`: el navegador ya resuelve
// abrir, cerrar y el foco por teclado.

import { ALTO_CONTROL, type Opcion } from './tiposReporteCostos';

export default function FiltroMulti({
  rotulo, ariaLabel, opciones, seleccion, onCambio, cargando,
  plural = 'seleccionados', textoVacio = 'Sin opciones que ofrecer', textoCualquiera = 'Cualquiera',
}: {
  /** Lo que se lee plegado antes del resumen: «Estado», «OT». */
  rotulo: string;
  /** El nombre completo para el lector de pantalla: «Organismo de tránsito». */
  ariaLabel: string;
  opciones: Opcion[];
  /** Valores marcados. Son `valor`, nunca `nombre`: es lo que viaja al servidor. */
  seleccion: string[];
  onCambio: (v: string[]) => void;
  /** La faceta aún no llegó: la lista lo dice en vez de quedarse muda. */
  cargando?: boolean;
  /** «2 seleccionados» / «2 organismos». */
  plural?: string;
  textoVacio?: string;
  /** El pie que vacía la selección: «Cualquier estado», «Cualquier organismo». */
  textoCualquiera?: string;
}) {
  const alternar = (v: string) =>
    onCambio(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);

  // Con uno marcado se dice su NOMBRE, aunque la faceta todavía no haya llegado a resolverlo: el
  // código a secas es lo único que no se enseña nunca (CF-08), salvo que no haya otra cosa.
  const nombreDe = (v: string) => opciones.find((o) => o.valor === v)?.nombre ?? v;
  const resumen = seleccion.length === 0 ? 'Todos'
    : seleccion.length === 1 ? nombreDe(seleccion[0])
      : `${seleccion.length} ${plural}`;

  return (
    <details className="relative">
      <summary className="flit-focus flex cursor-pointer list-none items-center gap-2 rounded-[10px] border bg-white px-3 text-sm"
        style={{ ...ALTO_CONTROL, borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
        aria-label={ariaLabel}>
        <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>{rotulo}</span>
        <span className="truncate">{resumen}</span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-56 overflow-auto rounded-lg border bg-white p-2 shadow-lg"
        style={{ borderColor: 'var(--flit-border-input)' }}>
        {opciones.length === 0 && (
          <p className="px-1 py-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            {cargando ? 'Cargando…' : textoVacio}
          </p>
        )}
        {opciones.map((o) => (
          <label key={o.valor} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={seleccion.includes(o.valor)} onChange={() => alternar(o.valor)} />
            <span className="truncate">{o.nombre}</span>
          </label>
        ))}
        {seleccion.length > 0 && (
          <button type="button" className="mt-1 w-full text-xs underline" style={{ color: 'var(--flit-text-muted)' }}
            onClick={() => onCambio([])}>{textoCualquiera}</button>
        )}
      </div>
    </details>
  );
}
