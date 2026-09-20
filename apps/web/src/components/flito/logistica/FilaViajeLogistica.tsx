// Una línea de la sección «Viajes adicionales» del detalle del trámite: número, precio, forma de
// fijación, motivo, autor, fecha y —si se puede— la confirmación EN FILA de «Quitar» con su DELETE
// (HU #12620, Feature #12617). Diseño: `docs/ux/flito-logistica-viajes.md`.
//
// La confirmación no es un diálogo: ya estamos dentro de uno (el detalle) y un segundo FlitModal
// sería trampa de foco sobre trampa de foco. El bloque SUSTITUYE a la fila —no se apila debajo—,
// así que la lista no salta. Calca `finanzas/FilaServicioAdicional`.

import { useEffect, useRef, useState } from 'react';
import type { ViajeLogistica } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { pesos } from '../../../lib/pesos';
import {
  etiquetaFijacion, falloDeEscritura, rutaViajesDeTramite, textoConfirmarQuitar, textoMotivo, type FalloEscritura,
} from '../../../lib/viajesLogistica';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const MUTED = { color: 'var(--flit-text-muted)' } as const;
/** La TINTA roja sobre el fondo de la tarjeta, no una superficie roja: así marca esta app lo delicado. */
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

export default function FilaViajeLogistica({
  viaje, tramiteId, puedeQuitar, abierta, fecha, onAbrir, onCancelar, onQuitado, onFallo,
}: {
  viaje: ViajeLogistica;
  tramiteId: string;
  /** `logistica.viajes.quitar` Y el trámite editable. Sin las dos, el botón NO existe. */
  puedeQuitar: boolean;
  /** Solo una confirmación abierta a la vez: el estado vive en la sección. */
  abierta: boolean;
  /** El `fecha()` de la página, para que la fila se lea como la bitácora de al lado. */
  fecha: (iso: string | null) => string;
  onAbrir: () => void;
  onCancelar: () => void;
  /** 204: la fila sale y el total lo trae el GET siguiente. El foco lo recoloca la sección. */
  onQuitado: (viaje: ViajeLogistica) => void;
  onFallo: (fallo: FalloEscritura) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const quitarRef = useRef<HTMLButtonElement>(null);
  const cancelarRef = useRef<HTMLButtonElement>(null);
  // Al abrir la confirmación el botón que la abrió deja de existir: el foco entra en «Cancelar»,
  // nunca por defecto sobre lo que no tiene vuelta.
  useEffect(() => { if (abierta) cancelarRef.current?.focus(); }, [abierta]);
  // Al CANCELAR el foco vuelve a su «Quitar». `quitada` separa cancelar de conseguir quitarlo: entre
  // el 204 y el GET la fila sigue montada y sin la guarda robaría el foco para dejarlo en <body>.
  const estuvoAbierta = useRef(false);
  const quitada = useRef(false);
  useEffect(() => {
    if (!abierta && estuvoAbierta.current && !quitada.current) quitarRef.current?.focus();
    estuvoAbierta.current = abierta;
  }, [abierta]);

  const confirmar = async () => {
    setEnviando(true);
    try {
      await api.delete(`${rutaViajesDeTramite(tramiteId)}/${viaje.id}`);
      quitada.current = true;
      onQuitado(viaje);
    } catch (e) {
      onFallo(falloDeEscritura(e, 'quitar'));
      setEnviando(false);
      onCancelar();
    }
  };

  if (abierta) {
    return (
      <li className="py-2" data-id={viaje.id}
        // `useEscape` escucha en `window`: parar la propagación aquí hace que Esc cancele la
        // confirmación y NO cierre el detalle.
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelar(); } }}>
        <div className="rounded-lg border p-2" style={{ borderColor: 'var(--flit-border-input)' }}>
          <p className="text-sm">{textoConfirmarQuitar(viaje)}</p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" ref={cancelarRef} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
              disabled={enviando} onClick={onCancelar}>
              Cancelar
            </button>
            <button type="button" className={flitBtnSecondarySm} style={{ ...flitBtnSecondaryStyle, ...PELIGRO }}
              disabled={enviando} onClick={confirmar}>
              Quitar viaje
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="py-2" data-id={viaje.id}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">
          <span className="font-semibold">Viaje {viaje.numero}</span>
          <span> · </span>
          <span className="tabular-nums">{pesos(viaje.valor)}</span>
          <span style={MUTED}> · {etiquetaFijacion(viaje)}</span>
        </span>
        {puedeQuitar && (
          <button type="button" ref={quitarRef} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
            aria-label={`Quitar viaje ${viaje.numero}`} onClick={onAbrir}>
            Quitar
          </button>
        )}
      </div>
      <div className="mt-0.5 text-xs" style={MUTED}>
        {textoMotivo(viaje)} · {viaje.registradoPorNombre ?? '—'} · {fecha(viaje.registradoEn)}
      </div>
    </li>
  );
}
