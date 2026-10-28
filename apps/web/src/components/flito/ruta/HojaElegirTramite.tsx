// FLITO Logística — hoja «Elige el trámite» (resultado `elegir_tramite`, HU #14111). Cada fila es la acción:
// no hay botón primario. Los trámites que FLITO no gestiona quedan deshabilitados y con el motivo en texto.

import { useRef } from 'react';
import ModalPortal from '../../flit/ModalPortal';
import { useEscape, useFocusTrap } from '../../../lib/hooks';
import { flitBtnSecondary } from '../../flit/flitPageKit';
import type { Candidato } from './recogidaTipos';

interface Props {
  placa: string; candidatos: Candidato[];
  onElegir: (c: Candidato) => void; onPendiente: () => void; onCancelar: () => void;
}

export default function HojaElegirTramite({ placa, candidatos, onElegir, onPendiente, onCancelar }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onCancelar);
  useFocusTrap(ref, true);
  return (
    <ModalPortal>
    <div data-flit-modal="" className="fixed inset-0 z-50 flex items-end justify-center lg:items-center" style={{ background: 'rgba(11,22,42,0.55)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancelar(); }}>
      {/* Hoja inferior en móvil (<lg); modal centrado en escritorio. */}
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="hoja-tramite-titulo" data-testid="hoja-tramite"
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-[20px] border-t bg-flit-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 lg:max-w-md lg:rounded-[20px] lg:border"
        style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}>
        <div aria-hidden="true" className="mx-auto mb-3 h-1.5 w-10 rounded-full lg:hidden" style={{ background: 'var(--flit-border-input)' }} />
        <h2 id="hoja-tramite-titulo" tabIndex={-1} className="mb-3 text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>{placa} tiene varios trámites</h2>
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>¿A cuál corresponde esta LT?</p>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Si no sabes cuál es, deja la LT pendiente: Operaciones la asigna después y la firma ya queda tomada.
        </p>
        <ul className="space-y-2">
          {candidatos.map((c) => (
            <li key={c.tramiteId}>
              <button type="button" disabled={!c.gestionable} aria-disabled={!c.gestionable} onClick={() => onElegir(c)}
                className="flit-focus flex w-full flex-col items-start gap-0.5 rounded-xl border bg-flit-card px-4 py-3 text-left transition-colors hover:bg-[var(--flit-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-flit-card"
                style={{ borderColor: 'var(--flit-border-soft)', minHeight: 56 }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  {c.idFlit}{c.companiaNombre ? ` · ${c.companiaNombre}` : ''}
                </span>
                <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                  {c.gestionable ? `Org. ${c.organismoCodigo ?? '—'}` : 'No la recoge FLITO: lo gestiona el cliente.'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className={`${flitBtnSecondary} w-full justify-center`} style={{ minHeight: 48 }} onClick={onPendiente}>
          No sé cuál: dejar pendiente
        </button>
        <button type="button" onClick={onCancelar}
          className="flit-focus mx-auto block rounded px-2 py-2 text-sm font-medium underline-offset-2 transition-colors hover:underline"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          Cancelar (quitar esta LT)
        </button>
      </div>
      </div>
    </div>
    </ModalPortal>
  );
}
