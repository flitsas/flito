// FLITO — Servicios adicionales: el diálogo de baja (HU #12542). UX §6.3 y §6.6.
//
// Baja LÓGICA: `POST /:id/baja`, nunca `DELETE`. Cancelar, Esc y el fondo cierran sin petición
// (AC5). El botón rojo va en `--flit-danger-ink` (la tinta, no la superficie: con texto blanco la
// superficie se queda en 3,9:1) y sin gradiente: es irreversible. El foco entra al diálogo, no al
// botón rojo. Tras confirmar, el botón que lo abrió desaparece con la fila: `restoreFocusRef`
// apunta al `<h2>` «Tipos» de la tarjeta. El 404 («otro lo dio de baja antes») se devuelve a la
// página, que cierra, avisa y repide.

import { useState, type RefObject } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { RUTA_SERVICIOS_ADICIONALES, type ServicioAdicionalTipo } from '../../lib/serviciosAdicionales';
import FlitModal from '../flit/FlitModal';
import { flitBtnPrimary, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

interface Props {
  tipo: ServicioAdicionalTipo;
  onClose: () => void;
  onDadoDeBaja: () => void;
  onNoDisponible: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export default function DialogoBajaTipoServicio({ tipo, onClose, onDadoDeBaja, onNoDisponible, restoreFocusRef }: Props) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmar = () => {
    if (enviando) return;
    setEnviando(true); setError(null);
    api.post<ServicioAdicionalTipo>(`${RUTA_SERVICIOS_ADICIONALES}/${tipo.id}/baja`)
      .then(() => onDadoDeBaja())
      .catch((e: unknown) => {
        setEnviando(false);
        if (e instanceof ApiError && e.status === 404) { onNoDisponible(); return; }
        setError(`No se pudo dar de baja. Vuelve a intentarlo. ${errorMessage(e)}`);
      });
  };

  return (
    <FlitModal title={`Dar de baja «${tipo.nombre}»`} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <p>
          «{tipo.nombre}» dejará de ofrecerse como servicio adicional desde ahora. No se puede reactivar: si más
          adelante hace falta, se crea un tipo nuevo, y este nombre quedará libre para ese momento.
        </p>
        <p style={{ color: 'var(--flit-text-secondary)' }}>Seguirá visible marcando «Mostrar dados de baja».</p>
        {error && <p role="alert" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={onClose}>Cancelar</button>
          <button
            type="button" className={flitBtnPrimary} style={{ background: 'var(--flit-danger-ink)' }}
            disabled={enviando} onClick={confirmar}
          >
            Dar de baja
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
