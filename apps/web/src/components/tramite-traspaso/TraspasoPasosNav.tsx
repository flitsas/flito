// Asistente de pasos del traspaso con la forma `.pasos` del UI Kit 2026 (horizontal, solo >= lg; en < lg lo
// sustituye ProgresoTraspasoPills). Bajo los pasos, la píldora del trámite con su estado STT.

import { ESTADO_STT_LABEL, type TramiteEstadoStt } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { ESTADO_TONE, PASOS, cardStyle } from './constantes';

export default function TraspasoPasosNav({ step, maxPaso, radicado, estado, pasoSoloLectura, pasoNavHabilitado, irPaso }: {
  step: number;
  maxPaso: number;
  radicado: string | null;
  estado: string;
  pasoSoloLectura: (n: number) => boolean;
  pasoNavHabilitado: (n: number) => boolean;
  irPaso: (n: number) => void;
}) {
  return (
    <nav aria-label="Pasos del traspaso" className="hidden pb-3 lg:block" style={cardStyle}>
      <ol className="kit-pasos" data-kit="pasos">
        {PASOS.map((label, i) => {
          const n = i + 1; const active = step === n; const cerrado = pasoSoloLectura(n);
          const navOk = pasoNavHabilitado(n);
          const estadoPaso = active ? 'actual' : cerrado ? 'hecho' : 'pendiente';
          return (
            <li key={label} className="kit-paso" data-estado={estadoPaso}>
              <button type="button" onClick={() => irPaso(n)} disabled={!navOk}
                title={!navOk ? 'Completa los pasos anteriores' : cerrado ? 'Paso cerrado — solo consulta' : n === maxPaso ? 'Paso activo' : undefined}
                className="kit-paso__boton flit-focus px-1 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                <span className="kit-paso__num">{cerrado ? '✓' : n}</span>
                <span className="kit-paso__etiqueta">{label}</span>
                <span className="kit-paso__sub">{cerrado ? ' · cerrado' : n === maxPaso ? ' · editable' : ''}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {radicado && (
        <div className="mx-4 mt-2 flex flex-wrap items-center gap-3 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
          <StatusChip tone={ESTADO_TONE[estado] ?? 'neutral'}>{ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado}</StatusChip>
          <p className="m-0 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Paso activo: {maxPaso}{maxPaso > 1 ? ` · ${maxPaso - 1} cerrado(s)` : ''}</p>
        </div>
      )}
    </nav>
  );
}
