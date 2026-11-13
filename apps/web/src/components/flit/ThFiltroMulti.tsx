// Multiselect embebido en el encabezado de una columna.
//
// Vivía dentro de FlitoTramites.tsx. Se extrae aquí porque las colas de SOAT e impuestos necesitan
// el mismo control (HU #10984) y copiarlo habría dejado tres versiones que se separan con el tiempo.
//
// Es un `<details>` y no un menú a mano a propósito: el navegador ya resuelve abrir, cerrar y el
// foco por teclado, y un popover casero en una celda de tabla se rompe con el scroll horizontal.

export type OpcionFiltro = { value: string; label: string };

// Filtro de columna con el aspecto de los controles del kit (borde línea, radio 9, foco azul).
const cls = 'control mt-1 block w-full max-w-[12rem] !min-h-0 px-2 py-1 text-xs font-normal normal-case tracking-normal';

export default function ThFiltroMulti({
  seleccion, onCambio, opciones, placeholder, vacio = 'Sin opciones',
}: {
  seleccion: string[];
  onCambio: (v: string[]) => void;
  opciones: OpcionFiltro[];
  placeholder: string;
  /** Qué decir cuando no hay nada que ofrecer. Por defecto, algo neutro. */
  vacio?: string;
}) {
  const alternar = (v: string) =>
    onCambio(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);

  return (
    <details className="relative mt-1">
      <summary className={`${cls} cursor-pointer list-none`}>
        {seleccion.length ? `${seleccion.length} seleccionado(s)` : placeholder}
      </summary>
      <div className="menu-flotante absolute left-0 z-20 mt-1 max-h-60 w-56 overflow-auto p-1">
        {opciones.length === 0 && (
          <p className="px-2 py-1 text-xs font-normal normal-case text-[color:var(--color-text-tertiary)]">{vacio}</p>
        )}
        {opciones.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--kit-hover)]">
            <input type="checkbox" className="accent-[var(--kit-azul)]" checked={seleccion.includes(o.value)} onChange={() => alternar(o.value)} />
            <span className="truncate" title={o.label}>{o.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
