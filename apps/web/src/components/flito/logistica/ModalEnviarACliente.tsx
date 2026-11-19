// FLITO Logística — «Enviar a cliente» (LT que ya están en FLIT). Registra un viaje con origen FLIT y
// destino cliente: sin precio (tramo sin costo), sin motivo de llegada. El mensajero se elige al
// despachar, en Actas. Nunca se mezclan LT de origen organismo en este POST (409 ORIGEN_MIXTO).
import { useMemo, useRef, useState } from 'react';
import type { CompaniaCerrableLogistica } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { DESTINO_CLIENTE, nombreCompania, nuevaKey } from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

function mensajeEnviar(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    return 'Alguna LT ya no está en FLIT. Se actualizó la lista; revise y vuelva a intentar.';
  }
  if (e instanceof ApiError && e.status === 403) return 'No tiene permiso para registrar viajes.';
  return 'No se pudo registrar el viaje. Inténtelo de nuevo.';
}

interface Props {
  grupo: CompaniaCerrableLogistica;
  onClose: () => void;
  onRegistrado: () => void;
}

export default function ModalEnviarACliente({ grupo, onClose, onRegistrado }: Props) {
  const nombre = nombreCompania(grupo.nombre, grupo.companiaId);
  const lts = useMemo(() => grupo.lts.filter((l) => l.origen === 'flit'), [grupo.lts]);
  const [marcadas, setMarcadas] = useState<Set<string>>(() => new Set(lts.map((l) => l.documentoId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recargar, setRecargar] = useState(false);
  const key = useRef<{ sig: string; key: string } | null>(null);
  const todas = marcadas.size === lts.length;

  const alternar = (id: string) => setMarcadas((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const cerrar = () => { if (recargar) onRegistrado(); else onClose(); };

  const enviar = async () => {
    if (busy || marcadas.size === 0) return;
    setBusy(true); setError(null);
    const ids = lts.filter((l) => marcadas.has(l.documentoId)).map((l) => l.documentoId);
    const sig = ids.join(',');
    if (key.current?.sig !== sig) key.current = { sig, key: nuevaKey() };
    try {
      await api.post('/flito/logistica/traslados', {
        companiaId: grupo.companiaId,
        destino: DESTINO_CLIENTE,
        origen: 'flit',
        lts: ids.map((documentoId) => ({ documentoId })),
      }, { 'Idempotency-Key': key.current.key });
      toastOk(`Viaje a cliente de ${nombre} registrado (${ids.length} LT). Despáchelo desde Actas.`);
      onRegistrado();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setRecargar(true);
      setError(mensajeEnviar(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlitModal title={`Enviar a cliente · ${nombre}`} onClose={cerrar} cierreBloqueado={busy}>
      <div className="space-y-3" aria-busy={busy || undefined}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Estas LT ya están en FLIT. Se enviarán al cliente.
        </p>
        <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>Este tramo no tiene costo.</p>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }} aria-live="polite">
            {marcadas.size} {marcadas.size === 1 ? 'marcada' : 'marcadas'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMarcadas(todas ? new Set() : new Set(lts.map((l) => l.documentoId)))}
            className="flit-focus rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)', minHeight: 40 }}
          >
            {todas ? 'Desmarcar todas' : 'Marcar todas'}
          </button>
        </div>

        <ul role="group" aria-label="LT en FLIT" className="max-h-60 space-y-1 overflow-y-auto">
          {lts.map((lt, i) => {
            const id = `enviar-lt-${lt.documentoId}`;
            return (
              <li key={lt.documentoId}>
                <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm tabular-nums transition-colors hover:bg-[var(--flit-bg-hover)]" style={{ color: 'var(--flit-text-secondary)' }}>
                  <input
                    id={id}
                    type="checkbox"
                    className="flit-focus h-4 w-4"
                    checked={marcadas.has(lt.documentoId)}
                    disabled={busy}
                    autoFocus={i === 0}
                    onChange={() => alternar(lt.documentoId)}
                  />
                  {lt.placa ?? '—'} · LT {lt.numeroLt ?? '—'}
                </label>
              </li>
            );
          })}
        </ul>

        {error && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-text)', background: 'var(--flit-bg-card)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={cerrar} disabled={busy}>Cancelar</button>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} disabled={busy || marcadas.size === 0} onClick={() => void enviar()}>
            {busy ? 'Enviando…' : 'Enviar a cliente'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
