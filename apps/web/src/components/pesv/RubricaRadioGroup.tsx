// Radio group accesible para los 4 niveles de la rúbrica PESV (Res. 40595/2022).
//
// Reemplaza al slider continuo 0-100 step 5 que permitía valores subjetivos
// arbitrarios. La rúbrica de 4 niveles fuerza criterios objetivos y permite
// que el cierre WORM valide completitud (bloqueo si nivel >= implementado sin
// evidencia adjunta, advertencia si en_desarrollo sin comentario justificativo).
//
// WCAG 2.2 AA: fieldset + legend semántico, radios reales con aria-describedby
// apuntando a los criterios por opción, foco visible del kit (2 px azul) sobre la tarjeta de cada opción,
// prefers-reduced-motion deshabilita transición selected.

import { useId } from 'react';

// Replica del enum definido en apps/api/src/modules/pesv/diagnostico.schemas.ts.
// Local para evitar cross-package import; alineación contractual manual.
export type NivelRubrica = 'no_implementado' | 'en_desarrollo' | 'implementado' | 'sostenido';

interface Props {
  value: NivelRubrica;
  onChange: (next: NivelRubrica) => void;
  disabled?: boolean;
  legend?: string;
  /** id de un elemento descriptivo externo (ej: helper "selecciona nivel basado en evidencia"). */
  describedById?: string;
}

interface Option {
  value: NivelRubrica;
  label: string;
  pct: string;
  criterios: string;
}

const OPTIONS: Option[] = [
  {
    value: 'no_implementado',
    label: 'No implementado',
    pct: '0%',
    criterios: 'Sin documento, sin responsable, sin comunicación',
  },
  {
    value: 'en_desarrollo',
    label: 'En desarrollo',
    pct: '50%',
    criterios: 'Borrador o parcial; responsable identificado; falta aprobación o vigencia. Comentario obligatorio',
  },
  {
    value: 'implementado',
    label: 'Implementado',
    pct: '75%',
    criterios: 'Documento aprobado y firmado, vigente, comunicado, ≥1 evidencia adjunta',
  },
  {
    value: 'sostenido',
    label: 'Sostenido',
    pct: '100%',
    criterios: 'Implementado + ≥1 ciclo de medición + evidencia de mejora',
  },
];

export default function RubricaRadioGroup({
  value,
  onChange,
  disabled = false,
  legend = 'Nivel de cumplimiento (rúbrica)',
  describedById,
}: Props) {
  const groupId = useId();

  return (
    <fieldset
      disabled={disabled}
      className={`@container border-0 p-0 m-0 ${disabled ? 'opacity-60' : ''}`}
      aria-describedby={describedById}
    >
      <legend className="mb-3 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {legend}
      </legend>

      <div className="grid grid-cols-1 @md:grid-cols-1 @lg:grid-cols-2 gap-2">
        {OPTIONS.map((opt) => {
          const id = `${groupId}-${opt.value}`;
          const descId = `${id}-desc`;
          const selected = value === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className={[
                'relative flex items-start gap-3 rounded-[9px] border p-3 transition-colors duration-150',
                'motion-reduce:transition-none',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--kit-azul)]',
                disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                selected
                  ? 'border-[color:var(--kit-azul)] bg-[color:var(--kit-hover)]'
                  : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] hover:bg-[color:var(--kit-hover)]',
              ].join(' ')}
            >
              <input
                id={id}
                type="radio"
                name={groupId}
                value={opt.value}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(opt.value)}
                aria-describedby={descId}
                // Visualmente oculto pero accesible (lectores de pantalla + teclado).
                // `sr-only` mantiene un box 1×1 (no 0×0) para que Playwright.check()
                // pueda interactuar con el radio — PESV-09.
                className="sr-only"
              />

              {/* Indicador visual del radio */}
              <span
                aria-hidden="true"
                className={[
                  'mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 bg-[color:var(--color-surface-elevated)]',
                  selected ? 'border-[color:var(--kit-azul)]' : 'border-[color:var(--color-border-control)]',
                ].join(' ')}
              >
                {selected && <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--kit-azul)]" />}
              </span>

              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className={`text-sm font-medium ${selected ? 'text-[color:var(--color-action)]' : 'text-[color:var(--color-text-primary)]'}`}>
                    {opt.label}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-[color:var(--color-text-tertiary)]">
                    {opt.pct}
                  </span>
                </span>
                <span
                  id={descId}
                  className="mt-1 block text-xs leading-relaxed text-[color:var(--color-text-secondary)]"
                >
                  {opt.criterios}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
