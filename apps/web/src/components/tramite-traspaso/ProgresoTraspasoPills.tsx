import { PASOS, WIZARD_VERSION } from './constantes';

// Barra de progreso del wizard (pills): cerrado / activo / pendiente.
export default function ProgresoTraspasoPills({ step, pasoActivo, pasoSoloLectura, pasoNavHabilitado, onIrPaso }: {
  step: number;
  pasoActivo: number;
  pasoSoloLectura: (n: number) => boolean;
  pasoNavHabilitado: (n: number) => boolean;
  onIrPaso: (n: number) => void;
}) {
  return (
    <div className="rounded-[12px] border px-3 py-2.5 lg:col-span-2"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'white', boxShadow: 'var(--flit-shadow-card)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
          Progreso del traspaso
        </p>
        <span className="font-mono text-[9px]" style={{ color: 'var(--flit-text-muted)' }} title="Versión del wizard">
          {WIZARD_VERSION}
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {PASOS.map((label, i) => {
          const n = i + 1;
          const cerrado = pasoSoloLectura(n);
          const activo = n === pasoActivo;
          const actual = n === step;
          const navOk = pasoNavHabilitado(n);
          const estilo: React.CSSProperties = cerrado
            ? { borderColor: 'var(--flit-success)', color: 'var(--flit-success)', background: 'rgba(112,207,58,0.10)' }
            : activo
              ? { borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)', background: 'var(--flit-blue-soft)', fontWeight: 700 }
              : { borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-muted)', background: 'var(--flit-bg-app)' };
          return (
            <button key={label} type="button" disabled={!navOk} onClick={() => onIrPaso(n)}
              title={cerrado ? `${label} — cerrado` : activo ? `${label} — editable` : label}
              className="flit-focus shrink-0 rounded-[999px] border px-2.5 py-1 text-[10px] disabled:opacity-40"
              style={{ ...estilo, outline: actual ? '2px solid var(--flit-blue)' : undefined }}>
              {cerrado ? '✓' : `${n}.`} {label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        ✓ = cerrado (solo lectura) · paso {pasoActivo} editable · {pasoActivo > 1 ? `${pasoActivo - 1} paso(s) ya cerrados` : 'Aún no hay pasos cerrados'}
      </p>
    </div>
  );
}
