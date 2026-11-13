// Filtros inteligentes: combinaciones de filtros con nombre, en un desplegable.
//
// Los filtros sueltos responden «¿qué cumple esta condición?». Lo que se pregunta de verdad al
// abrir una cola es «¿qué tengo que hacer hoy?», y eso casi nunca es UN filtro: «listos para
// enviar» son dos condiciones, «pendientes de facturar» son otras dos. Ponerlas a mano cada vez
// significa acordarse de las dos, y una sola mal puesta da una lista que parece correcta.
//
// Cada preset DESCRIBE lo que hace debajo del nombre. Un filtro que no dice qué está filtrando es
// peor que ninguno: quien mira la lista no sabe qué se está quedando fuera.
//
// Es un `<details>`, el mismo patrón de `ThFiltroMulti` y `RangoFechas`: el navegador ya resuelve
// abrir, cerrar y el foco por teclado. El menú solo se monta abierto: cerrado, su caja absoluta seguía ocupando
// ancho de desborde (cola de 1616 px en Impuestos a 1280).
import { useState } from 'react';

export interface Preset<F> {
  /** Cómo se llama en el desplegable. En términos de trabajo, no de columnas. */
  nombre: string;
  /** Qué condiciones aplica, en castellano. Va debajo del nombre, siempre visible. */
  descripcion: string;
  /** Los filtros que deja puestos. Se aplica SOBRE el estado limpio, no sobre el actual. */
  filtros: F;
}

export default function FiltrosInteligentes<F>({ presets, activo, onAplicar, onQuitar }: {
  presets: Array<Preset<F>>;
  /** Nombre del preset puesto ahora mismo, o null. */
  activo: string | null;
  onAplicar: (p: Preset<F>) => void;
  onQuitar: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  if (presets.length === 0) return null;

  return (
    <details className="relative" name="flit-filtros-inteligentes" onToggle={(e) => setAbierto(e.currentTarget.open)}>
      <summary
        className={`chip h-10 min-h-0 list-none gap-2 text-sm transition-colors${activo ? ' filtro-activo' : ''}`}
        aria-label="Filtros inteligentes"
      >
        <span className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">Vista</span>
        {/* El nombre del preset puesto, para que no haya que abrir el desplegable para saberlo. */}
        <span>{activo ?? 'Todo'}</span>
      </summary>

      {abierto && (
      <div className="menu-flotante absolute left-0 right-auto z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] p-2">
        {presets.map((p) => {
          const puesto = p.nombre === activo;
          return (
            <button key={p.nombre} type="button"
              onClick={() => (puesto ? onQuitar() : onAplicar(p))}
              className={`block w-full rounded-[7px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--kit-hover)]${puesto ? ' bg-[var(--kit-hover)]' : ''}`}>
              <span className={`block text-sm font-semibold ${puesto ? 'text-[color:var(--color-action)]' : 'text-[color:var(--color-text-primary)]'}`}>
                {p.nombre}
              </span>
              {/* Sin esto, un preset es una caja negra: se ve el resultado pero no el criterio. */}
              <span className="block text-xs text-[color:var(--color-text-tertiary)]">
                {p.descripcion}
              </span>
            </button>
          );
        })}

        {activo && (
          <button type="button" className="btn ghost sm mt-1 w-full" onClick={onQuitar}>
            Ver todo
          </button>
        )}
      </div>
      )}
    </details>
  );
}
