// El modal «Registrar viaje · FLIT-10234» de la consola logística (HU #12620, Feature #12617).
// Diseño: `docs/ux/flito-logistica-viajes.md` §modal.
//
// Dos decisiones que no son detalle:
//   · En «Precio inicial» el campo de precio está DESHABILITADO y el POST no lleva `valor`: la
//     tarifa la copia el servidor en ese instante. Aquí solo se anuncia cuál se copiará.
//   · Sin tarifa vigente «Precio inicial» no existe como opción viable: se deshabilita con su
//     leyenda y «Nuevo precio» entra preseleccionado. Nunca se enseña «$0» como tarifa a copiar.

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ViajeLogistica } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { pesos } from '../../../lib/pesos';
import {
  MAX_DETALLE, OPCIONES_MOTIVO, cuerpoRegistro, falloDeEscritura, formularioValido, rutaViajesDeTramite,
  type FalloEscritura, type FormularioViaje,
} from '../../../lib/viajesLogistica';
import FlitModal from '../../flit/FlitModal';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

export default function ModalRegistrarViaje({
  tramiteId, idFlit, tarifaVigente, onClose, onRegistrado, onFallo, restoreFocusRef,
}: {
  tramiteId: string;
  idFlit: string;
  /** La del GET de la sección; null = la compañía no la tiene configurada. */
  tarifaVigente: number | null;
  onClose: () => void;
  /** 201: la sección recarga y anuncia; el modal se cierra desde aquí. */
  onRegistrado: (viaje: ViajeLogistica) => void;
  /** Un 409/422: el modal enseña el mensaje y NO cierra; la sección decide si recarga o se sella. */
  onFallo: (fallo: FalloEscritura) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const sinTarifa = tarifaVigente === null;
  const [form, setForm] = useState<FormularioViaje>({ motivo: '', detalle: '', modo: sinTarifa ? 'manual' : 'inicial', valor: '' });
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const motivoRef = useRef<HTMLSelectElement>(null);
  const valorRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const idLeyenda = `${ids}-leyenda`;

  // Foco inicial: el motivo, que es lo primero que se decide; sin tarifa, el precio, que es lo
  // único que falta por escribir. Tras la trampa de foco del modal, que entra primero.
  useEffect(() => {
    const t = setTimeout(() => (sinTarifa ? valorRef.current : motivoRef.current)?.focus(), 0);
    return () => clearTimeout(t);
  }, [sinTarifa]);

  const valido = formularioValido(form, tarifaVigente) && !enviando;
  const cambiar = (parte: Partial<FormularioViaje>) => setForm((f) => ({ ...f, ...parte }));

  const enviar = async () => {
    if (!valido) return;
    setEnviando(true);
    setError(null);
    try {
      const viaje = await api.post<ViajeLogistica>(rutaViajesDeTramite(tramiteId), cuerpoRegistro(form));
      onRegistrado(viaje);
    } catch (e) {
      const fallo = falloDeEscritura(e, 'registrar');
      setError(fallo.mensaje);
      if (fallo.forzarManual) cambiar({ modo: 'manual' });
      setEnviando(false);
      onFallo(fallo);
    }
  };

  return (
    <FlitModal title={`Registrar viaje · ${idFlit}`} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <form onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
        <FlitField label="Motivo (obligatorio)">
          <select ref={motivoRef} className={flitInp} value={form.motivo} required
            onChange={(e) => cambiar({ motivo: e.target.value as FormularioViaje['motivo'] })}>
            <option value="">Selecciona…</option>
            {OPCIONES_MOTIVO.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
          </select>
        </FlitField>

        {form.motivo === 'otro' && (
          <div className="mt-3">
            <FlitField label={`Detalle (obligatorio, máx. ${MAX_DETALLE})`}>
              <textarea className={flitInp} rows={3} value={form.detalle} maxLength={MAX_DETALLE} required
                aria-describedby={idLeyenda} onChange={(e) => cambiar({ detalle: e.target.value })} />
            </FlitField>
            <div className="mt-1 flex justify-between text-xs" style={MUTED}>
              <span id={idLeyenda}>No escribas datos personales.</span>
              <span className="tabular-nums">{form.detalle.length}/{MAX_DETALLE}</span>
            </div>
          </div>
        )}

        <fieldset className="mt-3">
          <legend className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Precio</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="modo" value="inicial" className="mt-1" checked={form.modo === 'inicial'}
              disabled={sinTarifa} onChange={() => cambiar({ modo: 'inicial' })} />
            <span>
              Precio inicial
              <span className="block text-xs" style={MUTED}>
                {sinTarifa ? 'La compañía no tiene tarifa de logística vigente' : `Se copiará la tarifa vigente: ${pesos(tarifaVigente)}`}
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input type="radio" name="modo" value="manual" className="mt-1" checked={form.modo === 'manual'}
              onChange={() => cambiar({ modo: 'manual' })} />
            <span className="flex-1">
              Nuevo precio
              <input ref={valorRef} type="number" inputMode="numeric" min={0} step={1} className={`${flitInp} mt-1`}
                aria-label="Nuevo precio" placeholder="COP, sin decimales" value={form.valor}
                disabled={form.modo !== 'manual'} onChange={(e) => cambiar({ valor: e.target.value })} />
            </span>
          </label>
        </fieldset>

        {error && <p role="alert" className="mt-3 text-sm" style={PELIGRO}>{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={onClose}>Cancelar</button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!valido}>Registrar</button>
        </div>
      </form>
    </FlitModal>
  );
}
