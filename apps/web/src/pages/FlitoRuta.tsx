// FLITO Logística — Mi ruta (mensajero). PWA de campo, Fase 2. Vista mobile-first: recogidas por
// organismo y entregas de sus actas despachadas. Incremento 2 (online): verificación por checklist y
// registro de entrega/novedad. El escaneo de códigos, la firma y la operación offline se añaden en
// los incrementos siguientes. CA-11: el backend ya acota /mi-ruta a las actas del propio mensajero.

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { flitInp } from '../components/flit/flitPageKit';

interface RutaDocumento { id: string; tipo: string; tipoLabel: string; placa: string | null; idFlit: string }
interface RutaRecogida { organismoCodigo: string; organismoNombre: string | null; documentos: RutaDocumento[] }
interface RutaEntrega { actaId: string; companiaNombre: string | null; direccionEntrega: string | null; contactoNombre: string | null; documentos: RutaDocumento[] }
interface MiRuta { recogidas: RutaRecogida[]; entregas: RutaEntrega[] }

const btn = 'w-full rounded-xl px-4 py-3 text-sm font-semibold text-white active:opacity-80 disabled:opacity-50';
const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
const btnGhost = 'rounded-lg px-3 py-2 text-sm font-semibold active:opacity-70';

export default function FlitoRuta() {
  const [ruta, setRuta] = useState<MiRuta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cargar = () => {
    setError(null);
    api.get<MiRuta>('/flito/logistica/mi-ruta').then(setRuta).catch((e) => setError(errorMessage(e)));
  };
  useEffect(cargar, []);

  const accion = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); setMsg(ok); cargar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  if (!ruta) {
    return <div className="p-4 text-sm" style={{ color: 'var(--flit-text-muted)' }}>{error ?? 'Cargando tu ruta…'}</div>;
  }

  return (
    <div className="mx-auto max-w-md space-y-5 p-3 pb-24">
      <header>
        <h1 className="text-xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mi ruta</h1>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Recoge en el organismo y entrega a la empresa.</p>
      </header>

      {msg && <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success)' }}>{msg}</div>}
      {error && <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(228,61,48,0.14)', color: 'var(--flit-danger)' }}>{error}</div>}

      {/* Recogidas por organismo */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Recogidas ({ruta.recogidas.reduce((n, o) => n + o.documentos.length, 0)})</h2>
        {ruta.recogidas.length === 0 && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No hay documentos por recoger.</p>}
        {ruta.recogidas.map((org) => (
          <Recogida key={org.organismoCodigo} org={org} busy={busy} onAccion={accion} />
        ))}
      </section>

      {/* Entregas */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Entregas ({ruta.entregas.length})</h2>
        {ruta.entregas.length === 0 && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No tienes actas despachadas.</p>}
        {ruta.entregas.map((acta) => (
          <Entrega key={acta.actaId} acta={acta} busy={busy} onAccion={accion} />
        ))}
      </section>
    </div>
  );
}

function Recogida({ org, busy, onAccion }: { org: RutaRecogida; busy: boolean; onAccion: (fn: () => Promise<unknown>, ok: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="rounded-xl border bg-white p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="mb-2 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{org.organismoNombre ?? org.organismoCodigo}</div>
      <ul className="space-y-2">
        {org.documentos.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2">
            <label className="flex flex-1 items-center gap-3">
              <input type="checkbox" className="h-5 w-5" checked={sel.has(d.id)} onChange={() => toggle(d.id)} />
              <span className="text-sm">{d.tipoLabel} · <span className="tabular-nums">{d.placa ?? d.idFlit}</span></span>
            </label>
            <button className={btnGhost} style={{ color: 'var(--flit-danger)' }} disabled={busy}
              onClick={() => { const m = prompt('Motivo de la novedad (faltante/dañado):'); if (m?.trim()) onAccion(() => api.post(`/flito/logistica/documentos/${d.id}/novedad`, { motivo: m.trim() }), 'Novedad registrada'); }}>
              Novedad
            </button>
          </li>
        ))}
      </ul>
      <button className={`${btn} mt-3`} style={btnPrimaryStyle} disabled={busy || sel.size === 0}
        onClick={() => onAccion(() => api.post('/flito/logistica/recoger', { documentoIds: [...sel] }), `${sel.size} recogido(s)`)}>
        Confirmar recogida ({sel.size})
      </button>
    </div>
  );
}

function Entrega({ acta, busy, onAccion }: { acta: RutaEntrega; busy: boolean; onAccion: (fn: () => Promise<unknown>, ok: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [documento, setDocumento] = useState('');
  return (
    <div className="rounded-xl border bg-white p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{acta.companiaNombre ?? 'Empresa'}</div>
      {acta.direccionEntrega && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{acta.direccionEntrega}</div>}
      <ul className="my-2 space-y-1 text-sm">
        {acta.documentos.map((d) => <li key={d.id}>{d.tipoLabel} · <span className="tabular-nums">{d.placa ?? d.idFlit}</span></li>)}
      </ul>
      {!abierto ? (
        <div className="flex gap-2">
          <button className={`${btn} flex-1`} style={btnPrimaryStyle} onClick={() => setAbierto(true)}>Entregar</button>
          <button className={btnGhost} style={{ color: 'var(--flit-danger)' }} disabled={busy}
            onClick={() => { const m = prompt('Motivo de la devolución:'); if (m?.trim()) onAccion(() => api.post(`/flito/logistica/actas/${acta.actaId}/devolucion`, { motivo: m.trim() }), 'Devolución registrada'); }}>
            Devolver
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input className={flitInp} placeholder="Nombre del receptor" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <input className={flitInp} placeholder="Documento del receptor" value={documento} onChange={(e) => setDocumento(e.target.value)} />
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>La firma en pantalla y la evidencia (foto/ubicación) se añaden en el siguiente incremento.</p>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={() => setAbierto(false)} style={{ color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <button className={`${btn} flex-1`} style={btnPrimaryStyle} disabled={busy || !nombre.trim() || !documento.trim()}
              onClick={() => onAccion(() => api.post(`/flito/logistica/actas/${acta.actaId}/entregar`, { receptorNombre: nombre.trim(), receptorDocumento: documento.trim() }), 'Entrega registrada')}>
              Confirmar entrega
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
