// FLITO Logística — Mi ruta (mensajero). PWA de campo. Dos tareas:
//  1) RECOGER: en el organismo escanea el PDF417 del reverso de CADA LT (o la ingresa a mano) y el funcionario
//     firma UNA vez la recogida (HU #14111, components/flito/ruta/). «Mis recogidas» es una sub-vista.
//  2) ENTREGAR: lleva el acta a la empresa y captura la firma del receptor (RN-03).
// Todo pasa por la cola offline (RN-06/CA-06): con señal va directo; sin señal se encola (CA-15).

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { flitInp } from '../components/flit/flitPageKit';
import { submitCampo, usePendingQueue } from '../lib/offlineQueue';
import { obtenerUbicacion } from '../lib/geo';
import FirmaCanvas from '../components/flito/FirmaCanvas';
import PanelRecogida from '../components/flito/ruta/PanelRecogida';
import MisRecogidas from '../components/flito/ruta/MisRecogidas';

interface RutaDocumento { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
interface RutaEntrega { actaId: string; companiaNombre: string | null; direccionEntrega: string | null; contactoNombre: string | null; documentos: RutaDocumento[] }
interface MiRuta { entregas: RutaEntrega[] }
// Botones grandes y cómodos para el pulgar (py-3.5, texto base).
const btn = 'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white active:opacity-80 disabled:opacity-50';
const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
const btnGhost = 'rounded-lg px-4 py-2.5 text-sm font-semibold active:opacity-70';

export default function FlitoRuta() {
  const [ruta, setRuta] = useState<MiRuta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { count, online, flushing, flush } = usePendingQueue();
  const { hasFuncion } = useAuth();
  const puedeConfirmar = hasFuncion('logistica.recogida.confirmar');
  const [vista, setVista] = useState<'ruta' | 'recogidas'>('ruta');

  const cargar = () => {
    setError(null);
    api.get<MiRuta>('/flito/logistica/mi-ruta').then(setRuta).catch((e) => setError(errorMessage(e)));
  };
  useEffect(cargar, []);
  useEffect(() => { if (online && count === 0) cargar(); }, [online, count]);

  const enviar = async (path: string, body: unknown, ok: string) => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const { queued } = await submitCampo(path, body, ok);
      setMsg(queued ? 'Guardado sin conexión — se enviará al recuperar señal.' : ok);
      if (!queued) cargar();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-md space-y-5 p-3 pb-24">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mi ruta</h1>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Escanea las LT en el organismo y entrégalas firmadas.</p>
        </div>
        {puedeConfirmar && vista === 'ruta' && (
          <button type="button" onClick={() => setVista('recogidas')}
            className="flit-focus inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)', minHeight: 44 }}>
            Mis recogidas <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
      </header>

      {(!online || count > 0) && (
        <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: online ? 'rgba(240,90,53,0.12)' : 'rgba(89,103,125,0.14)', color: online ? 'var(--flit-warning)' : 'var(--flit-text-secondary)' }}>
          <span>{online ? '' : 'Sin conexión · '}{count > 0 ? `${count} cambio(s) sin sincronizar` : 'Trabajando offline'}</span>
          {count > 0 && online && (
            <button className="font-semibold underline disabled:opacity-50" disabled={flushing} onClick={flush}>
              {flushing ? 'Sincronizando…' : 'Reintentar'}
            </button>
          )}
        </div>
      )}

      {msg && <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success)' }}>{msg}</div>}
      {error && <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(228,61,48,0.14)', color: 'var(--flit-danger)' }}>{error}</div>}

      {vista === 'recogidas' && <MisRecogidas onVolver={() => setVista('ruta')} onEscanear={() => setVista('ruta')} />}
      {/* Montado siempre: ir a «Mis recogidas» a mitad de una recogida no pierde la lista. */}
      <div hidden={vista === 'recogidas'}><PanelRecogida puedeConfirmar={puedeConfirmar} onVerRecogidas={() => setVista('recogidas')} /></div>

      {vista === 'ruta' && ruta && (
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Entregas ({ruta.entregas.length})</h2>
          {ruta.entregas.length === 0 && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No tienes actas despachadas.</p>}
          {ruta.entregas.map((acta) => <Entrega key={acta.actaId} acta={acta} busy={busy} enviar={enviar} />)}
        </section>
      )}
    </div>
  );
}

// ── Entregar: firma del receptor ─────────────────────────────────────────────

function Entrega({ acta, busy, enviar }: { acta: RutaEntrega; busy: boolean; enviar: (path: string, body: unknown, ok: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [documento, setDocumento] = useState('');
  const [firma, setFirma] = useState<string | null>(null);
  const [foto, setFoto] = useState<string | null>(null);

  const onFoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFoto(reader.result as string);
    reader.readAsDataURL(f);
  };

  const confirmar = async () => {
    const geo = await obtenerUbicacion(); // RN-07: solo en el evento de entrega
    enviar(`/flito/logistica/actas/${acta.actaId}/entregar`,
      { receptorNombre: nombre.trim(), receptorDocumento: documento.trim(), firma, ...(foto ? { foto } : {}), ...geo },
      'Entrega registrada');
    setAbierto(false);
  };

  return (
    <div className="rounded-xl border bg-white p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{acta.companiaNombre ?? 'Empresa'}</div>
      {acta.direccionEntrega && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{acta.direccionEntrega}</div>}
      <ul className="my-2 space-y-1 text-sm">
        {acta.documentos.map((d) => <li key={d.id}>Licencia · <span className="tabular-nums">{d.placa ?? d.idFlit}</span>{d.numeroLt ? <span style={{ color: 'var(--flit-text-muted)' }}> · LT {d.numeroLt}</span> : null}</li>)}
      </ul>
      {!abierto ? (
        <div className="flex gap-2">
          <button className={`${btn} flex-1`} style={btnPrimaryStyle} onClick={() => setAbierto(true)}>Entregar</button>
          <button className={btnGhost} style={{ color: 'var(--flit-danger)' }} disabled={busy}
            onClick={() => { const m = prompt('Motivo de la devolución:'); if (m?.trim()) enviar(`/flito/logistica/actas/${acta.actaId}/devolucion`, { motivo: m.trim() }, 'Devolución registrada'); }}>
            Devolver
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input className={flitInp} placeholder="Nombre del receptor" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <input className={flitInp} placeholder="Documento del receptor" value={documento} onChange={(e) => setDocumento(e.target.value)} />
          <div>
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Firma del receptor</span>
            <FirmaCanvas onChange={setFirma} />
          </div>
          <label className="block text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
            {foto ? '✓ Foto adjunta (cambiar)' : 'Adjuntar foto (opcional)'}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onFoto} />
          </label>
          <div className="flex gap-2 pt-1">
            <button className={btnGhost} onClick={() => setAbierto(false)} style={{ color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <button className={`${btn} flex-1`} style={btnPrimaryStyle} disabled={busy || !nombre.trim() || !documento.trim() || !firma} onClick={confirmar}>
              Confirmar entrega
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
