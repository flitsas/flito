import type { ReactNode } from 'react';

// StatusChip — pastilla de estado con semántica cromática FLIT
// (prototype_rules.md · Reglas de color por estado). Radio completo.
export type ChipTone = 'success' | 'active' | 'warning' | 'danger' | 'draft' | 'neutral';

/**
 * Bug #11604 — el chip pintaba texto y punto con el MISMO hex que la superficie teñida, así que el
 * texto no llegaba al 4,5:1 en ningún tono salvo `draft` (`success` daba 1,78: verde lima sobre
 * verde lima pálido). Se separan las dos piezas:
 *
 *   · `dot` — punto decorativo de 6px, `aria-hidden` y redundante con la etiqueta. **Conserva el
 *     color de marca**: es quien carga la identidad cromática y está exento de SC 1.4.11.
 *   · `fg`  — la etiqueta, ahora en la variante tinta (`--flit-*-ink`) del mismo matiz. Es el único
 *     cambio perceptible del arreglo, y solo de verdad en `success` (lima → verde bosque).
 *   · `bg`  — hex OPACO en vez de `rgba()`. Es el mismo color que el `rgba()` daba sobre tarjeta
 *     blanca, pero deja de depender de la superficie padre: con alfa, el mismo chip medía distinto
 *     sobre `--flit-bg-app` —y las filas de `FlitTable` viran a ese fondo en `:hover`, lo que
 *     tumbaba `success` de 4,66 a 4,20 con solo pasar el ratón por encima.
 *
 * Ratios medidos (texto sobre el fondo del propio chip, WCAG 2.x, truncado a 2 decimales):
 *   success 1.78 → 4.66 · warning 2.86 → 4.64 · danger 3.45 → 4.70 · active 3.78 → 4.73
 *   neutral 4.39 → 4.52 (hereda el nuevo --flit-text-muted) · draft 4.75 (sin cambio).
 */
const TONE: Record<ChipTone, { fg: string; dot: string; bg: string }> = {
  success: { fg: 'var(--flit-success-ink)',      dot: 'var(--flit-success)',          bg: 'var(--flit-chip-success-bg)' },
  active:  { fg: 'var(--flit-blue-ink)',         dot: 'var(--flit-info)',             bg: 'var(--flit-chip-active-bg)' },
  warning: { fg: 'var(--flit-warning-ink)',      dot: 'var(--flit-warning)',          bg: 'var(--flit-chip-warning-bg)' },
  danger:  { fg: 'var(--flit-danger-ink)',       dot: 'var(--flit-danger)',           bg: 'var(--flit-chip-danger-bg)' },
  // HU #12819: `draft` y `neutral` tenían la tinta del TEMA (`--flit-draft`, `--flit-text-muted`),
  // que en oscuro se aclara, sobre un fondo pastel que no cambia: «Pendiente» era ilegible. Tinta
  // y fondo salen ahora de tokens `--flit-chip-*`, con par oscuro y medidos por `check:contraste`.
  draft:   { fg: 'var(--flit-chip-draft-ink)',   dot: 'var(--flit-chip-draft-ink)',   bg: 'var(--flit-chip-draft-bg)' },
  neutral: { fg: 'var(--flit-chip-neutral-ink)', dot: 'var(--flit-chip-neutral-ink)', bg: 'var(--flit-chip-neutral-bg)' },
};

/**
 * `icono` (HU #12819): opcional, sustituye al punto. Decorativo —el texto ya dice el estado—, así que
 * el llamador lo pasa con `aria-hidden`. Sin él, el chip es exactamente el de siempre.
 */
export default function StatusChip({ tone = 'neutral', children, icono }: { tone?: ChipTone; children: ReactNode; icono?: ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      // Asidero de QA (HU #12819): el chip ya no siempre lleva el punto (`icono` lo sustituye), así
      // que contar chips por el punto dejó de valer. Sin texto ni rol: no cambia nada para el lector.
      data-flit-chip=""
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold"
      style={{ color: c.fg, background: c.bg, borderRadius: 'var(--flit-radius-pill)' }}
    >
      {icono ?? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} />}
      {children}
    </span>
  );
}
