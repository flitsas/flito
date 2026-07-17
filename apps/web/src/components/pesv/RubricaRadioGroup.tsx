// Radio group accesible para los 4 niveles de la rúbrica PESV (Res. 40595/2022).
//
// Reemplaza al slider continuo 0-100 step 5 que permitía valores subjetivos
// arbitrarios. La rúbrica de 4 niveles fuerza criterios objetivos y permite
// que el cierre WORM valide completitud (bloqueo si nivel >= implementado sin
// evidencia adjunta, advertencia si en_desarrollo sin comentario justificativo).
//
// WCAG 2.2 AA: fieldset + legend semántico, radios reales con aria-describedby
// apuntando a los criterios por opción, focus-visible heredado de tokens Aura,
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

function CheckIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function DotIcon({ className = 'w-2 h-2' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

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
      <legend className="block text-[11px] font-medium flit-tone-secondary mb-3 uppercase tracking-wide">
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
                'relative flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150',
                'motion-reduce:transition-none',
                disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                selected
                  ? 'border-[color:var(--flit-blue)] flit-tone-active-bg'
                  : 'border-[color:var(--flit-border-soft)] bg-white hover:bg-[color:var(--flit-bg-app)]',
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
                  'flex-shrink-0 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full border',
                  selected
                    ? 'border-[color:var(--flit-blue)] bg-[color:var(--flit-blue)] text-[color:var(--color-accent-foreground)]'
                    : 'border-[color:var(--flit-border-soft)]-strong bg-white flit-tone-muted',
                ].join(' ')}
              >
                {selected ? <CheckIcon /> : <DotIcon />}
              </span>

              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className={`text-sm font-medium ${selected ? 'text-[color:var(--flit-blue)]' : 'flit-tone-primary'}`}>
                    {opt.label}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums flit-tone-muted">
                    {opt.pct}
                  </span>
                </span>
                <span
                  id={descId}
                  className="block mt-1 text-xs leading-relaxed flit-tone-secondary"
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
