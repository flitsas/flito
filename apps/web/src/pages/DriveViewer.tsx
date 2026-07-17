import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useBackdropClose } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { IconClose } from '../components/flit/icons';
import {
  flitInp, FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr,
  flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink: string;
}

interface CuentaResultado {
  placa: string;
  propietario: string;
  cedula: string;
  vehiculo: string;
  tipoTramite?: string;
  valorTotal: number;
  downloadUrl: string;
  pdfFile?: string;
}

interface ProcesarResult {
  totalPaginas: number;
  cuentasDetectadas: number;
  placasUnicas: number;
  valorTotal: number;
  excelDownloadUrl: string;
  excelFile: string;
  zipFile?: string | null;
  zipDownloadUrl?: string | null;
  cuentas: CuentaResultado[];
}

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--flit-text-muted)' }}>
      {children}
    </p>
  );
}

function TramiteChip({ tipo }: { tipo: string }) {
  const t = tipo.toUpperCase();
  const isPrenda = t.includes('PRENDA');
  const isMi = t.includes('MATRICULA') || t.includes('MATRÍCULA');
  const c = isPrenda
    ? { fg: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.14)' }
    : isMi
      ? { fg: 'var(--flit-success)', bg: 'rgba(112,207,58,0.14)' }
      : { fg: 'var(--flit-text-muted)', bg: 'rgba(125,135,152,0.12)' };
  return (
    <span className="inline-flex items-center rounded-[999px] px-2 py-0.5 text-[10px] font-semibold" style={{ color: c.fg, background: c.bg }}>
      {tipo}
    </span>
  );
}

function FlitSpinner({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <div
      className={`inline-block animate-spin rounded-full border-4 motion-reduce:animate-none ${className}`}
      style={{ borderColor: 'var(--flit-border-soft)', borderTopColor: 'var(--flit-blue)' }}
    />
  );
}

export default function DriveViewer() {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [folders, setFolders] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentFolder, setCurrentFolder] = useState('');
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState('');
  const [previewFile, setPreviewFile] = useState<{ name: string; data: string; mimeType: string; pages?: string[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [processResult, setProcessResult] = useState<ProcesarResult | null>(null);
  const processingRef = useRef(false);

  const closePreview = () => {
    if (previewFile?.data?.startsWith('blob:')) URL.revokeObjectURL(previewFile.data);
    setPreviewFile(null);
    setPreviewLoading(false);
  };
  const previewBackdrop = useBackdropClose(closePreview);

  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  const load = async (folderId?: string) => {
    setLoading(true);
    try {
      const url = folderId ? `/api/drive?folder=${folderId}` : '/api/drive';
      const r = await fetch(url, { headers });
      const d = await r.json();
      if (d.ok) { setFiles(d.files || []); setFolders(d.folders || []); }
      else toast.error(d.error || 'Error cargando Drive');
    } catch { toast.error('Error de conexión'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openFolder = (folder: DriveFile) => {
    setFolderStack(prev => [...prev, { id: currentFolder, name: prev.length === 0 ? 'Raíz' : prev[prev.length - 1]?.name || '' }]);
    setCurrentFolder(folder.id);
    load(folder.id);
  };

  const goBack = () => {
    const prev = folderStack[folderStack.length - 1];
    setFolderStack(s => s.slice(0, -1));
    setCurrentFolder(prev?.id || '');
    load(prev?.id || undefined);
  };

  const doSearch = async () => {
    if (search.length < 2) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/drive/search?q=${encodeURIComponent(search)}&folder=${currentFolder}`, { headers });
      const d = await r.json();
      if (d.ok) { setFiles(d.files || []); setFolders([]); }
    } catch { toast.error('Error buscando'); }
    finally { setLoading(false); }
  };

  const preview = async (file: DriveFile) => {
    setPreviewLoading(true);
    setPreviewFile(null);
    try {
      const r = await fetch(`/api/drive/download/${file.id}`, { headers });
      const buf = await r.arrayBuffer();
      const mime = r.headers.get('content-type') || file.mimeType || '';

      if (mime.includes('pdf')) {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const vp = pg.getViewport({ scale: 2.0 });
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height;
          await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
          pages.push(c.toDataURL('image/png'));
        }
        setPreviewFile({ name: file.name, data: '', mimeType: mime, pages });
      } else if (mime.includes('image')) {
        const blob = new Blob([buf], { type: mime });
        setPreviewFile({ name: file.name, data: URL.createObjectURL(blob), mimeType: mime });
      } else {
        toast.error('Vista previa no disponible para este tipo');
      }
    } catch { toast.error('Error cargando archivo'); }
    finally { setPreviewLoading(false); }
  };

  const procesarCuentas = async (file: DriveFile) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessingId(file.id);
    setProcessResult(null);
    try {
      const r = await fetch('/api/drive/procesar-cuentas', {
        method: 'POST', headers, body: JSON.stringify({ fileId: file.id }),
      });
      const d = await r.json();
      if (d.ok) { setProcessResult(d as ProcesarResult); toast.success(`${d.cuentasDetectadas} cuentas procesadas`); }
      else toast.error(d.error || 'Error procesando');
    } catch { toast.error('Error de conexión'); }
    finally { processingRef.current = false; setProcessingId(null); }
  };

  const descargarConAuth = async (url: string, filename: string) => {
    if (!url) { toast.error('No se pudo descargar: enlace no disponible'); return; }
    try {
      // GET de descarga: no enviar Content-Type JSON (algunos proxies/CDN rechazan
      // GET con body-type) y mantener solo Authorization.
      const dlHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const r = await fetch(url, { headers: dlHeaders });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        let msg = `Error ${r.status}`;
        try { const j = JSON.parse(errBody); if (j.error) msg = j.error; } catch { /* keep */ }
        toast.error(`No se pudo descargar: ${msg}`);
        return;
      }
      const blob = await r.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.style.display = 'none';
      // Anclar al DOM antes del click (Firefox/Safari no disparan la descarga en
      // anchors desprendidos) y revocar el blob URL con retardo (revocarlo
      // sincrónicamente tras click() aborta la descarga → "no pasa nada").
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(objectUrl); a.remove(); }, 1500);
    } catch { toast.error('Error descargando'); }
  };

  const formatSize = (s: string) => {
    const n = parseInt(s);
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const fileIcon = (mime: string) => {
    if (mime?.includes('pdf')) return 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z';
    if (mime?.includes('image')) return 'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z';
    return 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z';
  };

  const breadcrumb = [...folderStack.map(f => f.name), currentFolder ? '…' : ''].filter(Boolean).join(' / ') || 'Carpeta raíz';

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Google Drive" subtitle="Documentos del trámite · lectura y procesamiento de cuentas de cobro (PDF)" />

      <FlitCard className="!py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {folderStack.length > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="flit-focus inline-flex shrink-0 items-center gap-1 rounded-[999px] px-3 py-2 text-xs font-semibold"
                style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-blue)' }}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
                Atrás
              </button>
            )}
            <span className="truncate text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>{breadcrumb}</span>
          </div>
          <div className="flex gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Buscar archivos..."
              className={`${flitInp} w-full min-w-[140px] sm:w-48`}
            />
            <GradientButton type="button" onClick={doSearch} className="!h-10 shrink-0 !px-4 !text-xs">Buscar</GradientButton>
            {search && (
              <button type="button" onClick={() => { setSearch(''); load(currentFolder || undefined); }} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Limpiar</button>
            )}
          </div>
        </div>
      </FlitCard>

      {loading && (
        <div className="py-16 text-center">
          <FlitSpinner className="h-10 w-10" />
          <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando Drive…</p>
        </div>
      )}

      {!loading && (
        <>
          {folders.length > 0 && (
            <section>
              <SectionLabel>Carpetas ({folders.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {folders.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => openFolder(f)}
                    className="flit-focus flex items-center gap-2.5 bg-white p-3 text-left transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
                    style={CARD}
                  >
                    <svg className="h-5 w-5 shrink-0" style={{ color: 'var(--flit-warning)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                    <span className="truncate text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{f.name}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {files.length > 0 ? (
            <section>
              <SectionLabel>Archivos ({files.length})</SectionLabel>
              <div className="space-y-2">
                {files.map(f => (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && preview(f)}
                    className="flex cursor-pointer items-center gap-3 bg-white p-3 transition-colors hover:bg-[color:var(--flit-bg-app)]"
                    style={CARD}
                    onClick={() => preview(f)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: 'var(--flit-bg-app)' }}>
                      <svg className="h-4 w-4" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={fileIcon(f.mimeType)} />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{f.name}</p>
                      <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{formatSize(f.size)} · {formatDate(f.modifiedTime)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); descargarConAuth(`/api/drive/download/${f.id}`, f.name); }}
                      className="flit-focus shrink-0 rounded-[999px] px-2.5 py-1.5 text-[11px] font-semibold"
                      style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-blue)' }}
                    >
                      Descargar
                    </button>
                    {f.mimeType?.includes('pdf') && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); procesarCuentas(f); }}
                        disabled={!!processingId}
                        className="flit-focus shrink-0 rounded-[999px] px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                        style={{ background: 'var(--flit-gradient-success)', boxShadow: 'var(--flit-shadow-button)' }}
                      >
                        {processingId === f.id ? 'Procesando…' : processingId ? 'Espere…' : 'Procesar'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : !folders.length && (
            <FlitEmpty>
              <svg className="mx-auto mb-3 h-10 w-10" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              Carpeta vacía o sin acceso
              <p className="mt-2 text-xs font-normal">Recargue la página. Si persiste, comparta la carpeta con la cuenta de servicio del servidor.</p>
            </FlitEmpty>
          )}
        </>
      )}

      {processingId && (
        <FlitCard className="py-10 text-center">
          <FlitSpinner className="mx-auto h-8 w-8" />
          <p className="mt-3 text-sm font-semibold" style={{ color: 'var(--flit-success)' }}>Procesando cuentas de cobro…</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Leyendo cada página del PDF. Puede tardar unos minutos.</p>
        </FlitCard>
      )}

      {processResult && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <div className="h-5 w-1.5 rounded-full" style={{ background: 'var(--flit-success)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Resultado del procesamiento</h2>
            <button type="button" onClick={() => setProcessResult(null)} className="ml-auto text-xs font-medium hover:underline" style={{ color: 'var(--flit-blue)' }}>Cerrar</button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { l: 'Páginas', v: processResult.totalPaginas },
              { l: 'Cuentas', v: processResult.cuentasDetectadas },
              { l: 'Placas', v: processResult.placasUnicas },
              { l: 'Valor total', v: '$' + (processResult.valorTotal || 0).toLocaleString('es-CO') },
            ].map(s => (
              <FlitCard key={s.l} className="!py-3 text-center">
                <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--flit-success)' }}>{s.v}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{s.l}</p>
              </FlitCard>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <GradientButton type="button" variant="success" onClick={() => descargarConAuth(processResult.excelDownloadUrl, processResult.excelFile)} className="!h-10 !text-xs">
              Descargar Excel resumen
            </GradientButton>
            {processResult.zipDownloadUrl && processResult.zipFile && (
              <GradientButton type="button" onClick={() => descargarConAuth(processResult.zipDownloadUrl!, processResult.zipFile!)} className="!h-10 !text-xs">
                Descargar todas las facturas (ZIP)
              </GradientButton>
            )}
          </div>

          <FlitTable>
            <table className="w-full text-xs">
              <thead><tr>
                <FlitTh>Placa</FlitTh>
                <FlitTh>Propietario</FlitTh>
                <th scope="col" className="hidden px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide sm:table-cell" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Cédula</th>
                <th scope="col" className="hidden px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide sm:table-cell" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Vehículo</th>
                <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Trámite</th>
                <th scope="col" className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Valor</th>
                <th scope="col" className="px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>PDF</th>
              </tr></thead>
              <tbody>
                {processResult.cuentas?.map((c, i) => (
                  <FlitTr key={i}>
                    <td className="px-3 py-2.5 font-mono font-semibold" style={{ color: 'var(--flit-blue)' }}>{c.placa}</td>
                    <td className="max-w-[150px] truncate px-3 py-2.5" style={{ color: 'var(--flit-text-primary)' }}>{c.propietario}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell" style={{ color: 'var(--flit-text-secondary)' }}>{c.cedula}</td>
                    <td className="hidden max-w-[120px] truncate px-3 py-2.5 sm:table-cell" style={{ color: 'var(--flit-text-secondary)' }}>{c.vehiculo}</td>
                    <td className="px-3 py-2.5">{c.tipoTramite ? <TramiteChip tipo={c.tipoTramite} /> : <span style={{ color: 'var(--flit-text-muted)' }}>—</span>}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>${(c.valorTotal || 0).toLocaleString('es-CO')}</td>
                    <td className="px-3 py-2.5 text-center">
                      <button type="button" onClick={() => descargarConAuth(c.downloadUrl, c.pdfFile || `${c.placa}.pdf`)} className="text-[11px] font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>Descargar</button>
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </table>
          </FlitTable>
        </section>
      )}

      {(previewFile || previewLoading) && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4"
          style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }}
          {...previewBackdrop}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden bg-white"
            style={{ borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)', border: '1px solid var(--flit-border-soft)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <p className="truncate text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{previewFile?.name || 'Cargando…'}</p>
              <button type="button" onClick={closePreview} aria-label="Cerrar" className="flit-focus grid h-9 w-9 place-items-center rounded-lg hover:bg-[color:var(--flit-bg-app)]" style={{ color: 'var(--flit-text-muted)' }}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-auto" style={{ maxHeight: 'calc(90vh - 60px)', background: 'var(--flit-bg-app)' }}>
              {previewLoading && (
                <div className="py-20 text-center">
                  <FlitSpinner className="h-10 w-10" />
                </div>
              )}
              {previewFile && previewFile.mimeType?.includes('image') && (
                <img src={previewFile.data} alt={previewFile.name} className="h-auto w-full" />
              )}
              {previewFile?.pages && previewFile.pages.length > 0 && (
                <div className="flex flex-col items-center gap-3 p-4">
                  {previewFile.pages.map((pg, i) => (
                    <div key={i} className="w-full overflow-hidden bg-white" style={CARD}>
                      <img src={pg} alt={`Página ${i + 1}`} className="block h-auto w-full" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
