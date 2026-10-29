// FLITO Logística — paso «Confirmar recogida» con la firma del funcionario (HU #14111, ADR-0030 §17).
// Una sola firma sirve para todas las actas (una por compañía). Nombre, cédula y firma viven SOLO en el
// estado de este componente: nunca en URL, consola, localStorage ni estado del router.

import { useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../../lib/api';
import { obtenerUbicacion } from '../../../lib/geo';
import FlitModal from '../../flit/FlitModal';
import { FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitInp } from '../../flit/flitPageKit';
import FirmaCanvas from '../FirmaCanvas';
import { mensajeConfirmar, nuevaKey, type FilaLt, type RecogidaConfirmada } from './recogidaTipos';

export interface ResumenRecogida { actas: number; companias: Array<{ nombre: string; lt: number }>; pendientes: number }

const NOMBRE_OK = /^[^\d]{3,}$/;
const CEDULA_OK = /^\d{5,12}$/;
const MAX_FIRMA = 1_000_000;

interface Props {
  filas: FilaLt[]; // ya registradas (con documentoId) y que entran a la recogida
  onAtras: () => void;
  onConfirmado: (r: ResumenRecogida) => void;
  onSinFirma: () => void;
}

export default function PasoFirma({ filas, onAtras, onConfirmado, onSinFirma }: Props) {
  const [nombre, setNombre] = useState('');
  const [cedula, setCedula] = useState('');
  const [firma, setFirma] = useState<string | null>(null);
  const [intento, setIntento] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogoSinFirma, setDialogoSinFirma] = useState(false);
  const claves = useRef<Map<string, string>>(new Map());

  const { grupos, pendientes, sinOrganismo, porOrganismo } = useMemo(() => {
    const g = new Map<string, FilaLt[]>(); const pend: FilaLt[] = []; const sinOrg: FilaLt[] = []; const org = new Map<string, FilaLt[]>();
    for (const f of filas) {
      if (!f.organismoCodigo) { sinOrg.push(f); continue; }
      org.set(f.organismoCodigo, [...(org.get(f.organismoCodigo) ?? []), f]);
      if (f.estado === 'pendiente') pend.push(f);
      else { const k = f.companiaNombre ?? 'Compañía sin nombre'; g.set(k, [...(g.get(k) ?? []), f]); }
    }
    return { grupos: [...g.entries()], pendientes: pend, sinOrganismo: sinOrg, porOrganismo: org };
  }, [filas]);

  const total = filas.length - sinOrganismo.length;
  const errNombre = intento && !NOMBRE_OK.test(nombre.trim()) ? 'Escribe el nombre completo del funcionario' : null;
  const errCedula = intento && !CEDULA_OK.test(cedula) ? 'La cédula debe tener solo números (5 a 12 dígitos)' : null;
  const errFirma = intento && !firma ? 'Falta la firma del funcionario' : intento && firma && firma.length * 0.75 > MAX_FIRMA ? 'La firma es muy pesada. Bórrala y vuelve a firmar con trazos más cortos.' : null;

  const confirmar = async () => {
    setIntento(true); setError(null);
    if (!NOMBRE_OK.test(nombre.trim()) || !CEDULA_OK.test(cedula) || !firma || firma.length * 0.75 > MAX_FIRMA) return;
    setEnviando(true);
    try {
      const geo = await obtenerUbicacion(); // RN-07: solo en el evento de confirmar
      let actas = 0;
      for (const [organismo, fs] of porOrganismo) {
        const ids = fs.map((f) => f.documentoId!).sort();
        const sig = `${organismo}:${ids.join(',')}:${nombre.trim()}:${cedula}:${firma}`; // misma clave solo si el cuerpo es idéntico
        if (!claves.current.has(sig)) claves.current.set(sig, nuevaKey()); // el reintento reusa la clave: no duplica actas
        const r = await api.post<RecogidaConfirmada>('/flito/logistica/recogidas/confirmar',
          { organismoCodigo: organismo, documentoIds: ids, firmante: { nombre: nombre.trim(), documento: cedula, firma }, ...geo },
          { 'Idempotency-Key': claves.current.get(sig)! });
        actas += r.actas.length;
      }
      onConfirmado({ actas, companias: grupos.map(([n, fs]) => ({ nombre: n, lt: fs.length })), pendientes: pendientes.length });
    } catch (e) { setError(mensajeConfirmar(e)); }
    finally { setEnviando(false); }
  };

  const resumen = `${total} LT · ${grupos.length} ${grupos.length === 1 ? 'compañía' : 'compañías'}${pendientes.length ? ` · ${pendientes.length} ${pendientes.length === 1 ? 'pendiente' : 'pendientes'}` : ''}`;

  if (total === 0) {
    return (
      <section className="space-y-3" aria-labelledby="firma-titulo">
        <h2 id="firma-titulo" className="text-sm font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Confirmar recogida</h2>
        <p className="rounded-xl border border-dashed p-6 text-center text-sm" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-muted)' }}>
          Ninguna de las LT escaneadas se puede recoger. Vuelve atrás y escanea otras.
        </p>
        <button type="button" className={`${flitBtnSecondary} w-full justify-center`} style={{ minHeight: 48 }} onClick={onAtras}>Atrás</button>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="firma-titulo">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onAtras} disabled={enviando}
          className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)] disabled:opacity-50"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          <ChevronLeft size={18} aria-hidden="true" /> Atrás
        </button>
        <h2 id="firma-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>Confirmar recogida</h2>
      </div>
      <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {resumen}. Se generará 1 acta por compañía con una sola firma{grupos.length > 1 ? `: una firma sirve para las ${grupos.length} actas` : ''}.
      </p>

      <div className="space-y-2">
        {grupos.map(([nombreCia, fs], i) => (
          <GrupoLt key={nombreCia} titulo={nombreCia} detalle={`${fs.length} LT → acta ${i + 1}`} filas={fs} />
        ))}
        {pendientes.length > 0 && (
          <GrupoLt titulo="Pendientes de trámite" detalle={`${pendientes.length} LT (sin acta)`} filas={pendientes}
            nota="Quedan con la firma, sin acta, hasta que Operaciones elija el trámite." />
        )}
      </div>
      {sinOrganismo.length > 0 && (
        <p role="status" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-warning-ink)' }}>
          {sinOrganismo.length} LT no se incluyen porque no pudimos identificar su organismo. Quítala y vuelve a escanearla, o ingrésala a mano.
        </p>
      )}

      <fieldset className="space-y-3 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }} disabled={enviando}>
        <legend className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Funcionario del organismo</legend>
        <FlitField label="Nombre">
          <input className={flitInp} value={nombre} autoComplete="off" aria-invalid={!!errNombre} aria-describedby={errNombre ? 'err-nombre' : undefined}
            onChange={(e) => setNombre(e.target.value)} />
        </FlitField>
        {errNombre && <p id="err-nombre" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errNombre}</p>}
        <FlitField label="Cédula">
          <input className={`${flitInp} tabular-nums`} value={cedula} inputMode="numeric" autoComplete="off" aria-invalid={!!errCedula}
            aria-describedby={errCedula ? 'err-cedula' : undefined} onChange={(e) => setCedula(e.target.value.replace(/\D/g, '').slice(0, 12))} />
        </FlitField>
        {errCedula && <p id="err-cedula" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errCedula}</p>}
        <div>
          <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Firma</span>
          <div className={enviando ? 'pointer-events-none opacity-60' : ''}>
            <FirmaCanvas onChange={setFirma} label={firma ? 'Firma del funcionario, capturada' : 'Firma del funcionario, vacía'} />
          </div>
          {errFirma && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errFirma}</p>}
        </div>
      </fieldset>

      <div className="sticky bottom-3 z-10 lg:bottom-24 space-y-2 rounded-xl p-1" style={{ background: 'var(--flit-bg-app)' }}>
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
            <span className="flex-1">{error}</span>
            <button type="button" className={`${flitBtnSecondary} text-xs`} style={{ minHeight: 40 }} onClick={() => void confirmar()}>Reintentar</button>
          </div>
        )}
        <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }}
          disabled={enviando} onClick={() => void confirmar()}>
          {enviando ? 'Confirmando…' : 'Confirmar recogida'}
        </button>
        <button type="button" disabled={enviando} onClick={() => setDialogoSinFirma(true)}
          className="flit-focus mx-auto block rounded px-2 py-2 text-sm font-medium underline-offset-2 transition-colors hover:underline disabled:opacity-50" style={{ color: 'var(--flit-text-secondary)', minHeight: 40 }}>
          Confirmar sin firma
        </button>
      </div>

      {dialogoSinFirma && (
        <FlitModal title="Confirmar sin firma" onClose={() => setDialogoSinFirma(false)}>
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              Sin firma la recogida no se confirma: las LT quedan escaneadas con el acta pendiente de firma. Podrás firmarla después desde esta pantalla.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} onClick={() => setDialogoSinFirma(false)}>Volver</button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => { setDialogoSinFirma(false); onSinFirma(); }}>Confirmar sin firma</button>
            </div>
          </div>
        </FlitModal>
      )}
    </section>
  );
}

function GrupoLt({ titulo, detalle, filas, nota }: { titulo: string; detalle: string; filas: FilaLt[]; nota?: string }) {
  return (
    <section aria-label={titulo} className="rounded-xl border bg-flit-card p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{titulo}</h3>
        <span className="shrink-0 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{detalle}</span>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {filas.map((f) => (
          <li key={f.key} className="tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{f.placa} · {f.numeroLt || '—'}</li>
        ))}
      </ul>
      {nota && <p className="mt-1.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{nota}</p>}
    </section>
  );
}
