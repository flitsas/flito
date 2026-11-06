// FLITO Logística — tarjeta de una LT en la lista de «Recoger licencias» (HU #14111). Siempre visibles:
// placa, N.º de LT y estado. VIN, licencia, combustible y propietario quedan tras «Ver datos».

import { useId, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { MENSAJE_LT_NO_ENCONTRADA } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import { flitInp } from '../../flit/flitPageKit';
import { CHIP, TEXTO_ESTADO, type FilaLt } from './recogidaTipos';

const LT_DIGITOS = 11;
// El N.º de LT es siempre «LT» + 11 dígitos. El prefijo se muestra fijo; el operario teclea solo los dígitos.
const soloDigitosLt = (v: string) => v.replace(/^\s*LT/i, '').replace(/\D/g, '').slice(0, LT_DIGITOS);

interface Props {
  fila: FilaLt; onChangeLt: (v: string) => void; onBorrar: () => void; onReintentar: () => void; onElegir: () => void;
}

export default function TarjetaLtRecogida({ fila, onChangeLt, onBorrar, onReintentar, onElegir }: Props) {
  const [datos, setDatos] = useState(false);
  const ayudaId = useId();
  const digitos = soloDigitosLt(fila.numeroLt);
  const faltan = digitos.length > 0 ? LT_DIGITOS - digitos.length : 0;
  const chip = fila.registro === 'registrando' ? { tono: 'neutral' as const, texto: 'Registrando…' } : fila.registro === 'encolada' ? { tono: 'neutral' as const, texto: 'En cola' } : CHIP[fila.estado];
  const editable = !fila.manual && fila.registro === 'no';
  const bloqueado = fila.registro === 'registrando' || fila.firmada;
  const texto = fila.estado === 'sin_tramite' ? MENSAJE_LT_NO_ENCONTRADA : fila.estado === 'error' ? fila.motivo : TEXTO_ESTADO[fila.estado];
  const hayDatos = !!(fila.vin || fila.propietario || fila.numeroLicencia || fila.combustible);

  return (
    <article className="rounded-xl border bg-flit-card p-3.5" style={{ borderColor: 'var(--flit-border-soft)' }} aria-label={`LT ${fila.placa}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-lg font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fila.placa}</span>
        <div className="flex flex-wrap items-center justify-end gap-1.5" aria-live="polite">
          {fila.manual && <StatusChip tone="draft">A mano</StatusChip>}
          <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
          {!bloqueado && (
            <button type="button" aria-label={`Quitar LT ${fila.placa}`} title="Quitar LT" onClick={onBorrar}
              className="flit-focus -mr-1 grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{ color: 'var(--flit-text-secondary)' }}>
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2">
        {editable ? (
          <div>
            <label htmlFor={`${ayudaId}-lt`} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>N.º de LT</label>
            <div className="flex items-stretch">
              <span aria-hidden="true" className="inline-flex select-none items-center rounded-l-[10px] border border-r-0 px-3 text-sm font-semibold tabular-nums"
                style={{ borderColor: 'var(--flit-border-input)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>LT</span>
              <input id={`${ayudaId}-lt`} className={`${flitInp} min-w-0 !rounded-l-none tabular-nums`} inputMode="numeric" autoComplete="off" maxLength={LT_DIGITOS + 4}
                value={digitos} placeholder="11 dígitos" disabled={bloqueado} aria-describedby={`${ayudaId}-lt-ayuda`}
                onChange={(ev) => { const d = soloDigitosLt(ev.target.value); onChangeLt(d ? `LT${d}` : ''); }} />
            </div>
            <p id={`${ayudaId}-lt-ayuda`} className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              {faltan > 0 ? <span className="font-semibold">Faltan {faltan} {faltan === 1 ? 'dígito' : 'dígitos'}. </span> : null}
              Escribe solo los {LT_DIGITOS} dígitos que van después de «LT».
            </p>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            N.º de LT <span className="font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fila.numeroLt || '—'}</span>
          </p>
        )}
      </div>

      {texto && <p className="mt-1.5 text-xs" style={{ color: fila.estado === 'sin_tramite' || fila.estado === 'error' ? 'var(--flit-danger-text)' : 'var(--flit-text-secondary)' }}>{texto}</p>}
      {fila.companiaNombre && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{fila.companiaNombre}</p>}

      {(fila.estado === 'error' || fila.registro === 'error') && (
        <button type="button" onClick={onReintentar}
          className="flit-focus mt-2 rounded px-1 py-2 text-sm font-semibold underline-offset-2 transition-colors hover:underline" style={{ color: 'var(--flit-blue-text)', minHeight: 40 }}>
          Reintentar
        </button>
      )}
      {fila.estado === 'elegir' && (
        <button type="button" onClick={onElegir}
          className="flit-focus mt-2 rounded px-1 py-2 text-sm font-semibold underline-offset-2 transition-colors hover:underline" style={{ color: 'var(--flit-blue-text)', minHeight: 40 }}>
          Elegir trámite
        </button>
      )}

      {hayDatos && (
        <>
          <button type="button" aria-expanded={datos} onClick={() => setDatos((d) => !d)}
            className="flit-focus mt-1 inline-flex items-center gap-1 rounded px-1 py-2 text-xs font-semibold transition-colors hover:underline" style={{ color: 'var(--flit-blue-text)', minHeight: 40 }}>
            Ver datos <ChevronDown size={14} aria-hidden="true" className={datos ? 'rotate-180' : ''} />
          </button>
          {datos && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {fila.propietario && (<><dt style={{ color: 'var(--flit-text-muted)' }}>Propietario</dt><dd>{fila.propietario}</dd></>)}
              {fila.vin && (<><dt style={{ color: 'var(--flit-text-muted)' }}>VIN</dt><dd className="break-all tabular-nums">{fila.vin}</dd></>)}
              {fila.numeroLicencia && (<><dt style={{ color: 'var(--flit-text-muted)' }}>Licencia</dt><dd className="tabular-nums">{fila.numeroLicencia}</dd></>)}
              {fila.combustible && (<><dt style={{ color: 'var(--flit-text-muted)' }}>Combustible</dt><dd>{fila.combustible}</dd></>)}
            </dl>
          )}
        </>
      )}
    </article>
  );
}
