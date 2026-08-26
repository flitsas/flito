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
// abrir, cerrar y el foco por teclado.

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
  if (presets.length === 0) return null;

  return (
    <details className="relative" name="flit-filtros-inteligentes">
      <summary
        className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border px-3 text-sm"
        style={{
          borderColor: activo ? 'var(--flit-blue-text)' : 'var(--flit-border-input)',
          background: activo ? 'rgba(48,102,190,0.08)' : 'white',
          color: 'var(--flit-text-primary)',
        }}
        aria-label="Filtros inteligentes"
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Vista</span>
        {/* El nombre del preset puesto, para que no haya que abrir el desplegable para saberlo. */}
        <span>{activo ?? 'Todo'}</span>
      </summary>

      <div className="absolute z-30 mt-1 w-80 rounded-lg border bg-white p-2 shadow-lg"
        style={{ borderColor: 'var(--flit-border-input)' }}>
        {presets.map((p) => {
          const puesto = p.nombre === activo;
          return (
            <button key={p.nombre} type="button"
              onClick={() => (puesto ? onQuitar() : onAplicar(p))}
              className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-slate-50"
              style={puesto ? { background: 'rgba(48,102,190,0.08)' } : undefined}>
              <span className="block text-sm font-semibold"
                style={{ color: puesto ? 'var(--flit-blue-text)' : 'var(--flit-text-primary)' }}>
                {p.nombre}
              </span>
              {/* Sin esto, un preset es una caja negra: se ve el resultado pero no el criterio. */}
              <span className="block text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                {p.descripcion}
              </span>
            </button>
          );
        })}

        {activo && (
          <button type="button" className="mt-1 w-full text-xs underline"
            style={{ color: 'var(--flit-text-muted)' }} onClick={onQuitar}>
            Ver todo
          </button>
        )}
      </div>
    </details>
  );
}
