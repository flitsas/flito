import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import StatusChip, { type ChipTone } from './StatusChip';

// KpiCard — tarjeta blanca FLIT para métricas/atajos (prototipo p.4–5). Valor
// grande azul marino, etiqueta superior, chip de estado opcional, hint y slot
// (`children`) para sparkline u otro contenido. Si recibe `to`, es enlace
// accesible con foco visible.
interface KpiCardProps {
  to?: string;
  ariaLabel?: string;
  label: string;
  value: ReactNode;
  hint?: string;
  chip?: { tone: ChipTone; label: string };
  children?: ReactNode;
}

const CARD_STYLE = {
  borderRadius: 'var(--flit-radius-card)',
  boxShadow: 'var(--flit-shadow-card)',
  border: '1px solid var(--flit-border-soft)',
} as const;

export default function KpiCard({ to, ariaLabel, label, value, hint, chip, children }: KpiCardProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>
          {label}
        </p>
        {chip && <StatusChip tone={chip.tone}>{chip.label}</StatusChip>}
      </div>
      <p className="mt-3 text-4xl font-bold tabular-nums tracking-tight leading-none" style={{ color: 'var(--flit-text-primary)' }}>
        {value}
      </p>
      {hint && <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{hint}</p>}
      {children}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        aria-label={ariaLabel ?? label}
        className="flit-focus flex flex-col bg-white p-6 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
        style={CARD_STYLE}
      >
        {inner}
      </Link>
    );
  }
  return <div className="flex flex-col bg-white p-6" style={CARD_STYLE}>{inner}</div>;
}
