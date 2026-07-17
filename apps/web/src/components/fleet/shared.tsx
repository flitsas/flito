// Helpers UI compartidos entre paneles del detalle de flota (tokens FLIT).
import type { ReactNode } from 'react';

export const inputCls =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}

export function Th({ children }: { children?: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}
    >
      {children}
    </th>
  );
}

export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden bg-white"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
      {children}
    </tr>
  );
}

export function CloseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export const btnPrimary =
  'flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-50';
export const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
export const btnSecondary =
  'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-5 text-sm font-medium disabled:opacity-50';
export const btnSecondaryStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' } as const;
