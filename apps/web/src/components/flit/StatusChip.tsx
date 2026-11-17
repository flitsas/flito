import type { ReactNode } from 'react';
import type { TonoKit } from './kit/tonos';

/**
 * Etiqueta de estado del UI Kit 2026: izquierda redonda, derecha en punta, fondo al 10 % y contorno 1 px.
 * Mantiene los tonos de FLITO y los traduce a los del kit (marcador E2E: `data-tono`).
 */
export type ChipTone = 'success' | 'active' | 'warning' | 'danger' | 'draft' | 'neutral';

const TONO: Record<ChipTone, TonoKit> = {
  success: 'ok', active: 'info', warning: 'warn', danger: 'danger', draft: 'neutro', neutral: 'neutro',
};

export default function StatusChip({
  tone = 'neutral', children, icono, tono,
}: { tone?: ChipTone; children: ReactNode; icono?: ReactNode; /** Tono del kit directo (gana a `tone`). */ tono?: TonoKit }) {
  return (
    <span
      data-flit-chip=""
      data-tono={tono ?? TONO[tone]}
      className={`kit-etiqueta${icono ? ' kit-etiqueta--icono' : ''}`}
    >
      {icono ?? <span aria-hidden="true" className="kit-etiqueta__punto" />}
      {children}
    </span>
  );
}
