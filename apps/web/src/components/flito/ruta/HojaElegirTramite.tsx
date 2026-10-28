// FLITO Logística — hoja «Elige el trámite» (resultado `elegir_tramite`, HU #14111). Cada fila es la acción:
// no hay botón primario. Los trámites que FLITO no gestiona quedan deshabilitados y con el motivo en texto.

import FlitModal from '../../flit/FlitModal';
import { flitBtnSecondary } from '../../flit/flitPageKit';
import type { Candidato } from './recogidaTipos';

interface Props {
  placa: string; candidatos: Candidato[];
  onElegir: (c: Candidato) => void; onPendiente: () => void; onCancelar: () => void;
}

export default function HojaElegirTramite({ placa, candidatos, onElegir, onPendiente, onCancelar }: Props) {
  return (
    <FlitModal title={`${placa} tiene varios trámites`} onClose={onCancelar}>
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
          style={{ color: 'var(--flit-text-secondary)' }}>
          Cancelar (quitar esta LT)
        </button>
      </div>
    </FlitModal>
  );
}
