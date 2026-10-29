// FLITO Logística — Mi ruta (mensajero). PWA de campo. Dos tareas:
//  1) RECOGER: en el organismo escanea el PDF417 del reverso de CADA LT (o la ingresa a mano) y el funcionario
//     firma UNA vez la recogida (HU #14111, components/flito/ruta/). «Mis recogidas» es una sub-vista.
//  2) ENTREGAR: lleva el viaje a la empresa y captura la firma del receptor (HU #14116: paso que sustituye
//     el panel, casillas de LT no entregadas, FlitModal de devolución). Recogida no se toca.
// Todo pasa por la cola offline (RN-06/CA-06): con señal va directo; sin señal se encola (CA-15).

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePendingQueue } from '../lib/offlineQueue';
import { mensajeCargarEntregas } from '../lib/viajesCliente';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import PanelRecogida from '../components/flito/ruta/PanelRecogida';
import MisRecogidas from '../components/flito/ruta/MisRecogidas';
import PasoEntrega, { DevolverViajeModal, type ActaEntrega } from '../components/flito/ruta/PasoEntrega';

interface RutaDocumento { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
interface RutaEntrega extends ActaEntrega { contactoNombre: string | null; documentos: RutaDocumento[] }
interface MiRuta { entregas: RutaEntrega[] }

const btn = 'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white active:opacity-80 disabled:opacity-50';
const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)', minHeight: 44 } as const;

type CargaEntregas = 'cargando' | 'ok' | 'error' | 'error403';

export default function FlitoRuta() {
  const [ruta, setRuta] = useState<MiRuta | null>(null);
  const [carga, setCarga] = useState<CargaEntregas>('cargando');
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [paso, setPaso] = useState<RutaEntrega | null>(null);
  const [devolver, setDevolver] = useState<RutaEntrega | null>(null);
  const { count, online, flushing, flush } = usePendingQueue();
  const { hasFuncion } = useAuth();
  const puedeConfirmar = hasFuncion('logistica.recogida.confirmar');
  const [vista, setVista] = useState<'ruta' | 'recogidas'>('ruta');

  const cargar = () => {
    setCarga((prev) => (prev === 'ok' ? 'ok' : 'cargando'));
    setErrorCarga(null);
    api.get<MiRuta>('/flito/logistica/mi-ruta')
      .then((r) => { setRuta(r); setCarga('ok'); })
      .catch((e) => {
        const m = mensajeCargarEntregas(e);
        setRuta(null);
        setCarga(e instanceof ApiError && e.status === 403 ? 'error403' : 'error');
        setErrorCarga(m.texto);
      });
  };
  useEffect(cargar, []);
  useEffect(() => { if (online && count === 0) cargar(); }, [online, count]);

  const alListo = () => { setPaso(null); setDevolver(null); cargar(); };

  return (
    <div className="mx-auto max-w-md space-y-5 p-3 pb-24">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mi ruta</h1>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Escanea las LT en el organismo y entrégalas firmadas.</p>
        </div>
        {puedeConfirmar && vista === 'ruta' && !paso && (
          <button type="button" onClick={() => setVista('recogidas')}
            className="flit-focus inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)', minHeight: 44 }}>
            Mis recogidas <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
      </header>

      {(!online || count > 0) && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: 'var(--flit-bg-card)', color: online ? 'var(--flit-warning-ink)' : 'var(--flit-text-secondary)', border: '1px solid var(--flit-border-soft)' }}>
          <span>{online ? '' : 'Sin conexión · '}{count > 0 ? `${count} cambio(s) sin sincronizar` : 'Trabajando offline'}</span>
          {count > 0 && online && (
            <button type="button" className="flit-focus rounded px-2 py-1 font-semibold underline disabled:opacity-50" disabled={flushing} onClick={flush}>
              {flushing ? 'Sincronizando…' : 'Reintentar'}
            </button>
          )}
        </div>
      )}

      {vista === 'recogidas' && !paso && <MisRecogidas puedeConfirmar={puedeConfirmar} onVolver={() => setVista('ruta')} onEscanear={() => setVista('ruta')} />}
      {/* Montado siempre: ir a «Mis recogidas» o al paso de entrega no pierde la lista de recogida. */}
      <div hidden={vista === 'recogidas' || !!paso}><PanelRecogida puedeConfirmar={puedeConfirmar} onVerRecogidas={() => setVista('recogidas')} /></div>

      {paso ? (
        <PasoEntrega acta={paso} onAtras={() => setPaso(null)} onListo={alListo} />
      ) : vista === 'ruta' ? (
        <section className="space-y-3" aria-labelledby="entregas-titulo">
          <h2 id="entregas-titulo" className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
            Entregas{ruta ? ` (${ruta.entregas.length})` : ''}
          </h2>
          <BloqueEntregas
            carga={carga}
            error={errorCarga}
            entregas={ruta?.entregas ?? []}
            onReintentar={cargar}
            onEntregar={setPaso}
            onDevolver={setDevolver}
          />
        </section>
      ) : null}

      {devolver && (
        <DevolverViajeModal
          nombre={devolver.companiaNombre}
          actaId={devolver.actaId}
          onClose={() => setDevolver(null)}
          onListo={alListo}
        />
      )}
    </div>
  );
}

function BloqueEntregas({ carga, error, entregas, onReintentar, onEntregar, onDevolver }: {
  carga: CargaEntregas;
  error: string | null;
  entregas: RutaEntrega[];
  onReintentar: () => void;
  onEntregar: (a: RutaEntrega) => void;
  onDevolver: (a: RutaEntrega) => void;
}) {
  if (carga === 'cargando') {
    return (
      <div role="status" aria-label="Cargando entregas…" className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
        <div className="h-4 w-1/2 rounded" style={{ background: 'var(--flit-border-soft)' }} />
        <div className="mt-3 h-3 w-3/4 rounded" style={{ background: 'var(--flit-border-soft)' }} />
        <div className="mt-2 h-3 w-1/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
        <div className="mt-4 flex gap-2">
          <div className="h-12 flex-1 rounded-xl" style={{ background: 'var(--flit-border-soft)' }} />
          <div className="h-12 w-28 rounded-xl" style={{ background: 'var(--flit-border-soft)' }} />
        </div>
      </div>
    );
  }
  if (carga === 'error' || carga === 'error403') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-3 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
        <p className="flex-1">{error}</p>
        {carga === 'error' && (
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
        )}
      </div>
    );
  }
  if (entregas.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
        No tienes viajes despachados para entregar. Cuando Operaciones despache un viaje, aparece aquí.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {entregas.map((acta) => (
        <li key={acta.actaId}>
          <TarjetaEntrega acta={acta} onEntregar={() => onEntregar(acta)} onDevolver={() => onDevolver(acta)} />
        </li>
      ))}
    </ul>
  );
}

function TarjetaEntrega({ acta, onEntregar, onDevolver }: {
  acta: RutaEntrega;
  onEntregar: () => void;
  onDevolver: () => void;
}) {
  const placas = acta.documentos.map((d) => d.placa).filter(Boolean).join(', ');
  return (
    <article className="rounded-xl border bg-flit-card p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{acta.companiaNombre ?? 'Empresa'}</div>
      {acta.direccionEntrega && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{acta.direccionEntrega}</div>}
      {placas && <div className="mt-1 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{placas}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={`${btn} flex-1`} style={btnPrimaryStyle} onClick={onEntregar}>Entregar</button>
        <button type="button"
          className="flit-focus rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-danger-ink)', minHeight: 44 }}
          onClick={onDevolver}>
          Devolver el viaje
        </button>
      </div>
    </article>
  );
}
