// FLITO Logística — Mi ruta (mensajero). PWA de campo. Dos tareas:
//  1) RECOGER: en el organismo escanea el PDF417 del reverso de CADA LT (recoge varias seguidas). De
//     cada código se extrae placa/VIN/propietario/… y por OCR el N.º de LT (impreso debajo). El backend
//     empareja por placa+VIN contra un trámite APROBADO; el mensajero NO ve el listado de trámites: solo
//     va viendo, en una tabla, las LT que carga — las emparejadas y las que no encontraron trámite.
//  2) ENTREGAR: lleva el acta a la empresa y captura la firma del receptor (RN-03).
// Todo pasa por la cola offline (RN-06/CA-06): con señal va directo; sin señal se encola (CA-15).

import { useEffect, useRef, useState } from 'react';
import { parseLicenciaTransito } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { flitInp } from '../components/flit/flitPageKit';
import { submitCampo, usePendingQueue } from '../lib/offlineQueue';
import { obtenerUbicacion } from '../lib/geo';
import FirmaCanvas from '../components/flito/FirmaCanvas';
import Escaner, { escaneoDisponible } from '../components/flito/Escaner';

interface RutaDocumento { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
interface RutaEntrega { actaId: string; companiaNombre: string | null; direccionEntrega: string | null; contactoNombre: string | null; documentos: RutaDocumento[] }
interface MiRuta { entregas: RutaEntrega[] }
type ResultadoEscaneo = 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'no_gestionable';
interface RespuestaEscaneo { resultado: ResultadoEscaneo; motivo?: string | null }

// Una fila de la tabla de recogidas: datos del código + N.º de LT (OCR) + estado del emparejamiento.
type EstadoFila = 'enviando' | 'encolado' | 'error' | ResultadoEscaneo;
interface FilaLt {
  key: number; rawValue: string;
  placa: string; vin: string; propietario: string | null; numeroLicencia: string; combustible: string | null;
  numeroLt: string; ltGuardado: string; estado: EstadoFila; detalle?: string | null;
}

// Botones grandes y cómodos para el pulgar (py-3.5, texto base).
const btn = 'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white active:opacity-80 disabled:opacity-50';
const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
const btnGhost = 'rounded-lg px-4 py-2.5 text-sm font-semibold active:opacity-70';

const GRIS = 'rgba(89,103,125,0.12)';
const ESTADO: Record<EstadoFila, { texto: string; color: string; bg: string }> = {
  enviando: { texto: 'Enviando…', color: 'var(--flit-text-secondary)', bg: GRIS },
  recogido: { texto: '✓ Registrada', color: 'var(--flit-success)', bg: 'rgba(112,207,58,0.16)' },
  duplicado: { texto: 'Ya registrada', color: 'var(--flit-text-secondary)', bg: GRIS },
  novedad: { texto: 'Novedad', color: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.16)' },
  sin_match: { texto: 'Sin trámite', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.14)' },
  no_gestionable: { texto: 'No gestionable', color: 'var(--flit-text-secondary)', bg: GRIS },
  encolado: { texto: 'En cola', color: 'var(--flit-text-secondary)', bg: GRIS },
  error: { texto: 'Error', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.14)' },
};

export default function FlitoRuta() {
  const [ruta, setRuta] = useState<MiRuta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { count, online, flushing, flush } = usePendingQueue();

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
      <header>
        <h1 className="text-xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mi ruta</h1>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Escanea las LT en el organismo y entrégalas firmadas.</p>
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

      <PanelRecogida />

      {ruta && (
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Entregas ({ruta.entregas.length})</h2>
          {ruta.entregas.length === 0 && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No tienes actas despachadas.</p>}
          {ruta.entregas.map((acta) => <Entrega key={acta.actaId} acta={acta} busy={busy} enviar={enviar} />)}
        </section>
      )}
    </div>
  );
}

// ── Recoger: escaneo continuo de varias LT → tabla ───────────────────────────

function PanelRecogida() {
  const [escaneando, setEscaneando] = useState(false);
  const [filas, setFilas] = useState<FilaLt[]>([]);
  const [pegar, setPegar] = useState('');
  const [ltManual, setLtManual] = useState('');
  const geo = useRef<{ lat?: string; lng?: string }>({});

  const parsedPegar = pegar.trim() ? parseLicenciaTransito(pegar.trim()) : null;

  const actualizar = (key: number, patch: Partial<FilaLt>) =>
    setFilas((f) => f.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // Procesa un código: extrae, agrega la fila y la envía al backend (match por placa+VIN).
  const procesar = async (rawValue: string, numeroLt?: string | null) => {
    const p = parseLicenciaTransito(rawValue);
    if (!p) return; // ilegible: se ignora
    if (!geo.current.lat) geo.current = await obtenerUbicacion(); // RN-07: ubicación de la recogida
    const key = Date.now() + Math.random();
    const lt = numeroLt ?? '';
    setFilas((f) => [{
      key, rawValue, placa: p.placa, vin: p.vin, propietario: p.propietarioNombre,
      numeroLicencia: p.numeroLicencia, combustible: p.combustible, numeroLt: lt, ltGuardado: lt, estado: 'enviando',
    }, ...f]);
    try {
      const { queued, result } = await submitCampo('/flito/logistica/escanear', { rawValue, numeroLt: lt || undefined, ...geo.current }, `LT ${p.placa}`);
      if (queued) { actualizar(key, { estado: 'encolado' }); return; }
      const r = result as RespuestaEscaneo;
      actualizar(key, { estado: r.resultado, detalle: r.motivo ?? null });
    } catch (e) { actualizar(key, { estado: 'error', detalle: errorMessage(e) }); }
  };

  // Corrige el N.º de LT en una fila ya registrada (re-envía para actualizarlo en el backend).
  const editarLt = async (fila: FilaLt, valor: string) => {
    const v = valor.trim();
    actualizar(fila.key, { numeroLt: v });
    if (!v || v === fila.ltGuardado || fila.estado === 'enviando' || fila.estado === 'error') return;
    try {
      await submitCampo('/flito/logistica/escanear', { rawValue: fila.rawValue, numeroLt: v, ...geo.current }, `LT ${fila.placa}`);
      actualizar(fila.key, { ltGuardado: v });
    } catch { /* best-effort */ }
  };

  const agregarPegado = () => {
    if (!parsedPegar) return;
    procesar(pegar.trim(), ltManual.trim() || null);
    setPegar(''); setLtManual('');
  };

  const abrir = async () => { geo.current = await obtenerUbicacion(); setEscaneando(true); };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Recoger licencias</h2>
        {filas.length > 0 && <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{filas.length} cargada(s)</span>}
      </div>

      <div className="rounded-xl border bg-white p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
        {escaneoDisponible() && (
          <button className={btn} style={btnPrimaryStyle} onClick={abrir}>📷 Escanear {filas.length ? 'otra LT' : 'LT'}</button>
        )}
        {/* Respaldo si no hay cámara/BarcodeDetector: pegar el contenido + N.º de LT a mano. */}
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
            {escaneoDisponible() ? 'o pega el contenido del código' : 'Pega el contenido del código'}
          </summary>
          <textarea className={`${flitInp} mt-2`} rows={2} placeholder="10038156339 C.C. … QOX858 LRWY… ELECTRICO" value={pegar} onChange={(e) => setPegar(e.target.value)} />
          {pegar.trim() && !parsedPegar && <p className="mt-1 text-xs" style={{ color: 'var(--flit-danger)' }}>No se reconoce el formato de la LT.</p>}
          {parsedPegar && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{parsedPegar.placa} · {parsedPegar.propietarioNombre ?? '—'}</p>}
          <input className={`${flitInp} mt-2`} placeholder="N.º de LT (impreso bajo el código)" value={ltManual} onChange={(e) => setLtManual(e.target.value)} />
          <button className={`${btn} mt-2`} style={btnPrimaryStyle} disabled={!parsedPegar} onClick={agregarPegado}>Agregar</button>
        </details>
      </div>

      {/* Cada LT como tarjeta apilada (cómoda en móvil, sin scroll horizontal). */}
      {filas.length > 0 && (
        <div className="space-y-2">
          {filas.map((f) => (
            <TarjetaLt key={f.key} fila={f}
              onChangeLt={(v) => actualizar(f.key, { numeroLt: v })}
              onBlurLt={(v) => editarLt(f, v)} />
          ))}
        </div>
      )}

      {escaneando && <Escaner onScan={procesar} onClose={() => setEscaneando(false)} />}
    </section>
  );
}

function TarjetaLt({ fila, onChangeLt, onBlurLt }: { fila: FilaLt; onChangeLt: (v: string) => void; onBlurLt: (v: string) => void }) {
  const e = ESTADO[fila.estado];
  return (
    <div className="rounded-xl border bg-white p-3.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-lg font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fila.placa}</span>
        <span className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold" style={{ color: e.color, background: e.bg }}>{e.texto}</span>
      </div>
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>N.º de LT</span>
        <input className={`${flitInp} tabular-nums`} inputMode="numeric" value={fila.numeroLt} placeholder="—"
          onChange={(ev) => onChangeLt(ev.target.value)} onBlur={(ev) => onBlurLt(ev.target.value)} />
      </label>
      <div className="mt-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{fila.propietario ?? '—'}</div>
      <div className="mt-0.5 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
        VIN {fila.vin} · Lic. {fila.numeroLicencia}{fila.combustible ? ` · ${fila.combustible}` : ''}
      </div>
      {fila.detalle && <div className="mt-1.5 text-xs" style={{ color: e.color }}>{fila.detalle}</div>}
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
