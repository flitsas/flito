// TRAM-TRASPASO-F5 — Expediente STT del traspaso (operador del organismo de tránsito).
// Ruta /transito/traspaso?id=N. Paridad CEA TransitosModule: validación, regeneración
// de documentos legales, registro pago + N° RUNT, cargues STT y avance del workflow.
// Reconstruido fielmente desde el chunk de producción TransitoTraspasoExpediente-B84yTtNf.js.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ESTADO_STT_LABEL,
  TRASPASO_STT_DOC_TIPOS,
  extractPartesTraspasoFromTramite,
  resolverValidacionTraspasoParte,
  puedeMutarTraspaso,
  transicionesDesde,
  traspasoSttOperativo,
  type TramiteEstadoStt,
  type TramiteWorkflowEvent,
  type TraspasoSttDatos,
  type TraspasoSttDocTipo,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import FlitUploadBox from '../components/flit/FlitUploadBox';
import ExpedienteVisor from '../components/ExpedienteVisor';
import type { ArchivoData, CompradorData, ValidationStatus, VehiculoData, VendedorData } from './tramite/wizard/types';

// ---------------------------------------------------------------------------
// Documentos legales regenerables desde el expediente STT (FUR / contrato /
// improntas) — mismos endpoints que el wizard del gestor CEA.
// ---------------------------------------------------------------------------

type DocKind = 'fur' | 'contrato' | 'improntas';

interface DocKindConfig {
  path: string;
  label: string;
  file: (tramiteId: number, placa?: string | null) => string;
}

const DOC_KINDS: Record<DocKind, DocKindConfig> = {
  fur: {
    path: 'generar-fur',
    label: 'FUR (Formulario Único de Registro)',
    file: (tramiteId, placa) => `FUR_${placa || tramiteId}.pdf`,
  },
  contrato: {
    path: 'generar-contrato',
    label: 'Contrato de compraventa',
    file: (tramiteId) => `Contrato_Compraventa_${tramiteId}.pdf`,
  },
  improntas: {
    path: 'generar-improntas',
    label: 'Certificado de improntas',
    file: (tramiteId, placa) => `Improntas_${placa || tramiteId}.pdf`,
  },
};

interface OrgDatos {
  orgNombre: string;
  orgCiudad: string;
  orgCodigo: string;
}

interface ErrorBody {
  error?: string;
  message?: string;
  code?: string;
}

// El backend puede negar la generación con un code de gate (p.ej. biometría
// incompleta). Traducimos a mensaje accionable para el operador STT.
function mensajeErrorGeneracion(status: number, data: ErrorBody): string {
  const base = data.error || data.message || `Error ${status}`;
  if (data.code === 'biometria_gate' || data.code === 'biometria_pendiente') {
    return `${base} Mueva el trámite a Subsanación para que el gestor CEA complete la identidad biométrica de vendedor y comprador.`;
  }
  if (data.code === 'mutacion_denegada' || data.code === 'gestion_cerrada') return base;
  return data.code ? `${base} (${data.code})` : base;
}

// POST que devuelve un PDF y lo rasteriza a PNGs con pdfjs (visor inline).
async function fetchPdfPages(url: string, body: OrgDatos): Promise<{ pages: string[]; blobUrl: string }> {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: ErrorBody = {};
    try { data = await res.json(); } catch { /* cuerpo no-JSON */ }
    throw new Error(mensajeErrorGeneracion(res.status, data));
  }
  const buf = await res.arrayBuffer();
  const blob = new Blob([buf], { type: 'application/pdf' });
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    pages.push(c.toDataURL('image/png'));
  }
  return { pages, blobUrl: URL.createObjectURL(blob) };
}

function DocumentoLegalPanel({ kind, tramiteId, placa, org, editable }: {
  kind: DocKind;
  tramiteId: number;
  placa?: string | null;
  org: OrgDatos;
  editable: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<string[]>([]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  const cfg = DOC_KINDS[kind];
  const body: OrgDatos = {
    orgNombre: org.orgNombre || '',
    orgCiudad: org.orgCiudad || '',
    orgCodigo: org.orgCodigo || '',
  };

  const generar = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    setPages([]);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    try {
      const r = await fetchPdfPages(`/api/tramites/${tramiteId}/${cfg.path}`, body);
      setBlobUrl(r.blobUrl);
      setPages(r.pages);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const descargar = async () => {
    try {
      await api.downloadPost(`/tramites/${tramiteId}/${cfg.path}`, cfg.file(tramiteId, placa), body);
      toast.success(`${cfg.label} descargado`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
      >
        <p className="text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>{cfg.label}</p>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || !editable}
            onClick={() => void generar()}
            className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
            style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}
          >
            {loading ? 'Generando…' : pages.length ? 'Regenerar' : 'Ver / generar'}
          </button>
          <button
            type="button"
            disabled={loading || !editable}
            onClick={() => void descargar()}
            className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
            style={{ color: 'var(--flit-text-secondary)', background: 'white', border: '1px solid var(--flit-border-soft)' }}
          >
            Descargar PDF
          </button>
          {blobUrl && (
            <button
              type="button"
              onClick={() => window.open(blobUrl, '_blank', 'noopener,noreferrer')}
              className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-semibold"
              style={{ color: 'var(--flit-text-secondary)', background: 'white', border: '1px solid var(--flit-border-soft)' }}
            >
              Abrir
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="px-3 py-2 text-[11px] font-semibold" style={{ color: 'var(--flit-danger)' }}>{error}</p>
      )}
      {pages.length > 0 ? (
        <div className="flex flex-col gap-2 p-3" style={{ background: 'var(--flit-bg-app)' }}>
          {pages.map((src, idx) => (
            <img
              key={idx}
              src={src}
              alt={`${cfg.label} pág. ${idx + 1}`}
              className="w-full rounded-[8px] border bg-white"
              style={{ borderColor: 'var(--flit-border-soft)' }}
            />
          ))}
        </div>
      ) : (
        <p className="px-3 py-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {editable
            ? 'Pulse Ver / generar para previsualizar el PDF aquí (paridad CEA).'
            : 'Solo consulta — el expediente no admite regeneración en este estado.'}
        </p>
      )}
    </div>
  );
}

function DocumentosLegales({ tramiteId, placa, org, editable = true }: {
  tramiteId: number;
  placa?: string | null;
  org: OrgDatos;
  editable?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label="Documentos legales traspaso">
      <p className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
        Regeneración de FUR, contrato e improntas desde el expediente STT (sin volver al wizard del gestor).
      </p>
      <DocumentoLegalPanel kind="fur" tramiteId={tramiteId} placa={placa} org={org} editable={editable} />
      <DocumentoLegalPanel kind="contrato" tramiteId={tramiteId} placa={placa} org={org} editable={editable} />
      <DocumentoLegalPanel kind="improntas" tramiteId={tramiteId} placa={placa} org={org} editable={editable} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Expediente STT
// ---------------------------------------------------------------------------

const STT_DOC_LABEL: Record<TraspasoSttDocTipo, string> = {
  comprobante_derechos: 'Comprobante pago derechos STT',
  acta_entrega: 'Acta de entrega',
  runt_respuesta: 'Respuesta / cargue RUNT',
  stt_anexo: 'Anexo STT',
};

const TABS = ['resumen', 'documentos', 'pagos', 'workflow'] as const;
type Tab = (typeof TABS)[number];

interface TraspasoVehiculo extends VehiculoData {
  _stt?: TraspasoSttDatos;
  _comprador?: Partial<CompradorData>;
}

interface TraspasoDetalle {
  id: number;
  numeroRadicado?: string | null;
  placa?: string | null;
  vin?: string | null;
  estado: string;
  organismoCodigo?: string | null;
  comprador?: Partial<CompradorData> | null;
  vehiculo?: TraspasoVehiculo | null;
  workflow?: TramiteWorkflowEvent[] | null;
}

export default function TransitoTraspasoExpediente() {
  const [searchParams] = useSearchParams();
  const tramiteId = searchParams.get('id') ? Number(searchParams.get('id')) : null;
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('resumen');
  const [tramite, setTramite] = useState<TraspasoDetalle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nota, setNota] = useState('');
  const [stt, setStt] = useState<TraspasoSttDatos>({});
  const [archivos, setArchivos] = useState<ArchivoData[]>([]);
  const [validacion, setValidacion] = useState<ValidationStatus | null>(null);

  const cargar = useCallback(async () => {
    if (!tramiteId) return;
    setLoading(true);
    try {
      const [det, docs, val] = await Promise.all([
        api.get<TraspasoDetalle>(`/transito/traspasos/${tramiteId}`),
        api.get<ArchivoData[]>(`/tramites/${tramiteId}/documentos`),
        api.get<{ validaciones?: { id: number; estado: string; documento?: string | null; parte?: string | null; score?: number | null }[] }>(`/validacion-identidad/estado/${tramiteId}`).catch(() => null),
      ]);
      setTramite(det);
      const prev = det.vehiculo?._stt || {};
      const datos: TraspasoSttDatos = {
        numeroRunt: prev.numeroRunt || '',
        notasStt: prev.notasStt || '',
        pago: prev.pago || { valor: 0, metodo: 'Efectivo', ref: '' },
        asignadoA: prev.asignadoA || '',
      };
      // Auto-asignación: el primer operador que abre un expediente operativo sin
      // dueño queda como "Operador asignado" (best-effort, no bloquea la carga).
      if (traspasoSttOperativo(det.estado) && user?.username && !prev.asignadoA) {
        datos.asignadoA = user.username;
        try {
          await api.patch(`/tramites/${tramiteId}`, { vehiculo: { _stt: datos } });
        } catch { /* asignación best-effort */ }
      }
      setStt(datos);
      setArchivos(docs);
      // Resolver por documento+rol (no por recencia): vendedor y comprador vigentes.
      const vals = val?.validaciones ?? [];
      const partes = extractPartesTraspasoFromTramite({ vehiculo: det.vehiculo, comprador: det.comprador });
      const valV = resolverValidacionTraspasoParte(vals, { parte: 'vendedor', documento: partes.vendedor.documento });
      const valC = resolverValidacionTraspasoParte(vals, { parte: 'comprador', documento: partes.comprador.documento });
      const ambasAprobadas = valV?.estado === 'aprobado' && valC?.estado === 'aprobado';
      const vigente = valC ?? valV;
      setValidacion(
        ambasAprobadas
          ? { estado: 'aprobado' }
          : vigente
            ? { estado: vigente.estado, score: vigente.score ?? undefined }
            : null,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [tramiteId, user?.username]);

  useEffect(() => { void cargar(); }, [cargar]);

  const operativo = tramite ? traspasoSttOperativo(tramite.estado) : false;
  const puedeGenerar = tramite && user ? puedeMutarTraspaso(user.role, tramite.estado, 'generar_legal') : false;
  const transiciones = tramite ? transicionesDesde(tramite.estado) : [];
  const veh: TraspasoVehiculo = tramite?.vehiculo || {};
  const vendedor: Partial<VendedorData> = veh._vendedor || {};
  const comprador: Partial<CompradorData> = { ...(veh._comprador || {}), ...(tramite?.comprador || {}) };

  const guardarStt = async () => {
    if (!tramiteId || !operativo) return;
    setSaving(true);
    try {
      await api.patch(`/tramites/${tramiteId}`, { vehiculo: { _stt: stt } });
      toast.success('Datos STT guardados');
      await cargar();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const subirDocumento = async (tipo: string, file: File) => {
    if (!tramiteId || !operativo) return;
    await api.upload(`/tramites/${tramiteId}/documentos`, file, 'file', { tipo });
    toast.success('Documento STT cargado');
    await cargar();
  };

  const cambiarEstado = async (estado: TramiteEstadoStt) => {
    if (!tramiteId || saving) return;
    if (estado === 'subsanacion' && !nota.trim()) {
      toast.error('Indique qué debe corregir el gestor CEA (nota obligatoria en Subsanación)');
      return;
    }
    setSaving(true);
    try {
      const r = await api.patch<{ estado: string }>(`/tramites/${tramiteId}/estado`, {
        estado,
        nota: nota.trim() || undefined,
      });
      toast.success(`Estado: ${ESTADO_STT_LABEL[estado]}`);
      setNota('');
      setTramite((t) => t && { ...t, estado: r.estado });
      await cargar();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const orgTransito = useMemo(() => {
    const o = veh._orgTransito;
    return o?.codigo && o.nombre && o.ciudad
      ? { nombre: o.nombre, ciudad: o.ciudad, codigo: o.codigo }
      : undefined;
  }, [veh._orgTransito]);

  if (!tramiteId) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>ID de traspaso requerido.</p>
        <Link to="/transito" className="mt-2 inline-block text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>
          ← Bandeja STT
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeaderCard
          title="Expediente STT — Traspaso"
          subtitle={tramite?.numeroRadicado ? `${tramite.numeroRadicado} · Placa ${tramite.placa || '—'}` : 'Cargando…'}
        />
        <Link to="/transito" className="flit-focus text-sm font-semibold" style={{ color: 'var(--flit-blue)' }}>
          ← Bandeja Traspasos STT
        </Link>
      </div>

      {loading && !tramite && (
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando expediente…</p>
      )}

      {tramite && (
        <>
          <div
            className="flex flex-wrap items-center gap-2 rounded-[12px] border px-4 py-3"
            style={{ borderColor: 'var(--flit-blue)', background: 'var(--flit-blue-soft)' }}
          >
            <StatusChip tone="active">{ESTADO_STT_LABEL[tramite.estado as TramiteEstadoStt] ?? tramite.estado}</StatusChip>
            <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              {operativo
                ? 'Puede validar, cargar soportes STT y avanzar el flujo.'
                : 'Expediente en solo lectura en este estado.'}
            </span>
          </div>

          <nav
            className="flex flex-wrap gap-1 border-b pb-1"
            style={{ borderColor: 'var(--flit-border-soft)' }}
            role="tablist"
            aria-label="Expediente STT"
          >
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className="flit-focus rounded-t-[8px] px-3 py-2 text-xs font-semibold capitalize"
                style={tab === t
                  ? { color: 'var(--flit-blue)', borderBottom: '2px solid var(--flit-blue)' }
                  : { color: 'var(--flit-text-muted)' }}
              >
                {t === 'pagos' ? 'Pagos STT' : t}
              </button>
            ))}
          </nav>

          {tab === 'resumen' && (
            <section className="grid gap-4 sm:grid-cols-2">
              <CardBox title="Vehículo">
                <Field label="Placa" value={tramite.placa} mono />
                <Field label="VIN" value={tramite.vin} mono />
                <Field label="Marca / línea" value={[veh.marca, veh.linea, veh.modelo].filter(Boolean).join(' ')} />
              </CardBox>
              <CardBox title="Partes">
                <Field label="Vendedor" value={vendedor.nombre} />
                <Field label="Doc. vendedor" value={vendedor.documento} mono />
                <Field label="Comprador" value={comprador.nombre} />
                <Field label="Doc. comprador" value={comprador.documento} mono />
                <Field label="Operador STT" value={stt.asignadoA || 'Sin asignar'} mono />
                {validacion?.estado && <Field label="Identidad biométrica" value={validacion.estado} />}
              </CardBox>
            </section>
          )}

          {tab === 'documentos' && (
            <section className="flex flex-col gap-4">
              <DocumentosLegales
                tramiteId={tramiteId}
                placa={tramite.placa}
                org={{
                  orgNombre: orgTransito?.nombre || '',
                  orgCiudad: orgTransito?.ciudad || '',
                  orgCodigo: orgTransito?.codigo || tramite.organismoCodigo || '',
                }}
                editable={puedeGenerar}
              />
              <ExpedienteVisor
                tramiteId={tramiteId}
                vehiculo={veh}
                comprador={comprador}
                vin={tramite.vin || ''}
                archivos={archivos}
                validationStatus={validacion}
                emailSent={false}
                orgTransito={orgTransito}
                variant="traspaso"
              />
              {operativo && (
                <div className="rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <p className="mb-3 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                    Cargues del organismo STT
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {TRASPASO_STT_DOC_TIPOS.map((tipo) => (
                      <FlitUploadBox
                        key={tipo}
                        label={STT_DOC_LABEL[tipo] || tipo}
                        state={archivos.some((a) => a.tipo === tipo) ? 'verified' : 'idle'}
                        count={archivos.filter((a) => a.tipo === tipo).length}
                        onFile={(file) => subirDocumento(tipo, file).catch((err) => toast.error(errorMessage(err)))}
                      />
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'pagos' && (
            <section className="rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <p className="mb-3 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>
                Registro STT (paridad CEA — pago + N° RUNT)
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  Operador asignado
                  <input
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)', background: 'var(--flit-bg-app)' }}
                    value={stt.asignadoA || ''}
                    disabled
                    readOnly
                  />
                </label>
                <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  N° RUNT / radicado organismo
                  <input
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)' }}
                    value={stt.numeroRunt || ''}
                    disabled={!operativo || saving}
                    onChange={(e) => setStt((prev) => ({ ...prev, numeroRunt: e.target.value }))}
                  />
                </label>
                <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  Valor derechos ($)
                  <input
                    type="number"
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)' }}
                    value={stt.pago?.valor ?? 0}
                    disabled={!operativo || saving}
                    onChange={(e) => setStt((prev) => ({
                      ...prev,
                      pago: { ...prev.pago, valor: Number(e.target.value) || 0 },
                    }))}
                  />
                </label>
                <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  Método de pago
                  <select
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)' }}
                    value={stt.pago?.metodo || 'Efectivo'}
                    disabled={!operativo || saving}
                    onChange={(e) => setStt((prev) => ({
                      ...prev,
                      pago: { ...prev.pago, metodo: e.target.value },
                    }))}
                  >
                    {['Efectivo', 'Transferencia', 'PSE', 'Datafono'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  Referencia / recibo
                  <input
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)' }}
                    value={stt.pago?.ref || ''}
                    disabled={!operativo || saving}
                    onChange={(e) => setStt((prev) => ({
                      ...prev,
                      pago: { ...prev.pago, ref: e.target.value },
                    }))}
                  />
                </label>
                <label className="sm:col-span-2 block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                  Notas internas STT
                  <textarea
                    rows={2}
                    className="flit-focus mt-1 w-full rounded-[10px] border px-3 py-2 text-sm"
                    style={{ borderColor: 'var(--flit-border-input)' }}
                    value={stt.notasStt || ''}
                    disabled={!operativo || saving}
                    onChange={(e) => setStt((prev) => ({ ...prev, notasStt: e.target.value }))}
                  />
                </label>
              </div>
              {operativo && (
                <div className="mt-4 flex justify-end">
                  <GradientButton type="button" disabled={saving} onClick={() => void guardarStt()}>
                    {saving ? 'Guardando…' : 'Guardar datos STT'}
                  </GradientButton>
                </div>
              )}
            </section>
          )}

          {tab === 'workflow' && (
            <section className="rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <p className="mb-3 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
                Trazabilidad
              </p>
              <ul className="flex flex-col gap-2">
                {(tramite.workflow || []).length === 0 && (
                  <li className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin eventos registrados.</li>
                )}
                {(tramite.workflow || []).map((ev, idx) => (
                  <li
                    key={idx}
                    className="rounded-[8px] border px-3 py-2 text-xs"
                    style={{ borderColor: 'var(--flit-border-soft)' }}
                  >
                    <span className="font-bold" style={{ color: 'var(--flit-blue)' }}>
                      {ev.de || '—'} → {ev.a}
                    </span>
                    <span className="ml-2" style={{ color: 'var(--flit-text-muted)' }}>{ev.usuario}</span>
                    {ev.nota && (
                      <p className="mt-1" style={{ color: 'var(--flit-text-secondary)' }}>{ev.nota}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {transiciones.length > 0 && (
            <section
              className="rounded-[14px] border-2 p-4"
              style={{ borderColor: 'var(--flit-blue)', background: 'var(--flit-blue-soft)' }}
            >
              <p className="mb-2 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Avanzar flujo STT</p>
              <label className="mb-2 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                Nota del cambio {transiciones.includes('subsanacion') ? '(obligatoria si pasa a Subsanación)' : '(opcional)'}
                <input
                  className="flit-focus mt-1 w-full rounded-[10px] border bg-white px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--flit-border-input)' }}
                  placeholder="Ej.: Falta comprobante de pago de derechos"
                  value={nota}
                  disabled={saving}
                  onChange={(e) => setNota(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {transiciones.map((estado) => (
                  <button
                    key={estado}
                    type="button"
                    disabled={saving}
                    onClick={() => void cambiarEstado(estado)}
                    className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.15)' }}
                  >
                    {ESTADO_STT_LABEL[estado]}
                  </button>
                ))}
              </div>
              {transiciones.includes('subsanacion') && (
                <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
                  <strong>Subsanación</strong> reabre el wizard del gestor CEA para corregir el expediente; luego debe
                  reenviar a validación STT.
                </p>
              )}
            </section>
          )}

          {!operativo && tramite.estado === 'subsanacion' && (
            <p className="text-xs font-semibold" style={{ color: 'var(--flit-warning)' }}>
              En subsanación el gestor CEA edita el trámite. Cuando reenvíe a validación, podrá continuar aquí.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CardBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'white' }}>
      <p className="mb-3 text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        {title}
      </p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className={`text-sm font-medium ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--flit-text-primary)' }}>
        {value || '—'}
      </p>
    </div>
  );
}
