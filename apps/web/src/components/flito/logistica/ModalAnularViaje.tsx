// FLITO Logística — «Anular viaje» (solo viajes `registrado`, función logistica.traslado.anular).
// Motivo obligatorio (máx. 300). Copy fijo por causa: nunca el texto crudo del API.
import { useState } from 'react';
import { DESTINO_TRASLADO_LOGISTICA_LABEL, type FilaEntregaLogistica } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { nombreCompania } from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import { FlitField, flitBtnDanger, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';

const MAX_MOTIVO = 300;

interface Props {
  viaje: FilaEntregaLogistica;
  fechaTexto: string;
  onClose: () => void;
  /** `recargar`: el viaje cambió de estado (409) o se anuló; `sinPermiso`: 403, oculta la columna. */
  onTermino: (r: { anulado: boolean; recargar: boolean; sinPermiso: boolean }) => void;
}

export default function ModalAnularViaje({ viaje, fechaTexto, onClose, onTermino }: Props) {
  const [motivo, setMotivo] = useState('');
  const [tocado, setTocado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState<{ recargar: boolean; sinPermiso: boolean }>({ recargar: false, sinPermiso: false });
  const nombre = nombreCompania(viaje.companiaNombre, viaje.companiaId);
  const vacio = motivo.trim() === '';

  const cerrar = () => {
    if (estado.recargar || estado.sinPermiso) onTermino({ anulado: false, ...estado });
    else onClose();
  };

  const anular = async () => {
    if (vacio || busy) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/flito/logistica/traslados/${viaje.id}/anular`, { motivo: motivo.trim() });
      toastOk('Viaje anulado. Las LT quedaron disponibles de nuevo.');
      onTermino({ anulado: true, recargar: true, sinPermiso: false });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setEstado({ recargar: true, sinPermiso: false });
        setError('Este viaje ya no se puede anular porque cambió de estado.');
      } else if (e instanceof ApiError && e.status === 403) {
        setEstado({ recargar: false, sinPermiso: true });
        setError('No tiene permiso para anular viajes.');
      } else {
        setError('No se pudo anular el viaje. Inténtelo de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlitModal title="Anular viaje" onClose={cerrar} cierreBloqueado={busy}>
      <div className="space-y-3" aria-busy={busy || undefined}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {nombre} · {DESTINO_TRASLADO_LOGISTICA_LABEL[viaje.destino]} · {viaje.cantidadLt} LT · registrado el {fechaTexto}
        </p>
        <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
          Las LT volverán a estar disponibles en Viajes. Esta acción no se puede deshacer.
        </p>

        <FlitField label="Motivo de la anulación (obligatorio)">
          <textarea
            className={`${flitInp} hover:bg-[var(--flit-bg-hover)]`}
            rows={3}
            maxLength={MAX_MOTIVO}
            autoFocus
            value={motivo}
            disabled={busy}
            placeholder="Por ejemplo: viaje registrado por error"
            aria-describedby="anular-motivo-ayuda"
            aria-invalid={tocado && vacio ? true : undefined}
            onBlur={() => setTocado(true)}
            onChange={(e) => setMotivo(e.target.value.slice(0, MAX_MOTIVO))}
          />
        </FlitField>
        <div id="anular-motivo-ayuda" className="flex items-start justify-between gap-3 text-xs">
          <span role={tocado && vacio ? 'alert' : undefined} style={{ color: 'var(--flit-danger-text)' }}>
            {tocado && vacio ? 'Escriba el motivo de la anulación.' : ''}
          </span>
          <span aria-live="polite" className="tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{motivo.length}/{MAX_MOTIVO}</span>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-text)', background: 'var(--flit-bg-card)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={cerrar} disabled={busy}>Volver</button>
          <button type="button" className={`${flitBtnDanger} w-full sm:w-auto`} disabled={vacio || busy || estado.sinPermiso || estado.recargar} onClick={() => void anular()}>
            <span aria-live="polite">{busy ? 'Anulando…' : 'Anular viaje'}</span>
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
