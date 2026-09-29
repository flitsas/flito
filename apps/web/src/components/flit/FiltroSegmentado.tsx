// FLITO kit — Filtro segmentado: un grupo de botones exclusivos para filtros rápidos de conjunto
// («Todas · X · Y»). Lo estrenó la fuente del trámite (HU #13071) y a él migró el de autogestión.
//
// El activo es tinta azul sobre velo (`--flit-pill-active-ink` sobre `--flit-bg-app`), el par que ya
// usan las pills y que tiene par oscuro. NO blanco sobre `--flit-blue-text`: en oscuro ese azul es
// claro y el contraste cae a ~1,8:1. La transición es solo del hover (lección de la HU #12997): el
// cambio de activo no se anima.

export interface OpcionSegmento<T extends string> {
  valor: T;
  etiqueta: string;
}

interface Props<T extends string> {
  opciones: ReadonlyArray<OpcionSegmento<T>>;
  valor: T;
  onCambio: (v: T) => void;
  /** Nombre accesible del grupo (p. ej. «Filtrar por fuente»). */
  ariaLabel: string;
  /** Rótulo visible delante del grupo; opcional. */
  rotulo?: string;
}

const BASE = 'flit-focus h-9 whitespace-nowrap rounded-lg border px-3 text-xs font-semibold';
const REPOSO = `${BASE} hover:bg-[var(--flit-bg-hover)] hover:transition-colors`;

export default function FiltroSegmentado<T extends string>({ opciones, valor, onCambio, ariaLabel, rotulo }: Props<T>) {
  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-1">
      {rotulo && (
        <span className="mr-1 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }} aria-hidden="true">
          {rotulo}
        </span>
      )}
      {/* Envuelve solo si el grupo no cabe ni en su propia línea (autogestión a 360 px); el de
          fuente (~230 px) nunca se parte. */}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={ariaLabel}>
        {opciones.map((o) => {
          const activa = o.valor === valor;
          return (
            <button key={o.valor || 'todas'} type="button" aria-pressed={activa} onClick={() => onCambio(o.valor)}
              className={activa ? BASE : REPOSO}
              style={activa
                ? { background: 'var(--flit-bg-app)', color: 'var(--flit-pill-active-ink)', borderColor: 'var(--flit-pill-active-ink)' }
                : { background: 'transparent', color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border-input)' }}>
              {o.etiqueta}
            </button>
          );
        })}
      </div>
    </div>
  );
}
