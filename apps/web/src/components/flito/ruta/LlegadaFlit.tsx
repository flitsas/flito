// FLITO Logística — llegada a FLIT (HU #14123). Lienzo de la sesión, sin cédula ni nombre.
// El paso de Mi ruta y el modal de Actas comparten estos bloques. La entrega a cliente no vive aquí.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../../lib/api';
import { obtenerUbicacion } from '../../../lib/geo';
import { MAX_FIRMA, mensajeLlegadaFlit, nuevaKey } from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import FirmaCanvas from '../FirmaCanvas';

export interface LtLlegada {
  id: string;
  placa: string | null;
  numeroLt: string | null;
}

interface FormProps {
  companiaNombre: string | null;
  documentos: LtLlegada[];
  trasladoId: string | null;
  onCancelar: () => void;
  onListo: () => void;
  /** En Mi ruta hay «atrás». En el modal de Actas el cierre es la X. */
  onAtras?: () => void;
}

function linea(lt: LtLlegada): string {
  const placa = lt.placa ?? '—';
  return lt.numeroLt ? `${placa} · LT ${lt.numeroLt}` : placa;
}

export function LlegadaFlitForm({ companiaNombre, documentos, trasladoId, onCancelar, onListo, onAtras }: FormProps) {
  const [firma, setFirma] = useState<string | null>(null);
  const [intento, setIntento] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(nuevaKey());
  const n = documentos.length;
  const firmaPesada = !!firma && firma.length * 0.75 > MAX_FIRMA;
  const errFirma = !intento ? null
    : !firma ? 'Falta la firma de quien recibe en FLIT.'
      : firmaPesada ? 'La firma es muy pesada. Bórrela y vuelva a firmar con trazos más cortos.'
        : null;

  const confirmar = async () => {
    setIntento(true);
    setError(null);
    if (!firma || firma.length * 0.75 > MAX_FIRMA) return;
    if (!trasladoId) {
      setError('Este viaje ya no está en ruta. Vuelva y recargue.');
      return;
    }
    setEnviando(true);
    const geo = await obtenerUbicacion();
    const body = { firma, ...geo };
    try {
      await api.post(`/flito/logistica/traslados/${trasladoId}/entregar`, body, { 'Idempotency-Key': keyRef.current });
      toastOk('Llegada a FLIT registrada.');
      onListo();
    } catch (e) {
      setError(mensajeLlegadaFlit(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="llegada-flit-titulo">
      {onAtras && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={onAtras} disabled={enviando}
            className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)] disabled:opacity-50"
            style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
            <ChevronLeft size={18} aria-hidden="true" /> Entregas
          </button>
        </div>
      )}
      <div>
        {onAtras && (
          <h2 id="llegada-flit-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>
            {companiaNombre ?? 'Empresa'}
          </h2>
        )}
        <p id={onAtras ? undefined : 'llegada-flit-titulo'} className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Llegada a FLIT · {n} LT
        </p>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Su nombre queda el de esta sesión.</p>
      </div>

      <ul className="space-y-0.5 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
        {documentos.map((d) => <li key={d.id}>{linea(d)}</li>)}
      </ul>

      <div>
        <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Firma de quien recibe en FLIT *
        </span>
        <div className={enviando ? 'pointer-events-none opacity-60' : 'w-full'}>
          <FirmaCanvas onChange={setFirma} label={firma ? 'Firma de quien recibe en FLIT, capturada' : 'Firma de quien recibe en FLIT, vacía'} />
        </div>
        {errFirma && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errFirma}</p>}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={{ ...flitBtnSecondaryStyle, minHeight: 44 }} disabled={enviando} onClick={onCancelar}>
          Cancelar
        </button>
        <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
          disabled={enviando} onClick={() => void confirmar()}>
          {enviando ? 'Registrando…' : 'Confirmar llegada'}
        </button>
      </div>
    </section>
  );
}

interface DetallePlacas {
  acta: { trasladoId: string | null };
  documentos: LtLlegada[];
}

/** Modal de Actas: mismas piezas que el paso, con las placas del detalle. */
export function LlegadaFlitModal({ actaId, companiaNombre, trasladoId, onClose, onListo }: {
  actaId: string;
  companiaNombre: string | null;
  trasladoId: string;
  onClose: () => void;
  onListo: () => void;
}) {
  const [placas, setPlacas] = useState<LtLlegada[] | null>(null);
  const [idViaje, setIdViaje] = useState(trasladoId);
  const [carga, setCarga] = useState<'cargando' | 'ok' | 'error'>('cargando');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCarga('cargando');
    api.get<DetallePlacas>(`/flito/logistica/actas/${actaId}`)
      .then((d) => {
        if (!vivo) return;
        setPlacas(d.documentos ?? []);
        if (d.acta?.trasladoId) setIdViaje(d.acta.trasladoId);
        setCarga('ok');
      })
      .catch(() => { if (vivo) setCarga('error'); });
    return () => { vivo = false; };
  }, [actaId, tick]);

  return (
    <FlitModal title={companiaNombre ?? 'Empresa'} onClose={onClose}>
      {carga === 'cargando' && (
        <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando el viaje…</p>
      )}
      {carga === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          <p className="flex-1">No se pudo cargar el viaje. Vuelva a intentarlo.</p>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setTick((n) => n + 1)}>Reintentar</button>
        </div>
      )}
      {carga === 'ok' && (
        <LlegadaFlitForm
          companiaNombre={companiaNombre}
          documentos={placas ?? []}
          trasladoId={idViaje}
          onCancelar={onClose}
          onListo={onListo}
        />
      )}
    </FlitModal>
  );
}
