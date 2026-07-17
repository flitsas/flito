// Helpers UI compartidos para modulo PESV (paleta Aura).
import type { ReactNode } from 'react';

export const inputCls = 'w-full px-4 py-2.5 text-sm rounded-xl bg-[color:var(--flit-bg-app)] border border-[color:var(--flit-border-soft)] flit-tone-primary placeholder:flit-tone-muted focus:border-[color:var(--flit-blue)] focus:ring-2 focus:ring-[color:var(--flit-blue)]/30 outline-none transition-colors';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium flit-tone-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}

export function Th({ children }: { children?: ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-semibold flit-tone-muted uppercase tracking-wide bg-[color:var(--flit-bg-app)]">
      {children}
    </th>
  );
}

export function CloseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function VencimientoPill({ vigenciaHasta }: { vigenciaHasta: string | null }) {
  if (!vigenciaHasta) return <span className="flit-tone-muted text-xs">Sin vigencia</span>;
  const dias = Math.round((new Date(vigenciaHasta).getTime() - Date.now()) / 86_400_000);
  if (dias <= 0) return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium flit-danger-bg text-[color:var(--flit-danger)]">Vencido</span>;
  if (dias <= 7) return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium flit-danger-bg text-[color:var(--flit-danger)]">{dias}d</span>;
  if (dias <= 30) return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium flit-warning-bg text-[color:var(--flit-warning)]">{dias}d</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium flit-success-bg text-[color:var(--flit-success)]">Vigente</span>;
}
