// Helpers UI compartidos para modulo PESV (UI Kit 2026: roles del kit, sin alias de la paleta vieja).
import type { ReactNode } from 'react';
import { Icono } from '../flit/kit/Icono';
import { etiquetaKit } from '../flit/kit/tonos';

export const inputCls = 'control w-full';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[color:var(--color-text-secondary)]">{label}</span>
      {children}
    </label>
  );
}

export function Th({ children }: { children?: ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide bg-[color:var(--kit-linea)] text-[color:var(--color-text-primary)]">
      {children}
    </th>
  );
}

export function CloseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return <Icono nombre="cerrar" className={className} />;
}

export function VencimientoPill({ vigenciaHasta }: { vigenciaHasta: string | null }) {
  if (!vigenciaHasta) return <span className="text-xs text-[color:var(--color-text-tertiary)]">Sin vigencia</span>;
  const dias = Math.round((new Date(vigenciaHasta).getTime() - Date.now()) / 86_400_000);
  if (dias <= 0) return <span {...etiquetaKit('danger')}>Vencido</span>;
  if (dias <= 7) return <span {...etiquetaKit('danger')}>{dias}d</span>;
  if (dias <= 30) return <span {...etiquetaKit('warn')}>{dias}d</span>;
  return <span {...etiquetaKit('ok')}>Vigente</span>;
}
