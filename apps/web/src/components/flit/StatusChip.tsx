import type { ReactNode } from 'react';

// StatusChip — pastilla de estado con semántica cromática FLIT
// (prototype_rules.md · Reglas de color por estado). Radio completo.
export type ChipTone = 'success' | 'active' | 'warning' | 'danger' | 'draft' | 'neutral';

const TONE: Record<ChipTone, { fg: string; bg: string }> = {
  success: { fg: 'var(--flit-success)', bg: 'rgba(112, 207, 58, 0.14)' },
  active:  { fg: 'var(--flit-info)',    bg: 'rgba(79, 116, 201, 0.14)' },
  warning: { fg: 'var(--flit-warning)', bg: 'rgba(240, 90, 53, 0.14)' },
  danger:  { fg: 'var(--flit-danger)',  bg: 'rgba(228, 61, 48, 0.14)' },
  draft:   { fg: 'var(--flit-draft)',   bg: 'rgba(89, 103, 125, 0.14)' },
  neutral: { fg: 'var(--flit-text-muted)', bg: 'rgba(125, 135, 152, 0.12)' },
};

export default function StatusChip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold"
      style={{ color: c.fg, background: c.bg, borderRadius: 'var(--flit-radius-pill)' }}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: c.fg }} />
      {children}
    </span>
  );
}
