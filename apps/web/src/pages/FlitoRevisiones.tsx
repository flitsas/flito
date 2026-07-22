// FLITO Revisiones OCR (Fase 6). Porta paginas/revisiones.tsx al kit flit/ + api.
// Todo documento con OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que una
// persona lo confirme (RN-04/RN-05): los campos pre-llenados vienen marcados como no confiables.

import { useEffect, useMemo, useState } from 'react';
import {
  CAMPO_FACTURA_VENTA_LABEL, CAMPO_IMPUESTO_LABEL, CAMPO_SOAT_LABEL, EstadoImpuesto,
  MOTIVO_REVISION_LABEL, type FlujoRevision,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';

type Grupo = 'soat' | 'impuestos';
type CampoExtraido = { valor: string | null; confianza: number; confiable: boolean };

interface RevisionItem {
  id: string; modulo: FlujoRevision; motivo: string; detalle: string; registroId: string | null;
  placaSugerida: string | null; extraccion: Record<string, CampoExtraido | undefined>; resuelto: boolean;
  creadoEn: string; soporte: { id: string; nombreArchivo: string };
}
interface SoatItem { id: string; vin: string; placa: string | null; marca: string | null; linea: string | null }
interface ImpItem { id: string; idFlit: string; placa: string | null; vin: string; estado: string }

const ETIQUETA_MODULO: Record<FlujoRevision, string> = {
  soat: 'Comprobante SOAT', impuestos: 'Recibo de impuestos', factura_venta: 'Factura de venta',
};
const labelCampo = (modulo: FlujoRevision, clave: string): string => {
  const map = modulo === 'soat' ? CAMPO_SOAT_LABEL : modulo === 'factura_venta' ? CAMPO_FACTURA_VENTA_LABEL : CAMPO_IMPUESTO_LABEL;
  return (map as Record<string, string>)[clave] ?? clave;
};
const norm = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[\s-]/g, '');
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

function useRevisiones(modulo: FlujoRevision, incluirResueltas: boolean, nonce: number) {
  const [data, setData] = useState<RevisionItem[]>([]);
  useEffect(() => {
    const q = new URLSearchParams({ modulo, incluirResueltas: String(incluirResueltas) });
    api.get<RevisionItem[]>(`/flito/revisiones?${q}`).then(setData).catch(() => setData([]));
  }, [modulo, incluirResueltas, nonce]);
  return data;
}

// Visor del documento: se descarga como blob (el endpoint exige token y redirige a S3 prefirmado).
function useSoporteUrl(soporteId: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!soporteId) { setUrl(null); return; }
    let objectUrl: string | null = null;
    let vivo = true;
    api.get<Blob>(`/flito/revisiones/soporte/${soporteId}/archivo`).then((blob) => {
      if (!vivo) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl(null));
    return () => { vivo = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [soporteId]);
  return url;
}

function Formulario({ revision, soloLectura, onResuelta }: { revision: RevisionItem; soloLectura: boolean; onResuelta: () => void }) {
  const [valores, setValores] = useState<Record<string, string>>({});
  const [registroId, setRegistroId] = useState('');
  const [soats, setSoats] = useState<SoatItem[]>([]);
  const [impuestos, setImpuestos] = useState<ImpItem[]>([]);
  const [claves, setClaves] = useState<string[]>([]);
  const [motivo, setMotivo] = useState('');
  const [modo, setModo] = useState<'idle' | 'resolver' | 'descartar'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const modulo = revision.modulo;
  const mostrarVin = modulo === 'soat' || modulo === 'factura_venta';

  useEffect(() => {
    const iniciales: Record<string, string> = {};
    for (const [clave, campo] of Object.entries(revision.extraccion)) if (campo?.valor) iniciales[clave] = campo.valor;
    setValores(iniciales);
    setRegistroId(revision.registroId ?? '');
    setMotivo(''); setModo('idle'); setError(null);
    api.get<string[]>(`/flito/revisiones/campos/${modulo}`).then(setClaves).catch(() => setClaves([]));
    if (modulo === 'soat') api.get<SoatItem[]>('/flito/soat').then(setSoats).catch(() => setSoats([]));
    else api.get<ImpItem[]>('/flito/impuestos').then(setImpuestos).catch(() => setImpuestos([]));
  }, [revision, modulo]);

  const candidatos = useMemo(() => {
    if (modulo === 'soat') return soats.map((s) => ({ id: s.id, placa: s.placa, vin: s.vin, etiqueta: `${s.placa} · ${s.marca ?? ''} ${s.linea ?? ''}`.trim() }));
    const estado = modulo === 'factura_venta' ? EstadoImpuesto.SIN_FACTURA : EstadoImpuesto.EN_GESTION;
    return impuestos.filter((i) => i.estado === estado).map((i) => ({ id: i.id, placa: i.placa, vin: i.vin, etiqueta: `${i.placa} · ${i.idFlit}` }));
  }, [modulo, soats, impuestos]);

  const seleccionado = candidatos.find((c) => c.id === registroId);

  const enviar = async () => {
    setError(null); setEnviando(true);
    try {
      if (modo === 'resolver') await api.post(`/flito/revisiones/${revision.id}/resolver`, { registroId, campos: valores, motivo });
      else await api.post(`/flito/revisiones/${revision.id}/descartar`, { motivo });
      onResuelta();
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="neutral">{ETIQUETA_MODULO[modulo]}</StatusChip>
          <StatusChip tone="warning">{MOTIVO_REVISION_LABEL[revision.motivo as keyof typeof MOTIVO_REVISION_LABEL] ?? revision.motivo}</StatusChip>
          {revision.resuelto && <StatusChip tone="success">Resuelta</StatusChip>}
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{revision.detalle}</p>
      </div>

      <FlitField label="Trámite contra el que se concilia *">
        <select value={registroId} disabled={soloLectura || revision.resuelto} onChange={(e) => setRegistroId(e.target.value)} className={flitInp}>
          <option value="">Selecciona el trámite…</option>
          {candidatos.map((c) => (
            <option key={c.id} value={c.id}>{c.etiqueta}{revision.placaSugerida && c.placa === revision.placaSugerida ? '  (coincide con la placa leída)' : ''}</option>
          ))}
        </select>
      </FlitField>

      {seleccionado && (
        <div className="rounded-lg border text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="grid grid-cols-[70px_1fr_1fr] gap-2 border-b px-3 py-1.5 text-xs font-semibold" style={{ color: 'var(--flit-text-muted)', borderColor: 'var(--flit-border-soft)' }}>
            <span>Campo</span><span>Trámite</span><span>Leído del PDF</span>
          </div>
          {[{ e: 'Placa', t: seleccionado.placa ?? '—', l: revision.extraccion.placa?.valor ?? null },
            ...(mostrarVin ? [{ e: 'VIN', t: seleccionado.vin ?? '—', l: revision.extraccion.vin?.valor ?? null }] : [])
          ].map((f) => {
            const cruza = f.l !== null && norm(f.t) === norm(f.l);
            return (
              <div key={f.e} className="grid grid-cols-[70px_1fr_1fr] items-center gap-2 px-3 py-1.5">
                <span style={{ color: 'var(--flit-text-muted)' }}>{f.e}</span>
                <span className="font-medium tabular-nums">{f.t}</span>
                <span className={cruza ? '' : 'text-red-600'}>{f.l ? `${cruza ? '✓ ' : '✗ '}${f.l}` : 'No leído'}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {claves.map((clave) => {
          const campo = revision.extraccion[clave];
          return (
            <div key={clave} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium" htmlFor={`c-${clave}`}>{labelCampo(modulo, clave)}</label>
                {campo ? <StatusChip tone="warning">{Math.round(campo.confianza * 100)}% · no confiable</StatusChip> : <StatusChip tone="neutral">Sin lectura</StatusChip>}
              </div>
              <input id={`c-${clave}`} className={flitInp} disabled={soloLectura || revision.resuelto}
                value={valores[clave] ?? ''} placeholder="Escribe el valor correcto"
                onChange={(e) => setValores((v) => ({ ...v, [clave]: e.target.value }))} />
            </div>
          );
        })}
      </div>

      {!soloLectura && !revision.resuelto && modo === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!registroId} onClick={() => setModo('resolver')}>Confirmar y resolver</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setModo('descartar')}>Descartar documento</button>
        </div>
      )}

      {modo !== 'idle' && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="text-sm font-medium">{modo === 'resolver' ? 'Deja constancia de qué validaste' : 'Motivo del descarte (mín. 5 caracteres)'}</p>
          <textarea className={`${flitInp} mt-2 min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
          <div className="mt-2 flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || !motivo.trim() || (modo === 'descartar' && motivo.trim().length < 5)} onClick={enviar}>
              {enviando ? 'Enviando…' : modo === 'resolver' ? 'Resolver' : 'Descartar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { setModo('idle'); setError(null); }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FlitoRevisiones() {
  const { user } = useAuth();
  const [grupo, setGrupo] = useState<Grupo>('soat');
  const [incluirResueltas, setIncluirResueltas] = useState(false);
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  const soloLectura = user?.role === 'auditor';

  const rSoat = useRevisiones('soat', incluirResueltas, recarga);
  const rImp = useRevisiones('impuestos', incluirResueltas, recarga);
  const rFv = useRevisiones('factura_venta', incluirResueltas, recarga);

  const data = useMemo(() => grupo === 'soat' ? rSoat
    : [...rImp, ...rFv].sort((a, b) => b.creadoEn.localeCompare(a.creadoEn)), [grupo, rSoat, rImp, rFv]);
  const seleccionada = useMemo(() => data.find((r) => r.id === seleccionadaId) ?? data[0] ?? null, [data, seleccionadaId]);
  const url = useSoporteUrl(seleccionada?.soporte.id);

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Revisiones OCR"
        subtitle="Todo documento con OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que alguien lo confirme."
        actions={
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={incluirResueltas} onChange={(e) => setIncluirResueltas(e.target.checked)} />
            Incluir resueltas
          </label>
        }
      />

      <FlitPillGroup>
        <FlitPillButton active={grupo === 'soat'} onClick={() => { setGrupo('soat'); setSeleccionadaId(null); }}>SOAT</FlitPillButton>
        <FlitPillButton active={grupo === 'impuestos'} onClick={() => { setGrupo('impuestos'); setSeleccionadaId(null); }}>Impuestos</FlitPillButton>
      </FlitPillGroup>

      {data.length === 0 ? (
        <FlitCard><FlitEmpty>No hay nada en revisión. Cuando una extracción no supere el umbral o su llave no cruce, el documento aparecerá aquí.</FlitEmpty></FlitCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr_1fr]">
          <FlitCard>
            <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Cola ({data.length})</p>
            <div className="space-y-1.5">
              {data.map((r) => (
                <button key={r.id} type="button" onClick={() => setSeleccionadaId(r.id)}
                  className="w-full rounded-md border p-2 text-left transition-colors hover:bg-gray-50"
                  style={{ borderColor: seleccionada?.id === r.id ? 'var(--flit-blue-text)' : 'var(--flit-border-soft)' }}>
                  <p className="truncate text-sm font-medium">{r.soporte.nombreArchivo}</p>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{ETIQUETA_MODULO[r.modulo]} · {fechaHora(r.creadoEn)}</p>
                </button>
              ))}
            </div>
          </FlitCard>

          {seleccionada && (
            <>
              <FlitCard>
                <p className="mb-2 truncate text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{seleccionada.soporte.nombreArchivo}</p>
                {url ? <object data={url} type="application/pdf" className="h-[600px] w-full rounded-md border" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <a href={url} target="_blank" rel="noreferrer">Abrir el documento</a>
                </object> : <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando documento…</p>}
              </FlitCard>

              <FlitCard>
                {soloLectura && <div className="mb-3 rounded-md bg-blue-50 p-2 text-sm text-blue-800">Solo lectura · Auditoría ve la cola y los soportes, pero no los resuelve.</div>}
                <Formulario key={seleccionada.id} revision={seleccionada} soloLectura={!!soloLectura}
                  onResuelta={() => { setSeleccionadaId(null); setRecarga((n) => n + 1); }} />
              </FlitCard>
            </>
          )}
        </div>
      )}
    </div>
  );
}
