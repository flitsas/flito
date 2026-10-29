// FLITO Logística — paso de entrega con firma del receptor (HU #14116).
// Sustituye el panel (como la recogida #14111). Cédula solo en el estado del componente y el body.
import { useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { obtenerUbicacion } from '../../../lib/geo';
import { submitCampo } from '../../../lib/offlineQueue';
import {
  CEDULA_RECEPTOR_OK, MAX_FIRMA, NOMBRE_RECEPTOR_OK, mensajeDevolverViaje, mensajeEntregar, nuevaKey,
} from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import FirmaCanvas from '../FirmaCanvas';

export interface DocumentoEntrega { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
export interface ActaEntrega {
  actaId: string;
  companiaNombre: string | null;
  direccionEntrega: string | null;
  documentos: DocumentoEntrega[];
}

const btnCampo = 'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white disabled:opacity-50';
const btnCampoStyle = { background: 'var(--flit-gradient-primary)', minHeight: 48 } as const;

interface Props {
  acta: ActaEntrega;
  onAtras: () => void;
  onListo: () => void;
}

export default function PasoEntrega({ acta, onAtras, onListo }: Props) {
  const [nombre, setNombre] = useState('');
  const [cedula, setCedula] = useState('');
  const [firma, setFirma] = useState<string | null>(null);
  const [foto, setFoto] = useState<string | null>(null);
  const [devueltas, setDevueltas] = useState<Set<string>>(() => new Set());
  const [intento, setIntento] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devolver, setDevolver] = useState(false);
  const keyRef = useRef(nuevaKey());
  const total = acta.documentos.length;
  const nDev = devueltas.size;
  const nEnt = total - nDev;
  const todasDevueltas = total > 0 && nDev === total;

  const errNombre = intento && !NOMBRE_RECEPTOR_OK.test(nombre.trim()) ? 'Escribe el nombre completo de quien recibe' : null;
  const errCedula = intento && !CEDULA_RECEPTOR_OK.test(cedula) ? 'La cédula debe tener solo números (5 a 12 dígitos)' : null;
  const errFirma = intento && !firma
    ? 'Falta la firma de quien recibe'
    : intento && firma && firma.length * 0.75 > MAX_FIRMA
      ? 'La firma es muy pesada. Bórrala y vuelve a firmar con trazos más cortos.'
      : null;

  const toggle = (id: string) => {
    setDevueltas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onFoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFoto(reader.result as string);
    reader.readAsDataURL(f);
  };

  const confirmar = async () => {
    setIntento(true); setError(null);
    if (todasDevueltas) return;
    if (!NOMBRE_RECEPTOR_OK.test(nombre.trim()) || !CEDULA_RECEPTOR_OK.test(cedula) || !firma || firma.length * 0.75 > MAX_FIRMA) return;
    setEnviando(true);
    const geo = await obtenerUbicacion();
    const ltsDevueltas = nDev > 0 ? [...devueltas] : undefined;
    const body = {
      receptorNombre: nombre.trim(),
      receptorDocumento: cedula,
      firma,
      ...(ltsDevueltas ? { ltsDevueltas } : {}),
      ...(foto ? { foto } : {}),
      ...geo,
    };
    const path = `/flito/logistica/actas/${acta.actaId}/entregar`;
    const toast = nDev === 0
      ? 'Entrega registrada.'
      : `Entrega registrada: ${nEnt} LT entregadas, ${nDev} ${nDev === 1 ? 'devuelta' : 'devueltas'}.`;
    try {
      if (navigator.onLine) {
        await api.post(path, body, { 'Idempotency-Key': keyRef.current });
      } else {
        const { queued } = await submitCampo(path, body, 'Entrega');
        if (queued) {
          setCedula('');
          onListo();
          return;
        }
      }
      setCedula('');
      toastOk(toast);
      onListo();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        const { queued } = await submitCampo(path, body, 'Entrega');
        if (queued) { setCedula(''); onListo(); return; }
      }
      setError(mensajeEntregar(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="entrega-titulo">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onAtras} disabled={enviando}
          className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)] disabled:opacity-50"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          <ChevronLeft size={18} aria-hidden="true" /> Entregas
        </button>
      </div>
      <div>
        <h2 id="entrega-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          {acta.companiaNombre ?? 'Empresa'}
        </h2>
        {acta.direccionEntrega && (
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>{acta.direccionEntrega}</p>
        )}
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{total} LT · destino Cliente</p>
      </div>

      <fieldset className="space-y-1" disabled={enviando}>
        <legend className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>LT de este viaje</legend>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Marca las que NO entregas. Las demás quedan entregadas.</p>
        <ul className="mt-2 space-y-1">
          {acta.documentos.map((d) => {
            const placa = d.placa ?? d.idFlit;
            const marcada = devueltas.has(d.id);
            return (
              <li key={d.id}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--flit-bg-hover)]">
                  <input
                    type="checkbox"
                    checked={marcada}
                    onChange={() => toggle(d.id)}
                    className="h-5 w-5 shrink-0"
                    style={{ accentColor: 'var(--flit-blue-text)' }}
                  />
                  <span className="text-sm tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                    {placa}{d.numeroLt ? ` · LT ${d.numeroLt}` : ''}
                    <span className="sr-only">. No se entregó {placa}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p role="status" aria-live="polite" className="pt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {todasDevueltas
            ? `Para devolver las ${total} LT usa Devolver el viaje, no esta entrega.`
            : `Se entregarán ${nEnt} de ${total}.${nDev > 0 ? ` ${nDev} se marca${nDev === 1 ? '' : 'n'} como ${nDev === 1 ? 'devuelta' : 'devueltas'}.` : ''}`}
        </p>
      </fieldset>

      <fieldset className="space-y-3 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }} disabled={enviando}>
        <FlitField label="Nombre de quien recibe">
          <input className={flitInp} value={nombre} autoComplete="off" aria-invalid={!!errNombre}
            aria-describedby={errNombre ? 'err-nombre-recibe' : undefined}
            onChange={(e) => setNombre(e.target.value)} />
        </FlitField>
        {errNombre && <p id="err-nombre-recibe" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errNombre}</p>}
        <FlitField label="Cédula de quien recibe">
          <input className={`${flitInp} tabular-nums`} value={cedula} inputMode="numeric" autoComplete="off"
            aria-invalid={!!errCedula} aria-describedby={errCedula ? 'err-cedula-recibe' : undefined}
            onChange={(e) => setCedula(e.target.value.replace(/\D/g, '').slice(0, 12))} />
        </FlitField>
        {errCedula && <p id="err-cedula-recibe" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errCedula}</p>}
        <div>
          <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Firma de quien recibe</span>
          <div className={enviando ? 'pointer-events-none opacity-60' : ''}>
            <FirmaCanvas onChange={setFirma} label={firma ? 'Firma de quien recibe, capturada' : 'Firma de quien recibe, vacía'} />
          </div>
          {errFirma && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errFirma}</p>}
        </div>
        <label className="block text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
          {foto ? 'Foto adjuntada (cambiar)' : 'Adjuntar foto (opcional)'}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFoto} />
        </label>
      </fieldset>

      <div className="sticky bottom-3 z-10 lg:bottom-24 space-y-2 rounded-xl p-1" style={{ background: 'var(--flit-bg-app)' }}>
        {error && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
            {error}
          </div>
        )}
        {todasDevueltas && (
          <button type="button" className={`${flitBtnSecondary} w-full justify-center`} style={{ ...flitBtnSecondaryStyle, minHeight: 44 }}
            onClick={() => setDevolver(true)}>
            Devolver el viaje
          </button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={{ ...flitBtnSecondaryStyle, minHeight: 44 }} disabled={enviando} onClick={onAtras}>
            Cancelar
          </button>
          <button type="button" className={`${btnCampo} w-full sm:flex-1`} style={btnCampoStyle}
            disabled={enviando || todasDevueltas} onClick={() => void confirmar()}>
            {enviando ? 'Registrando…' : 'Confirmar entrega'}
          </button>
        </div>
      </div>

      {devolver && (
        <DevolverViajeModal
          nombre={acta.companiaNombre}
          actaId={acta.actaId}
          onClose={() => setDevolver(false)}
          onListo={onListo}
        />
      )}
    </section>
  );
}

export function DevolverViajeModal({ nombre, actaId, onClose, onListo }: {
  nombre: string | null;
  actaId: string;
  onClose: () => void;
  onListo: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmar = async () => {
    if (!motivo.trim()) return;
    setBusy(true); setError(null);
    const path = `/flito/logistica/actas/${actaId}/devolucion`;
    const body = { motivo: motivo.trim() };
    try {
      if (navigator.onLine) {
        await api.post(path, body);
      } else {
        const { queued } = await submitCampo(path, body, 'Devolución');
        if (queued) { onListo(); return; }
      }
      toastOk('Viaje devuelto.');
      onListo();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        const { queued } = await submitCampo(path, body, 'Devolución');
        if (queued) { onListo(); return; }
      }
      setError(mensajeDevolverViaje(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlitModal title={`Devolver el viaje · ${nombre ?? 'Empresa'}`} onClose={onClose} cierreBloqueado={busy}>
      <FlitField label="Motivo (obligatorio)">
        <textarea className={flitInp} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)}
          placeholder="Receptor ausente / rechazó / …" />
      </FlitField>
      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={busy} onClick={onClose}>Cancelar</button>
        <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !motivo.trim()}
          onClick={() => void confirmar()}>
          {busy ? 'Devolviendo…' : 'Devolver el viaje'}
        </button>
      </div>
    </FlitModal>
  );
}
