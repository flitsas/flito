import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

export const flitInp =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export const flitPillWrap: CSSProperties = {
  background: 'var(--flit-bg-app)',
  border: '1px solid var(--flit-border-soft)',
};

export function flitPillBtn(active: boolean): CSSProperties {
  return active
    // `--flit-blue` es color de SUPERFICIE: como texto sobre el blanco de la pill activa daba 4,49
    // (bug #11604). La variante tinta sube a 5,61 sin mover el azul de marca.
    ? { background: '#fff', color: 'var(--flit-blue-ink)', boxShadow: 'var(--flit-shadow-card)' }
    : { color: 'var(--flit-text-muted)' };
}

/**
 * ¿El contenedor desborda en horizontal? Sirve para dar `tabindex` SOLO cuando hay algo que
 * desplazar: un `tabindex="0"` fijo mete una parada de tabulador en cada tabla del producto,
 * incluidas las que caben enteras en pantalla, que es justo la molestia que el arreglo de
 * `scrollable-region-focusable` no debe crear.
 */
function useDesbordaX(ref: RefObject<HTMLElement | null>): boolean {
  const [desborda, setDesborda] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // +1px de tolerancia: con zoom o anchos fraccionarios `scrollWidth` supera a `clientWidth` por
    // redondeo sin que haya nada que desplazar.
    const medir = () => setDesborda(el.scrollWidth > el.clientWidth + 1);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    // También la <table>: cambia de ancho al pintar filas nuevas sin que el contenedor se mueva.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [ref]);
  return desborda;
}

/**
 * Tabla FLIT. El `div` interno desplaza en horizontal, y hasta #11604 no era alcanzable con el
 * teclado: en una tabla de 13 columnas, quien no usa ratón no llegaba a las de la derecha
 * (`scrollable-region-focusable`). Ahora recibe foco —solo cuando desborda de verdad— y se
 * anuncia como región con nombre si el llamador le pasa uno.
 *
 * El anillo de foco es `.flit-focus-inset` y no el `.flit-focus` de siempre porque el contenedor
 * exterior tiene `overflow: hidden` para redondear las esquinas: un anillo hacia fuera quedaría
 * recortado e invisible.
 */
export function FlitTable({ children, label }: { children: ReactNode; label?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const desborda = useDesbordaX(scrollRef);
  return (
    <div
      className="overflow-hidden bg-white"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      <div
        ref={scrollRef}
        className="flit-focus-inset overflow-x-auto"
        tabIndex={desborda ? 0 : undefined}
        role={label ? 'region' : undefined}
        aria-label={label}
      >
        <table className="w-full">{children}</table>
      </div>
    </div>
  );
}

export function FlitTh({ children, center, className = '' }: { children?: ReactNode; center?: boolean; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 ${center ? 'text-center' : 'text-left'} text-[11px] font-semibold uppercase tracking-wide ${className}`}
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}
    >
      {children}
    </th>
  );
}

export function FlitTr({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
      {children}
    </tr>
  );
}

export function FlitField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}

export const flitBtnPrimary = 'flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-50';
export const flitBtnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
export const flitBtnSecondary = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-5 text-sm font-medium disabled:opacity-50';
export const flitBtnSecondaryStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' } as const;
/**
 * Variante compacta del secundario, para acciones que viven DENTRO de una celda junto a datos.
 *
 * Comparte estilo con `flitBtnSecondary` —mismo borde, mismo color— y solo baja alto, tipografía y
 * relleno: a la altura normal el botón manda más que el dato que acompaña y descuadra el alto de la
 * fila. Se usa el mismo `flitBtnSecondaryStyle`.
 */
export const flitBtnSecondarySm = 'flit-focus inline-flex h-7 items-center rounded-[999px] border bg-white px-3 text-xs font-medium disabled:opacity-50';

export function FlitCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-white p-5 ${className}`}
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      {children}
    </div>
  );
}

/**
 * El grupo de pills. `role` y `label` existen para el caso en el que las pills no son un filtro
 * sino una NAVEGACIÓN por pestañas (`role="tablist"`, HU #11633): el patrón ARIA exige que el
 * contenedor lleve el rol y un nombre, y sin estas dos props el llamador tendría que envolver el
 * grupo en otro `div` —perdiendo el `flex` que separa las pills— o duplicar la caja entera.
 * Omitidas, se comporta exactamente igual que antes.
 */
export function FlitPillGroup(
  { children, role, label }: { children: ReactNode; role?: 'tablist'; label?: string },
) {
  return (
    <div
      className="inline-flex w-fit flex-wrap gap-1 rounded-[999px] p-1"
      style={flitPillWrap}
      role={role}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * La clase de una pill, aparte del componente.
 *
 * Se exporta porque una pill que además es una PESTAÑA (`role="tab"`, `aria-selected`, `tabIndex`
 * itinerante y flechas del teclado) no cabe como props de `FlitPillButton` sin convertirlo en un
 * `<button>` genérico; y si esa pestaña copiara la clase a mano, el día que esta cambie habría dos
 * pills distintas en el producto. Compartir la clase es lo que garantiza que no haya deriva visual.
 */
export const flitPillBtnClase =
  'flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold capitalize transition-colors';

export function FlitPillButton(
  { active, onClick, children, pressed }:
  { active: boolean; onClick: () => void; children: ReactNode;
    /** `aria-pressed`. Sin él, un lector anuncia varios botones idénticos sin decir cuál está puesto. */
    pressed?: boolean },
) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={flitPillBtnClase}
      style={flitPillBtn(active)}
    >
      {children}
    </button>
  );
}

export function FlitEmpty({ children }: { children: ReactNode }) {
  return (
    <div
      className="p-12 text-center text-sm"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}
    >
      {children}
    </div>
  );
}
