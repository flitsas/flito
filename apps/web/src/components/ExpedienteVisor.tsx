import { useState, useEffect, useCallback } from 'react';
import { resolverValidacionVigentePorDocumento, validacionesVigentesPorDocumento } from '@operaciones/shared-types';

interface CedulaCropperProps {
  fotoCedulaFrontal: string | null;
  fotoCedulaReverso: string | null;
  nombre: string;
  tipoDoc: string;
  documento: string;
}

function CedulaCropper({ fotoCedulaFrontal, fotoCedulaReverso, nombre, tipoDoc, documento }: CedulaCropperProps) {
  const [croppedFront, setCroppedFront] = useState<string | null>(null);
  const [croppedBack, setCroppedBack] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cropImage = useCallback(async (b64: string): Promise<string> => {
    const token = localStorage.getItem('token');
    try {
      const r = await fetch('/api/validacion-identidad/recortar-cedula', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ imagen: b64 }) });
      const data = await r.json();
      if (!data.ok || !data.crop) return b64;
      const { x, y, w, h } = data.crop;
      return await new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const sx = (x / 100) * img.width, sy = (y / 100) * img.height, sw = (w / 100) * img.width, sh = (h / 100) * img.height;
          const c = document.createElement('canvas'); c.width = sw; c.height = sh;
          c.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          resolve(c.toDataURL('image/jpeg', 0.92));
        };
        img.onerror = () => resolve(b64); img.src = b64;
      });
    } catch { return b64; }
  }, []);
  useEffect(() => {
    setCroppedFront(null); setCroppedBack(null);
    if (!fotoCedulaFrontal && !fotoCedulaReverso) return;
    setLoading(true);
    Promise.all([fotoCedulaFrontal ? cropImage(fotoCedulaFrontal) : Promise.resolve(null), fotoCedulaReverso ? cropImage(fotoCedulaReverso) : Promise.resolve(null)])
      .then(([f, b]) => { setCroppedFront(f); setCroppedBack(b); }).finally(() => setLoading(false));
  }, [fotoCedulaFrontal, fotoCedulaReverso, cropImage]);
  return (
    <div>
      <div className="mb-3 p-2.5 flit-tone-active-bg rounded-xl border border-[color:var(--flit-blue)]/30">
        <p className="text-xs font-semibold text-[color:var(--flit-blue)]">{nombre || '—'}</p>
        <p className="text-[10px] text-[color:var(--flit-blue)] opacity-80">{tipoDoc} {documento}</p>
      </div>
      {loading ? <div className="text-center py-6"><div className="inline-block w-7 h-7 border-4 border-[color:var(--flit-border-soft)] border-t-[color:var(--flit-blue)] rounded-full animate-spin motion-reduce:animate-none" /><p className="text-[10px] flit-tone-muted mt-2">Recortando...</p></div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[{ l: 'DOC. IDENTIDAD — FRENTE', src: croppedFront }, { l: 'DOC. IDENTIDAD — REVERSO', src: croppedBack }].map((f) => (
            <div key={f.l} className="text-center">
              <div className="bg-[color:var(--flit-bg-app)] rounded-xl overflow-hidden border border-[color:var(--flit-border-soft)]">
                {f.src ? <img src={f.src} alt={f.l} className="w-full h-auto object-contain" /> : <div className="flex items-center justify-center h-28 text-xs flit-tone-muted">Sin foto</div>}
              </div>
              <p className="text-[9px] font-semibold flit-tone-muted mt-1 tracking-wide">{f.l}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface IdDocDetail {
  resultado_general?: { motivo?: string };
  comparacion_facial?: { score?: number };
  liveness?: { es_persona_real?: boolean };
}
interface IdDoc {
  id: number;
  estado: string;
  nombre?: string;
  score?: number | null;
  fotoRostro?: string | null;
  fotoCedulaFrontal?: string | null;
  fotoCedulaReverso?: string | null;
  detalle?: IdDocDetail;
  validadoAt?: string;
  ipAddress?: string;
  ciudadGeo?: string;
  tipoDoc?: string;
  documento?: string;
}

// Resolución de "validación vigente" por documento: fuente única en shared-types
// (resolverValidacionVigentePorDocumento / validacionesVigentesPorDocumento), con
// tests. Antes el visor tomaba idDocs[length-1] (la más reciente, a veces un
// reenvío 'enviado' SIN fotos). Ahora se elige por documento + ranking de estado.

interface VehiculoData {
  placa?: string; noPlaca?: string;
  marca?: string; linea?: string; modelo?: string; color?: string;
  claseVehiculo?: string; clase?: string;
  tipoServicio?: string; cilindraje?: string;
  tipoCombustible?: string; combustible?: string;
  tipoCarroceria?: string; carroceria?: string;
  capacidad?: string; ejes?: string;
  numMotor?: string; numChasis?: string; numSerie?: string;
}
interface CompradorData {
  nombre?: string; tipoDoc?: string; documento?: string;
  email?: string; telefono?: string; direccion?: string; ciudad?: string;
}
interface ArchivoData {
  id: number;
  tipo: string;
  originalName?: string;
  mimetype?: string;
}
interface ValidationStatusData {
  estado?: string;
  score?: number;
}

interface Props {
  tramiteId: number;
  vehiculo: VehiculoData;
  comprador: CompradorData;
  vin: string;
  archivos: ArchivoData[];
  validationStatus: ValidationStatusData | null;
  emailSent: boolean;
  orgTransito?: { nombre: string; ciudad: string; codigo: string };
  /** TRAM-TRASPASO-F5: ajusta título y prefijo de radicado del visor (MI- vs TD-). */
  variant?: 'matricula' | 'traspaso';
}

type MainTab = 'vehiculo' | 'comprador' | 'documentos';
type DocTab = 'fur' | 'docs' | 'cedula' | 'identidad' | 'certificacion';

export default function ExpedienteVisor({ tramiteId, vehiculo, comprador, vin, archivos, validationStatus, emailSent, orgTransito, variant = 'matricula' }: Props) {
  const esTraspaso = variant === 'traspaso';
  const tituloTramite = esTraspaso ? 'Traspaso de propiedad' : 'Matrícula inicial';
  const radicadoVisor = `${esTraspaso ? 'TD' : 'MI'}-${String(tramiteId).padStart(4, '0')}`;
  const [mainTab, setMainTab] = useState<MainTab>('vehiculo');
  const [docTab, setDocTab] = useState<DocTab>('fur');
  const [furPages, setFurPages] = useState<string[]>([]);
  const [furBlobUrl, setFurBlobUrl] = useState<string | null>(null);
  const [furLoading, setFurLoading] = useState(false);
  const [furError, setFurError] = useState('');
  const [certPages, setCertPages] = useState<string[]>([]);
  const [certBlobUrl, setCertBlobUrl] = useState<string | null>(null);
  const [certLoading, setCertLoading] = useState(false);
  const [certError, setCertError] = useState('');
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);
  const [docPages, setDocPages] = useState<string[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const [idDocs, setIdDocs] = useState<IdDoc[] | null>(null);
  const [idDocsLoading, setIdDocsLoading] = useState(false);

  useEffect(() => () => { if (furBlobUrl) URL.revokeObjectURL(furBlobUrl); }, [furBlobUrl]);
  useEffect(() => () => { if (certBlobUrl) URL.revokeObjectURL(certBlobUrl); }, [certBlobUrl]);

  const loadIdDocs = async () => {
    setIdDocsLoading(true);
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`/api/validacion-identidad/documentos/${tramiteId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const d = await r.json();
      if (d.ok) setIdDocs(d.documentos || []);
    } catch { /* silent */ }
    finally { setIdDocsLoading(false); }
  };

  useEffect(() => {
    if (!selectedDoc) { setDocPages([]); return; }
    const doc = archivos.find((a) => a.id === selectedDoc); if (!doc) return;
    const isPdf = doc.mimetype === 'application/pdf' || doc.originalName?.endsWith('.pdf');
    const isImage = doc.mimetype?.startsWith('image/');
    const token = localStorage.getItem('token');
    const url = `/api/tramites/${tramiteId}/documentos/${doc.id}/archivo`;
    setDocLoading(true); setDocPages([]);
    if (isPdf) {
      fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(r => r.arrayBuffer()).then(async (buf) => {
        const pdfjsLib = await import('pdfjs-dist'); pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise; const pngs: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i); const vp = pg.getViewport({ scale: 2.0 });
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
          await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
          pngs.push(c.toDataURL('image/png'));
        }
        setDocPages(pngs);
      }).catch(() => setDocPages([])).finally(() => setDocLoading(false));
    } else if (isImage) { setDocPages([url]); setDocLoading(false); } else { setDocLoading(false); }
  }, [selectedDoc, tramiteId, archivos]);

  const v = vehiculo || {};
  const placa = v.placa || v.noPlaca || '';

  const renderPdf = async (url: string, bodyData: Record<string, unknown>) => {
    const token = localStorage.getItem('token');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(bodyData) });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const buf = await res.arrayBuffer(); const blob = new Blob([buf], { type: 'application/pdf' });
    const pdfjsLib = await import('pdfjs-dist'); pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; const pngs: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i); const vp = pg.getViewport({ scale: 2.0 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
      pngs.push(c.toDataURL('image/png'));
    }
    return { pages: pngs, blobUrl: URL.createObjectURL(blob) };
  };

  const cargarFur = async () => {
    if (furLoading) return; setFurLoading(true); setFurError(''); setFurPages([]);
    try {
      const r = await renderPdf(`/api/tramites/${tramiteId}/generar-fur`, { orgNombre: orgTransito?.nombre || '', orgCiudad: orgTransito?.ciudad || '', orgCodigo: orgTransito?.codigo || '' });
      setFurBlobUrl(r.blobUrl); setFurPages(r.pages);
    } catch (e) { setFurError(e instanceof Error ? e.message : 'Error'); }
    finally { setFurLoading(false); }
  };
  const cargarCert = async () => {
    if (certLoading) return; setCertLoading(true); setCertError(''); setCertPages([]);
    try {
      const r = await renderPdf(`/api/validacion-identidad/certificado/${tramiteId}`, { placa: placa || vin, vehiculo: `${v.marca || ''} ${v.linea || ''} ${v.modelo || ''}`.trim(), orgNombre: orgTransito?.nombre || '' });
      setCertBlobUrl(r.blobUrl); setCertPages(r.pages);
    } catch (e) { setCertError(e instanceof Error ? e.message : 'Error'); }
    finally { setCertLoading(false); }
  };
  const download = (url: string, name: string) => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };

  const valId = validationStatus;
  const fecha = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const mainTabs: { key: MainTab; label: string; d: string }[] = [
    { key: 'vehiculo', label: 'Vehículo', d: 'M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.125-.504 1.125-1.125v-2.688M2.25 14.25l3.366-5.481A1.398 1.398 0 017 8.25h2.25M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
    { key: 'comprador', label: 'Comprador', d: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z' },
    { key: 'documentos', label: 'Documentos', d: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z' },
  ];
  const docTabs: { key: DocTab; label: string }[] = [
    { key: 'fur', label: 'FUR' }, { key: 'docs', label: 'Documentos' }, { key: 'cedula', label: 'Doc. identidad' }, { key: 'identidad', label: 'Validación' }, { key: 'certificacion', label: 'Certificación' },
  ];

  const D = ({ label, value }: { label: string; value: string | undefined }) => (
    <div>
      <p className="text-[9px] sm:text-[10px] font-semibold flit-tone-muted uppercase tracking-[0.3em]">{label}</p>
      <p className="text-xs sm:text-sm font-medium flit-tone-primary break-words">{value || '—'}</p>
    </div>
  );

  const PdfToolbar = ({ loading: ld, pages, blobUrl, onLoad, onDownload, label }: { loading: boolean; pages: string[]; blobUrl: string | null; onLoad: () => void; onDownload: () => void; label: string }) => (
    <div className="px-3 py-2 bg-text-primary flex flex-wrap items-center gap-2">
      <button onClick={onLoad} disabled={ld} className={`inline-flex items-center h-9 px-3 rounded-xl text-[11px] font-medium text-[color:var(--flit-blue)]-foreground ${ld ? 'bg-[color:var(--flit-text-muted)]' : 'bg-[color:var(--flit-blue)] hover:bg-[color:var(--flit-blue)]-hover'} transition-colors`}>
        {ld ? 'Generando...' : pages.length > 0 ? 'Regenerar' : label}
      </button>
      {blobUrl && <>
        <button onClick={onDownload} className="inline-flex items-center h-9 px-3 rounded-xl text-[11px] font-medium text-white bg-[color:var(--flit-text-secondary)] hover:opacity-90 transition-opacity">Descargar</button>
        <button onClick={() => window.open(blobUrl, '_blank')} className="inline-flex items-center h-9 px-3 rounded-xl text-[11px] font-medium text-white bg-[color:var(--flit-text-secondary)] hover:opacity-90 transition-opacity">Abrir</button>
      </>}
      <span className="text-[10px] flit-tone-muted ml-auto">{ld ? 'generando...' : pages.length > 0 ? `${pages.length} pág.` : ''}</span>
    </div>
  );

  const PdfPages = ({ pages, loading: ld, error: err, msg }: { pages: string[]; loading: boolean; error?: string; msg: string }) => (
    <div className="p-2 sm:p-3 bg-[color:var(--flit-bg-app)]">
      {err && <div className="px-3 py-2 bg-danger text-[color:var(--flit-danger)]-foreground text-[10px] font-mono mb-2 rounded-xl">{err}</div>}
      {pages.length > 0 ? <div className="flex flex-col items-center gap-3">{pages.map((p, i) => <div key={i} className="bg-white rounded-xl shadow-[var(--flit-shadow-card)] overflow-hidden w-full"><img src={p} alt={`P${i + 1}`} className="block w-full h-auto" /></div>)}</div>
        : ld ? <div className="text-center py-8"><div className="inline-block w-8 h-8 border-4 border-[color:var(--flit-border-soft)] border-t-[color:var(--flit-blue)] rounded-full animate-spin motion-reduce:animate-none" /></div>
          : <div className="text-center py-8 flit-tone-muted text-xs">{msg}</div>}
    </div>
  );

  return (
    <div>
      <div className="rounded-t-xl sm:rounded-t-2xl px-3 py-3 sm:px-5 sm:py-4 bg-text-primary">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[8px] sm:text-[10px] font-semibold text-[color:var(--flit-blue)] uppercase tracking-[0.4em]">Expediente digital · Res. 17145/2023</p>
            <h2 className="text-sm sm:text-base font-semibold text-white leading-tight">{tituloTramite}</h2>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <span className="px-2 py-1 rounded-full bg-white/10 text-[9px] sm:text-[10px] font-medium text-white/90">{radicadoVisor}</span>
          <span className="px-2 py-1 rounded-full bg-white/10 text-[9px] sm:text-[10px] font-medium text-white/90 font-mono">{placa || 'SIN PLACA'}</span>
          <span className="px-2 py-1 rounded-full bg-white/10 text-[9px] sm:text-[10px] font-medium text-white/90">{fecha}</span>
          <span className="px-2 py-1 rounded-full bg-[color:var(--flit-success)]/20 text-[9px] sm:text-[10px] font-semibold text-[color:var(--flit-success)] flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[color:var(--flit-success)]" />EN PROCESO</span>
        </div>
      </div>

      <div className="flex bg-white border-b border-[color:var(--flit-border-soft)]">
        {mainTabs.map((t) => (
          <button key={t.key} onClick={() => setMainTab(t.key)}
            className={`flex-1 sm:flex-none flex items-center justify-center sm:justify-start gap-1.5 px-3 sm:px-5 py-3 text-[11px] sm:text-sm font-semibold border-b-2 transition-all ${mainTab === t.key ? 'border-[color:var(--flit-blue)] text-[color:var(--flit-blue)]' : 'border-transparent flit-tone-muted hover:flit-tone-secondary'}`}>
            <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d={t.d} /></svg>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {mainTab === 'vehiculo' && (
        <div className="bg-white rounded-b-xl sm:rounded-b-2xl border border-t-0 border-[color:var(--flit-border-soft)] p-3 sm:p-5">
          <div className="rounded-xl p-3 sm:p-4 mb-4 bg-warning">
            <div className="flex items-center gap-3 sm:gap-5">
              <div className="bg-white rounded-xl px-3 py-2 sm:px-5 sm:py-3 shadow-[var(--flit-shadow-card)] border-2 border-[color:var(--flit-text-primary)] flex-shrink-0">
                <p className="text-[6px] sm:text-[8px] font-semibold text-center flit-tone-secondary tracking-[0.3em]">REPÚBLICA DE COLOMBIA</p>
                <p className="text-xl sm:text-3xl font-semibold flit-tone-primary tracking-[0.15em] sm:tracking-[0.2em] text-center font-mono">{placa || 'NUEVA'}</p>
              </div>
              <div className="text-[color:var(--flit-warning)]-foreground min-w-0">
                <p className="text-[8px] sm:text-[10px] font-semibold uppercase tracking-[0.3em] opacity-80">{v.marca || '—'}</p>
                <p className="text-base sm:text-xl font-semibold truncate">{v.linea || '—'}</p>
                <p className="text-[10px] sm:text-sm font-medium opacity-90">Modelo {v.modelo || '—'} · {v.color || '—'}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-2"><div className="w-1 h-4 rounded-full bg-[color:var(--flit-blue)]" /><h4 className="text-xs sm:text-sm font-semibold flit-tone-primary uppercase tracking-[0.2em]">Especificaciones técnicas</h4></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)] mb-4">
            <D label="Clase" value={v.claseVehiculo || v.clase} />
            <D label="Servicio" value={v.tipoServicio || 'Particular'} />
            <D label="Cilindraje" value={v.cilindraje ? `${v.cilindraje} cc` : ''} />
            <D label="Combustible" value={v.tipoCombustible || v.combustible} />
            <D label="Carrocería" value={v.tipoCarroceria || v.carroceria} />
            <D label="Capacidad" value={v.capacidad} />
            <D label="Ejes" value={v.ejes} />
            <D label="Estado" value="ACTIVO" />
          </div>

          <div className="flex items-center gap-2 mb-2"><div className="w-1 h-4 rounded-full bg-[color:var(--flit-blue)]" /><h4 className="text-xs sm:text-sm font-semibold flit-tone-primary uppercase tracking-[0.2em]">Identificación interna</h4></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)]">
            <D label="VIN" value={vin} />
            <D label="N. Motor" value={v.numMotor} />
            <D label="N. Chasis" value={v.numChasis} />
            <D label="N. Serie" value={v.numSerie} />
          </div>
        </div>
      )}

      {mainTab === 'comprador' && (
        <div className="bg-white rounded-b-xl sm:rounded-b-2xl border border-t-0 border-[color:var(--flit-border-soft)] p-3 sm:p-5">
          <div className="flex items-center gap-2 mb-2"><div className="w-1 h-4 rounded-full bg-[color:var(--flit-blue)]" /><h4 className="text-xs sm:text-sm font-semibold flit-tone-primary uppercase tracking-[0.2em]">Datos del comprador</h4></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)] mb-4">
            <D label="Nombre" value={comprador?.nombre} />
            <D label="Tipo doc" value={comprador?.tipoDoc || 'CC'} />
            <D label="Número" value={comprador?.documento} />
            <D label="Email" value={comprador?.email} />
            <D label="Teléfono" value={comprador?.telefono} />
            <D label="Dirección" value={comprador?.direccion} />
            <D label="Ciudad" value={comprador?.ciudad} />
          </div>

          <div className="flex items-center gap-2 mb-2"><div className="w-1 h-4 rounded-full bg-[color:var(--flit-blue)]" /><h4 className="text-xs sm:text-sm font-semibold flit-tone-primary uppercase tracking-[0.2em]">Validación de identidad</h4></div>
          <div className="p-3 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)] mb-4">
            <div className="flex items-center gap-3">
              {valId?.estado === 'aprobado' ? (<><div className="w-8 h-8 rounded-full flit-success-bg flex items-center justify-center flex-shrink-0"><svg className="w-4 h-4 text-[color:var(--flit-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div><div><p className="text-xs font-semibold text-[color:var(--flit-success)]">Validada</p><p className="text-[10px] flit-tone-muted">Score: {valId.score}/100</p></div></>)
                : valId?.estado === 'rechazado' ? (<><div className="w-8 h-8 rounded-full flit-danger-bg flex items-center justify-center flex-shrink-0"><svg className="w-4 h-4 text-[color:var(--flit-danger)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h-14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" /></svg></div><div><p className="text-xs font-semibold text-[color:var(--flit-danger)]">Rechazada</p></div></>)
                  : emailSent ? (<><div className="w-8 h-8 rounded-full flit-warning-bg flex items-center justify-center flex-shrink-0"><svg className="w-4 h-4 text-[color:var(--flit-warning)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div><div><p className="text-xs font-semibold text-[color:var(--flit-warning)]">Pendiente</p><p className="text-[10px] flit-tone-muted">Enlace enviado</p></div></>)
                    : (<><div className="w-8 h-8 rounded-full bg-[color:var(--flit-bg-app)] flex items-center justify-center flex-shrink-0"><svg className="w-4 h-4 flit-tone-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div><div><p className="text-xs font-semibold flit-tone-muted">Sin validación</p></div></>)}
            </div>
          </div>

          {orgTransito?.nombre && (<>
            <div className="flex items-center gap-2 mb-2"><div className="w-1 h-4 rounded-full bg-[color:var(--flit-blue)]" /><h4 className="text-xs sm:text-sm font-semibold flit-tone-primary uppercase tracking-[0.2em]">Organismo de tránsito</h4></div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)]">
              <D label="Nombre" value={orgTransito.nombre} />
              <D label="Ciudad" value={orgTransito.ciudad} />
              <D label="Código" value={orgTransito.codigo} />
            </div>
          </>)}
        </div>
      )}

      {mainTab === 'documentos' && (
        <div className="bg-white rounded-b-xl sm:rounded-b-2xl border border-t-0 border-[color:var(--flit-border-soft)]">
          <div className="flex overflow-x-auto border-b border-[color:var(--flit-border-soft)] px-1 -mb-px">
            {docTabs.map((t) => (
              <button key={t.key} onClick={() => setDocTab(t.key)}
                className={`px-3 py-2.5 text-[10px] sm:text-xs font-semibold border-b-2 whitespace-nowrap transition-all ${docTab === t.key ? 'border-[color:var(--flit-blue)] text-[color:var(--flit-blue)]' : 'border-transparent flit-tone-muted hover:flit-tone-secondary'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {docTab === 'fur' && (
            <div className="bg-text-primary rounded-b-xl sm:rounded-b-2xl overflow-hidden">
              <PdfToolbar loading={furLoading} pages={furPages} blobUrl={furBlobUrl} onLoad={cargarFur} onDownload={() => download(furBlobUrl!, `FUR_${placa || 'vehiculo'}.pdf`)} label="Cargar FUR" />
              <PdfPages pages={furPages} loading={furLoading} error={furError} msg="Haz clic en Cargar FUR" />
            </div>
          )}

          {docTab === 'docs' && (
            <div className="p-3 sm:p-4">
              {archivos.length > 0 ? (<div>
                <div className="flex gap-1 flex-wrap mb-3">
                  {archivos.map((a) => (
                    <button key={a.id} onClick={() => setSelectedDoc(selectedDoc === a.id ? null : a.id)}
                      className={`px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-semibold capitalize transition-colors ${selectedDoc === a.id ? 'flit-tone-active-bg text-[color:var(--flit-blue)] ring-1 ring-accent/30' : 'bg-[color:var(--flit-bg-app)] flit-tone-secondary hover:bg-divider'}`}>
                      {a.tipo}
                    </button>
                  ))}
                </div>
                {selectedDoc && (() => {
                  const doc = archivos.find((a) => a.id === selectedDoc); if (!doc) return null;
                  const isPdf = doc.mimetype === 'application/pdf' || doc.originalName?.endsWith('.pdf');
                  return (<div className="rounded-xl border border-[color:var(--flit-border-soft)] overflow-hidden">
                    <div className="px-3 py-2.5 bg-[color:var(--flit-bg-app)] border-b border-[color:var(--flit-border-soft)]"><p className="text-xs font-semibold flit-tone-primary capitalize">{doc.tipo}</p><p className="text-[10px] flit-tone-muted">{doc.originalName}</p></div>
                    <div className={isPdf ? 'bg-[color:var(--flit-bg-app)]' : 'bg-[color:var(--flit-bg-app)]'}>
                      {docLoading ? <div className="text-center py-8"><div className="inline-block w-7 h-7 border-4 border-[color:var(--flit-border-soft)] border-t-[color:var(--flit-blue)] rounded-full animate-spin motion-reduce:animate-none" /></div>
                        : docPages.length > 0 ? <div className="p-2 sm:p-3 flex flex-col items-center gap-2">{docPages.map((s, i) => <div key={i} className="bg-white rounded-xl shadow-[var(--flit-shadow-card)] overflow-hidden w-full"><img src={s} alt="" className="block w-full h-auto" /></div>)}</div>
                          : <div className="text-center py-6 text-xs flit-tone-muted">Sin vista previa</div>}
                    </div>
                  </div>);
                })()}
                {!selectedDoc && (<div className="space-y-1.5">{archivos.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 p-2 bg-[color:var(--flit-bg-app)] rounded-xl border border-[color:var(--flit-border-soft)] cursor-pointer hover:bg-divider transition-colors" onClick={() => setSelectedDoc(a.id)}>
                    <div className="w-7 h-7 rounded-xl flit-success-bg flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-[color:var(--flit-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg></div>
                    <div className="flex-1 min-w-0"><p className="text-xs sm:text-sm font-semibold flit-tone-primary capitalize truncate">{a.tipo}</p><p className="text-[10px] flit-tone-muted truncate">{a.originalName}</p></div>
                    <svg className="w-3.5 h-3.5 flit-tone-muted flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                  </div>
                ))}</div>)}
              </div>) : (<p className="text-xs flit-tone-muted text-center py-6">No se han cargado documentos</p>)}
            </div>
          )}

          {docTab === 'cedula' && (
            <div className="p-3 sm:p-4">
              {!idDocs && !idDocsLoading ? <div className="text-center py-5"><button onClick={loadIdDocs} className="inline-flex items-center h-10 px-4 rounded-xl text-xs font-medium text-[color:var(--flit-blue)]-foreground bg-[color:var(--flit-blue)] hover:bg-[color:var(--flit-blue)]-hover transition-colors">Cargar documento de identidad</button></div>
                : idDocsLoading ? <div className="text-center py-6"><div className="inline-block w-7 h-7 border-4 border-[color:var(--flit-border-soft)] border-t-[color:var(--flit-blue)] rounded-full animate-spin motion-reduce:animate-none" /></div>
                  : idDocs && idDocs.length === 0 ? <p className="text-xs flit-tone-muted text-center py-5">{emailSent ? 'Pendiente' : 'Sin validación'}</p>
                    : idDocs && idDocs.length > 0 ? (() => {
                      const last = resolverValidacionVigentePorDocumento(idDocs, comprador?.documento);
                      if (!last) return <p className="text-xs flit-tone-muted text-center py-5">Sin validación del comprador actual</p>;
                      return <CedulaCropper fotoCedulaFrontal={last.fotoCedulaFrontal ?? null} fotoCedulaReverso={last.fotoCedulaReverso ?? null} nombre={last.nombre ?? ''} tipoDoc={last.tipoDoc ?? ''} documento={last.documento ?? ''} />;
                    })() : null}
            </div>
          )}

          {docTab === 'identidad' && (
            <div className="p-3 sm:p-4">
              {!idDocs && !idDocsLoading ? <div className="text-center py-5"><button onClick={loadIdDocs} className="inline-flex items-center h-10 px-4 rounded-xl text-xs font-medium text-[color:var(--flit-warning)]-foreground bg-warning hover:opacity-90 transition-opacity">Cargar validación</button></div>
                : idDocsLoading ? <div className="text-center py-6"><div className="inline-block w-7 h-7 border-4 border-[color:var(--flit-border-soft)] border-t-warning rounded-full animate-spin motion-reduce:animate-none" /></div>
                  : idDocs && idDocs.length === 0 ? <p className="text-xs flit-tone-muted text-center py-5">{emailSent ? 'Pendiente' : 'Sin validación'}</p>
                    : idDocs && idDocs.length > 0 ? (() => {
                      const vigentes = validacionesVigentesPorDocumento(idDocs, { documento: comprador?.documento, soloDocumento: !esTraspaso });
                      if (vigentes.length === 0) return <p className="text-xs flit-tone-muted text-center py-5">Sin validación del comprador actual</p>;
                      return vigentes.map((d) => {
                      const ok = d.estado === 'aprobado'; const det = d.detalle || {};
                      return (
                        <div key={d.id} className={`rounded-xl border overflow-hidden mb-3 ${ok ? 'border-[color:var(--flit-success)]/30' : 'border-[color:var(--flit-danger)]/30'}`}>
                          <div className={`px-3 py-2.5 ${ok ? 'bg-[color:var(--flit-success)]' : 'bg-danger'}`}>
                            <div className="flex items-center justify-between">
                              <div><p className="text-[9px] font-semibold uppercase opacity-80 text-[color:var(--flit-success)]-foreground">COMPRADOR</p><p className="text-xs font-semibold text-[color:var(--flit-success)]-foreground">{d.nombre || '—'}</p></div>
                              <div className="text-right"><span className="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-white/20 text-[color:var(--flit-success)]-foreground">{ok ? 'APROBADO' : 'RECHAZADO'}</span>{d.score != null && <p className="text-sm font-semibold mt-0.5 text-[color:var(--flit-success)]-foreground">{d.score}/100</p>}</div>
                            </div>
                          </div>
                          <div className="p-3">
                            <div className="grid grid-cols-3 gap-2 mb-3">
                              {[{ l: 'SELFIE', src: d.fotoRostro }, { l: 'FRENTE', src: d.fotoCedulaFrontal }, { l: 'REVERSO', src: d.fotoCedulaReverso }].map((f) => (
                                <div key={f.l} className="text-center"><div className="aspect-[3/4] bg-[color:var(--flit-bg-app)] rounded-xl overflow-hidden border border-[color:var(--flit-border-soft)]">{f.src ? <img src={f.src} alt={f.l} className="w-full h-full object-cover" /> : <div className="flex items-center justify-center h-full text-[8px] flit-tone-muted">Sin foto</div>}</div><p className="text-[8px] font-semibold flit-tone-muted mt-0.5">{f.l}</p></div>
                              ))}
                            </div>
                            {det.resultado_general && (
                              <div className="bg-[color:var(--flit-bg-app)] rounded-xl p-2 text-[10px] space-y-0.5 mb-2">
                                <p className="font-semibold flit-tone-primary text-[9px] uppercase">Resultado forense</p>
                                {det.comparacion_facial && <div><span className="flit-tone-muted">Facial: </span><span className={`font-semibold ${(det.comparacion_facial.score || 0) >= 60 ? 'text-[color:var(--flit-success)]' : 'text-[color:var(--flit-danger)]'}`}>{det.comparacion_facial.score}/100</span></div>}
                                {det.liveness && <div><span className="flit-tone-muted">Persona real: </span><span className={`font-semibold ${det.liveness.es_persona_real ? 'text-[color:var(--flit-success)]' : 'text-[color:var(--flit-danger)]'}`}>{det.liveness.es_persona_real ? 'Sí' : 'No'}</span></div>}
                                <div><span className="flit-tone-muted">Motivo: </span><span className="font-medium flit-tone-primary">{det.resultado_general.motivo}</span></div>
                              </div>
                            )}
                            <div className="bg-[color:var(--flit-bg-app)] rounded-xl p-2 text-[9px] flit-tone-muted space-y-0.5">
                              {d.validadoAt && <div><strong className="flit-tone-secondary">Validado:</strong> {new Date(d.validadoAt).toLocaleString('es-CO')}</div>}
                              {d.ipAddress && <div><strong className="flit-tone-secondary">IP:</strong> {d.ipAddress}</div>}
                              {d.ciudadGeo && <div><strong className="flit-tone-secondary">Ubicación:</strong> {d.ciudadGeo}</div>}
                            </div>
                          </div>
                        </div>
                      );
                    });
                    })() : null}
            </div>
          )}

          {docTab === 'certificacion' && (
            <div className="bg-text-primary rounded-b-xl sm:rounded-b-2xl overflow-hidden">
              <PdfToolbar loading={certLoading} pages={certPages} blobUrl={certBlobUrl} onLoad={cargarCert} onDownload={() => download(certBlobUrl!, `Cert_${placa || 'vehiculo'}.pdf`)} label="Generar" />
              <PdfPages pages={certPages} loading={certLoading} error={certError} msg="Haz clic en Generar" />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-1 px-1"><p className="text-[9px] flit-tone-muted">Expediente digital · FLIT Operaciones</p></div>
    </div>
  );
}
