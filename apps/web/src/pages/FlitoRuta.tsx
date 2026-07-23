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
import { precargarOcr } from '../lib/ocrLt';

interface RutaDocumento { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
interface RutaEntrega { actaId: string; companiaNombre: string | null; direccionEntrega: string | null; contactoNombre: string | null; documentos: RutaDocumento[] }
interface MiRuta { entregas: RutaEntrega[] }
// Validación de una LT SIN persistir: el mensajero escanea en lote y solo confirma al final.
type Validacion = 'validando' | 'relacionada' | 'novedad' | 'sin_match' | 'no_gestionable' | 'ya_registrada' | 'sin_conexion' | 'error';
interface RespuestaValidacion { resultado: 'relacionada' | 'novedad' | 'sin_match' | 'no_gestionable' | 'ya_registrada'; motivo?: string | null }
type Confirmacion = 'pendiente' | 'confirmando' | 'confirmada' | 'encolada' | 'error';

// Una fila de la tabla de recogidas: datos del código + N.º de LT (OCR) + validación del match + confirmación.
interface FilaLt {
  key: number; rawValue: string;
  placa: string; vin: string; propietario: string | null; numeroLicencia: string; combustible: string | null;
  numeroLt: string; validacion: Validacion; motivo?: string | null;
  confirmacion: Confirmacion; confirmMotivo?: string | null;
}

// La LT se relaciona con un trámite → registrable al confirmar. `sin_conexion`: no se pudo validar
// offline; se encola al confirmar y el servidor decide al sincronizar.
const REGISTRABLE: Validacion[] = ['relacionada', 'novedad', 'sin_conexion'];

// Botones grandes y cómodos para el pulgar (py-3.5, texto base).
const btn = 'w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white active:opacity-80 disabled:opacity-50';
const btnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
const btnGhost = 'rounded-lg px-4 py-2.5 text-sm font-semibold active:opacity-70';

const GRIS = 'rgba(89,103,125,0.12)';
// Chip por resultado de validación (mientras no se confirme).
const VAL_UI: Record<Validacion, { texto: string; color: string; bg: string }> = {
  validando: { texto: 'Validando…', color: 'var(--flit-text-secondary)', bg: GRIS },
  relacionada: { texto: '✓ Relacionada', color: 'var(--flit-blue-text)', bg: 'rgba(48,102,190,0.14)' },
  novedad: { texto: 'Novedad (VIN)', color: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.16)' },
  sin_match: { texto: 'Sin trámite', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.14)' },
  no_gestionable: { texto: 'No gestionable', color: 'var(--flit-text-secondary)', bg: GRIS },
  ya_registrada: { texto: 'Ya registrada', color: 'var(--flit-text-secondary)', bg: GRIS },
  sin_conexion: { texto: 'Sin validar (offline)', color: 'var(--flit-text-secondary)', bg: GRIS },
  error: { texto: 'Error', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.14)' },
};
// Cuando ya se confirmó (o está en curso), el chip de confirmación manda sobre el de validación.
const CONF_UI: Partial<Record<Confirmacion, { texto: string; color: string; bg: string }>> = {
  confirmando: { texto: 'Registrando…', color: 'var(--flit-text-secondary)', bg: GRIS },
  confirmada: { texto: '✓ Registrada', color: 'var(--flit-success)', bg: 'rgba(112,207,58,0.16)' },
  encolada: { texto: 'En cola', color: 'var(--flit-text-secondary)', bg: GRIS },
  error: { texto: 'Error al registrar', color: 'var(--flit-danger)', bg: 'rgba(228,61,48,0.14)' },
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
  const [confirmando, setConfirmando] = useState(false);
  const [resumen, setResumen] = useState<string | null>(null);
  const porRaw = useRef<Map<string, number>>(new Map()); // rawValue → key de fila (dedup del re-escaneo)

  // Precarga el worker de OCR apenas se muestra el panel: para cuando el mensajero abra la cámara y
  // escanee la primera LT, el modelo (~4 MB) ya está en memoria/IndexedDB y no se pierde el número.
  useEffect(() => { precargarOcr(); }, []);

  const parsedPegar = pegar.trim() ? parseLicenciaTransito(pegar.trim()) : null;

  const actualizar = (key: number, patch: Partial<FilaLt>) =>
    setFilas((f) => f.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // Valida el match de una LT contra los trámites aprobados SIN persistir nada.
  const validar = async (key: number, rawValue: string) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      actualizar(key, { validacion: 'sin_conexion', motivo: 'Sin conexión: se registrará al confirmar.' });
      return;
    }
    try {
      const r = await api.post<RespuestaValidacion>('/flito/logistica/validar-lt', { rawValue });
      actualizar(key, { validacion: r.resultado, motivo: r.motivo ?? null });
    } catch (e) {
      actualizar(key, { validacion: 'error', motivo: errorMessage(e) });
    }
  };

  // Agrega (o actualiza) una LT escaneada. NO persiste: solo la valida. Si el mismo código ya está en
  // la lista, no duplica: actualiza su N.º de LT (por si el reintento de OCR ahora sí lo trajo).
  const procesar = async (rawValue: string, numeroLt?: string | null) => {
    const p = parseLicenciaTransito(rawValue);
    if (!p) return; // ilegible: se ignora
    const lt = (numeroLt ?? '').trim();
    const existente = porRaw.current.get(rawValue);
    if (existente != null) { if (lt) actualizar(existente, { numeroLt: lt }); return; }
    const key = Date.now() + Math.random();
    porRaw.current.set(rawValue, key);
    setResumen(null);
    setFilas((f) => [{
      key, rawValue, placa: p.placa, vin: p.vin, propietario: p.propietarioNombre,
      numeroLicencia: p.numeroLicencia, combustible: p.combustible, numeroLt: lt,
      validacion: 'validando', confirmacion: 'pendiente',
    }, ...f]);
    await validar(key, rawValue);
  };

  // Quita una fila de la lista (p. ej. una LT que no trajo número y no se pudo leer).
  const borrar = (fila: FilaLt) => {
    porRaw.current.delete(fila.rawValue);
    setFilas((f) => f.filter((r) => r.key !== fila.key));
  };

  const agregarPegado = () => {
    if (!parsedPegar) return;
    procesar(pegar.trim(), ltManual.trim() || null);
    setPegar(''); setLtManual('');
  };

  // Registra en el backend TODAS las LT relacionadas que aún no se han confirmado (una por una;
  // idempotente y con cola offline). Aquí es donde la LT pasa a 'Registrada'.
  const confirmables = filas.filter((r) => REGISTRABLE.includes(r.validacion) && r.confirmacion !== 'confirmada' && r.confirmacion !== 'confirmando');
  const confirmar = async () => {
    if (!confirmables.length) return;
    setConfirmando(true); setResumen(null);
    const geo = await obtenerUbicacion(); // RN-07: ubicación de la recogida
    let ok = 0; let colas = 0; let err = 0;
    for (const fila of confirmables) {
      actualizar(fila.key, { confirmacion: 'confirmando' });
      try {
        const { queued } = await submitCampo('/flito/logistica/escanear', { rawValue: fila.rawValue, numeroLt: fila.numeroLt || undefined, ...geo }, `LT ${fila.placa}`);
        if (queued) { actualizar(fila.key, { confirmacion: 'encolada' }); colas += 1; }
        else { actualizar(fila.key, { confirmacion: 'confirmada' }); ok += 1; }
      } catch (e) { actualizar(fila.key, { confirmacion: 'error', confirmMotivo: errorMessage(e) }); err += 1; }
    }
    setConfirmando(false);
    setResumen(`${ok} registrada(s)${colas ? ` · ${colas} en cola` : ''}${err ? ` · ${err} con error` : ''}`);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Recoger licencias</h2>
        {filas.length > 0 && <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{filas.length} escaneada(s)</span>}
      </div>

      <div className="rounded-xl border bg-white p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
        {escaneoDisponible() && (
          <button className={btn} style={btnPrimaryStyle} onClick={() => setEscaneando(true)}>📷 Escanear {filas.length ? 'otra LT' : 'LT'}</button>
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
              onBorrar={() => borrar(f)} />
          ))}
        </div>
      )}

      {/* Confirmación en lote: nada se registra hasta pulsar este botón. */}
      {filas.length > 0 && (
        <div className="sticky bottom-3 z-10">
          <button className={btn} style={btnPrimaryStyle} disabled={confirmando || confirmables.length === 0} onClick={confirmar}>
            {confirmando ? 'Registrando…' : `Confirmar recogida${confirmables.length ? ` (${confirmables.length})` : ''}`}
          </button>
          {resumen && <p className="mt-1.5 text-center text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>{resumen}</p>}
        </div>
      )}

      {escaneando && <Escaner onScan={procesar} onClose={() => setEscaneando(false)} />}
    </section>
  );
}

function TarjetaLt({ fila, onChangeLt, onBorrar }: { fila: FilaLt; onChangeLt: (v: string) => void; onBorrar: () => void }) {
  const ui = CONF_UI[fila.confirmacion] ?? VAL_UI[fila.validacion];
  const bloqueado = fila.confirmacion === 'confirmada' || fila.confirmacion === 'confirmando';
  return (
    <div className="rounded-xl border bg-white p-3.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-lg font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fila.placa}</span>
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold" style={{ color: ui.color, background: ui.bg }}>{ui.texto}</span>
          {!bloqueado && (
            <button type="button" aria-label="Quitar LT" onClick={onBorrar}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm active:opacity-70"
              style={{ color: 'var(--flit-danger)', background: 'rgba(228,61,48,0.10)' }}>✕</button>
          )}
        </div>
      </div>
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>N.º de LT</span>
        <input className={`${flitInp} tabular-nums`} inputMode="numeric" value={fila.numeroLt} placeholder="—" disabled={bloqueado}
          onChange={(ev) => onChangeLt(ev.target.value)} />
      </label>
      <div className="mt-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{fila.propietario ?? '—'}</div>
      <div className="mt-0.5 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
        VIN {fila.vin} · Lic. {fila.numeroLicencia}{fila.combustible ? ` · ${fila.combustible}` : ''}
      </div>
      {(fila.confirmMotivo || fila.motivo) && <div className="mt-1.5 text-xs" style={{ color: ui.color }}>{fila.confirmMotivo ?? fila.motivo}</div>}
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
