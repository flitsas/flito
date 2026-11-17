import { PASOS, WIZARD_VERSION, cardStyle } from './constantes';

// Progreso del wizard con la forma `.pasos` del UI Kit 2026 (cerrado = hecho, activo = actual, resto pendiente).
// Visible en < lg; en >= lg lo sustituye TraspasoPasosNav (un solo asistente por ancho).
export default function ProgresoTraspasoPills({ step, pasoActivo, pasoSoloLectura, pasoNavHabilitado, onIrPaso }: {
  step: number;
  pasoActivo: number;
  pasoSoloLectura: (n: number) => boolean;
  pasoNavHabilitado: (n: number) => boolean;
  onIrPaso: (n: number) => void;
}) {
  return (
    <div className="min-w-0 px-3 py-3 lg:hidden" style={cardStyle}>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="m-0 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--color-text-primary)' }}>
          Progreso del traspaso
        </p>
        <span className="mono text-xs" style={{ color: 'var(--color-text-tertiary)' }} title="Versión del wizard">
          {WIZARD_VERSION}
        </span>
      </div>
      <ol className="kit-pasos !px-0" data-kit="pasos">
        {PASOS.map((label, i) => {
          const n = i + 1;
          const cerrado = pasoSoloLectura(n);
          const activo = n === pasoActivo;
          const actual = n === step;
          const navOk = pasoNavHabilitado(n);
          const estadoPaso = actual ? 'actual' : cerrado ? 'hecho' : 'pendiente';
          return (
            <li key={label} className="kit-paso" data-estado={estadoPaso}>
              <button type="button" disabled={!navOk} onClick={() => onIrPaso(n)}
                title={cerrado ? `${label} — cerrado` : activo ? `${label} — editable` : label}
                className="kit-paso__boton flit-focus px-1 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                <span className="kit-paso__num">{cerrado ? '✓' : `${n}.`}</span>
                <span className="kit-paso__etiqueta"> {label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="m-0 mt-1 px-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        ✓ = cerrado (solo lectura) · paso {pasoActivo} editable · {pasoActivo > 1 ? `${pasoActivo - 1} paso(s) ya cerrados` : 'Aún no hay pasos cerrados'}
      </p>
    </div>
  );
}
