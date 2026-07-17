// FlitWizardSidebar — navegación lateral de pasos del prototipo FLIT (wizard
// traspaso, p.14–17): círculos numerados con semántica de color
// (verde=completado · azul=activo · gris=pendiente) y etiquetas. NO es un stepper
// horizontal genérico: en desktop es columna lateral; en mobile se desplaza
// horizontalmente para no robar altura.
interface FlitWizardSidebarProps {
  steps: string[];
  current: number; // paso activo, 1-based
}

export default function FlitWizardSidebar({ steps, current }: FlitWizardSidebarProps) {
  return (
    <ol className="flex flex-row gap-1 overflow-x-auto pb-2 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0" aria-label="Pasos del trámite">
      {steps.map((label, i) => {
        const num = i + 1;
        const done = current > num;
        const active = current === num;
        const circleStyle = done
          ? { background: 'var(--flit-success)', color: '#fff', borderColor: 'var(--flit-success)' }
          : active
            ? { background: 'var(--flit-blue)', color: '#fff', borderColor: 'var(--flit-blue)' }
            : { background: '#fff', color: 'var(--flit-text-muted)', borderColor: 'var(--flit-border-input)' };
        const labelColor = active ? 'var(--flit-blue)' : done ? 'var(--flit-success)' : 'var(--flit-text-muted)';
        return (
          <li key={i} className="flex shrink-0 items-center gap-3 lg:items-stretch" aria-current={active ? 'step' : undefined}>
            <div className="flex flex-col items-center">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-bold"
                style={circleStyle}
              >
                {done ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : num}
              </span>
              {i < steps.length - 1 && (
                <span className="hidden w-px flex-1 lg:block" style={{ minHeight: 18, background: done ? 'var(--flit-success)' : 'var(--flit-border-soft)' }} aria-hidden="true" />
              )}
            </div>
            <span className="whitespace-nowrap py-1 text-xs font-semibold lg:mb-4 lg:text-sm" style={{ color: labelColor }}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
