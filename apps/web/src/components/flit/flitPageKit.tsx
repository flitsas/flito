import type { CSSProperties, ReactNode } from 'react';

export const flitInp =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export const flitPillWrap: CSSProperties = {
  background: 'var(--flit-bg-app)',
  border: '1px solid var(--flit-border-soft)',
};

export function flitPillBtn(active: boolean): CSSProperties {
  return active
    ? { background: '#fff', color: 'var(--flit-blue)', boxShadow: 'var(--flit-shadow-card)' }
    : { color: 'var(--flit-text-muted)' };
}

export function FlitTable({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden bg-white"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      <div className="overflow-x-auto"><table className="w-full">{children}</table></div>
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

export function FlitPillGroup({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex w-fit flex-wrap gap-1 rounded-[999px] p-1" style={flitPillWrap}>
      {children}
    </div>
  );
}

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
      className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold capitalize transition-colors"
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
