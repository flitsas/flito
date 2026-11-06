// Sidebar de pasos del asistente (solo >= lg).

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
    <nav aria-label="Pasos del traspaso" className="hidden bg-white p-4 lg:block" style={cardStyle}>
      <ol className="flex flex-col gap-1.5">
        {PASOS.map((label, i) => {
          const n = i + 1; const active = step === n; const cerrado = pasoSoloLectura(n);
          const navOk = pasoNavHabilitado(n);
          return (
            <li key={label}>
              <button type="button" onClick={() => irPaso(n)} disabled={!navOk}
                title={!navOk ? 'Completa los pasos anteriores' : cerrado ? 'Paso cerrado — solo consulta' : n === maxPaso ? 'Paso activo' : undefined}
                className="flit-focus flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-xs disabled:opacity-40"
                style={active ? { background: 'var(--flit-blue-soft)', color: 'var(--flit-blue)', fontWeight: 700 } : { color: 'var(--flit-text-secondary)' }}>
                <span className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold" style={{ background: cerrado ? 'var(--flit-success)' : active ? 'var(--flit-blue)' : navOk ? 'var(--flit-border-soft)' : 'var(--flit-bg-app)', color: cerrado || active ? 'white' : 'var(--flit-text-muted)' }}>{cerrado ? '✓' : n}</span>
                {label}{cerrado ? ' · cerrado' : n === maxPaso ? ' · editable' : ''}
              </button>
            </li>
          );
        })}
      </ol>
      {radicado && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <StatusChip tone={ESTADO_TONE[estado] ?? 'neutral'}>{ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado}</StatusChip>
          <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Paso activo: {maxPaso}{maxPaso > 1 ? ` · ${maxPaso - 1} cerrado(s)` : ''}</p>
        </div>
      )}
    </nav>
  );
}
