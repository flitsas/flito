import { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useBackdropClose } from '../lib/hooks';
import { PDF_WORKER_SRC } from '../lib/pdfWorker';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { flitInp, FlitCard } from '../components/flit/flitPageKit';
import ModalPortal from '../components/flit/ModalPortal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import KpiCard from '../components/flit/KpiCard';
import { Cargador, Vacio } from '../components/flit/Cargador';
import { Icono, type NombreIcono } from '../components/flit/kit/Icono';
import { etiquetaKit, ETIQUETA_PUNTO_CLS, type TonoKit } from '../components/flit/kit/tonos';

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

const TARJETA = 'rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)]';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--color-text-tertiary)]">
      {children}
    </p>
  );
}

function TramiteChip({ tipo }: { tipo: string }) {
  const t = tipo.toUpperCase();
  const isPrenda = t.includes('PRENDA');
  const isMi = t.includes('MATRICULA') || t.includes('MATRÍCULA');
  const tono: TonoKit = isPrenda ? 'warn' : isMi ? 'ok' : 'neutro';
  return (
    <span {...etiquetaKit(tono)}>
      <span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />
      {tipo}
    </span>
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
        // El worker lo emite el bundler desde `node_modules` (HU #11775): misma versión que la API
        // por construcción y con hash de contenido. Ver `src/lib/pdfWorker.ts`.
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        // pdfjs-dist v6 corrige CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8) EN LA LIBRERÍA: ya no
        // compila los glifos con `new Function(...)`. La opción `isEvalSupported` que había aquí como
        // workaround del advisory ya no existe en v6 (0 coincidencias en `build/pdf.mjs`, y no está en
        // `DocumentInitParameters`), así que pasarla sería seguridad aparente. No la vuelvas a añadir.
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const vp = pg.getViewport({ scale: 2.0 });
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height;
          await pg.render({ canvas: c, viewport: vp }).promise;
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

  const fileIcon = (mime: string): NombreIcono => {
    if (mime?.includes('pdf')) return 'documento';
    if (mime?.includes('image')) return 'archivo';
    return 'documento';
  };

  const breadcrumb = [...folderStack.map(f => f.name), currentFolder ? '…' : ''].filter(Boolean).join(' / ') || 'Carpeta raíz';

  const columnasCuentas: ColumnaTabla<CuentaResultado>[] = [
    { key: 'placa', header: 'Placa', etiqueta: 'Placa', render: (c) => <span className="font-mono font-semibold text-[color:var(--color-action)]">{c.placa}</span> },
    { key: 'propietario', header: 'Propietario', etiqueta: 'Propietario', render: (c) => <span className="block max-w-[220px] truncate text-[color:var(--color-text-primary)]">{c.propietario}</span> },
    { key: 'cedula', header: 'Cédula', etiqueta: 'Cédula', soloEscritorio: true, render: (c) => <span className="text-[color:var(--color-text-secondary)]">{c.cedula}</span> },
    { key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo', soloEscritorio: true, render: (c) => <span className="block max-w-[160px] truncate text-[color:var(--color-text-secondary)]">{c.vehiculo}</span> },
    { key: 'tramite', header: 'Trámite', etiqueta: 'Trámite', render: (c) => (c.tipoTramite ? <TramiteChip tipo={c.tipoTramite} /> : <span className="text-[color:var(--color-text-tertiary)]">—</span>) },
    { key: 'valor', header: 'Valor', etiqueta: 'Valor', align: 'right', render: (c) => <span className="font-semibold tabular-nums text-[color:var(--color-text-primary)]">${(c.valorTotal || 0).toLocaleString('es-CO')}</span> },
    {
      key: 'pdf', header: 'PDF', etiqueta: 'PDF', align: 'center', acciones: true,
      render: (c) => (
        <GradientButton type="button" variant="ghost" size="sm" onClick={() => descargarConAuth(c.downloadUrl, c.pdfFile || `${c.placa}.pdf`)}>Descargar</GradientButton>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Google Drive"
        subtitle="Documentos del trámite · lectura y procesamiento de cuentas de cobro (PDF)"
        icono="flito-drive"
        miga={[]}
      />

      <FlitCard className="!py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {folderStack.length > 0 && (
              <GradientButton type="button" variant="secondary" onClick={goBack} className="shrink-0">
                <Icono nombre="izquierda" size={16} />
                Atrás
              </GradientButton>
            )}
            <Icono nombre="carpeta" size={18} className="shrink-0 text-[color:var(--color-text-tertiary)]" />
            <span className="truncate text-sm font-medium text-[color:var(--color-text-secondary)]">{breadcrumb}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Buscar archivos..."
              className={`${flitInp} min-w-0 flex-1 sm:w-56 sm:flex-none`}
            />
            <GradientButton type="button" onClick={doSearch} className="shrink-0">Buscar</GradientButton>
            {search && (
              <GradientButton type="button" variant="secondary" onClick={() => { setSearch(''); load(currentFolder || undefined); }} className="shrink-0">Limpiar</GradientButton>
            )}
          </div>
        </div>
      </FlitCard>

      {loading && <Cargador texto="Cargando Drive…" />}

      {!loading && (
        <>
          {folders.length > 0 && (
            <section>
              <SectionLabel>Carpetas ({folders.length})</SectionLabel>
              <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {folders.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => openFolder(f)}
                    className={`flit-focus flex min-w-0 items-center gap-2.5 p-3 text-left transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[color:var(--kit-hover)] ${TARJETA}`}
                  >
                    <Icono nombre="carpeta" size={20} className="shrink-0 text-[color:var(--color-action)]" />
                    <span className="truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{f.name}</span>
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
                    className={`flit-focus flex cursor-pointer flex-wrap items-center gap-3 p-3 transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[color:var(--kit-hover)] ${TARJETA}`}
                    onClick={() => preview(f)}
                  >
                    <Icono nombre={fileIcon(f.mimeType)} disco size={40} className="shrink-0" />
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{f.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{formatSize(f.size)} · {formatDate(f.modifiedTime)}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <GradientButton
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={e => { e.stopPropagation(); descargarConAuth(`/api/drive/download/${f.id}`, f.name); }}
                      >
                        <Icono nombre="nube-bajar" size={16} />
                        Descargar
                      </GradientButton>
                      {f.mimeType?.includes('pdf') && (
                        <GradientButton
                          type="button"
                          variant="success"
                          size="sm"
                          onClick={e => { e.stopPropagation(); procesarCuentas(f); }}
                          disabled={!!processingId}
                        >
                          {processingId === f.id ? 'Procesando…' : processingId ? 'Espere…' : 'Procesar'}
                        </GradientButton>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : !folders.length && (
            <FlitCard>
              <Vacio
                texto="Carpeta vacía o sin acceso"
                detalle="Recargue la página. Si persiste, comparta la carpeta con la cuenta de servicio del servidor."
                icono="carpeta"
              />
            </FlitCard>
          )}
        </>
      )}

      {processingId && (
        <FlitCard>
          <Cargador texto="Procesando cuentas de cobro…" />
          <p className="-mt-2 pb-2 text-center text-xs text-[color:var(--color-text-tertiary)]">Leyendo cada página del PDF. Puede tardar unos minutos.</p>
        </FlitCard>
      )}

      {processResult && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Icono nombre="doble-check" size={20} className="text-[color:var(--kit-verde-texto)]" />
            <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Resultado del procesamiento</h2>
            <GradientButton type="button" variant="ghost" size="sm" onClick={() => setProcessResult(null)} className="ml-auto">Cerrar</GradientButton>
          </div>

          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
            {[
              { l: 'Páginas', v: processResult.totalPaginas },
              { l: 'Cuentas', v: processResult.cuentasDetectadas },
              { l: 'Placas', v: processResult.placasUnicas },
              { l: 'Valor total', v: '$' + (processResult.valorTotal || 0).toLocaleString('es-CO') },
            ].map(s => (
              <KpiCard key={s.l} label={s.l} value={s.v} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <GradientButton type="button" variant="success" onClick={() => descargarConAuth(processResult.excelDownloadUrl, processResult.excelFile)}>
              Descargar Excel resumen
            </GradientButton>
            {processResult.zipDownloadUrl && processResult.zipFile && (
              <GradientButton type="button" onClick={() => descargarConAuth(processResult.zipDownloadUrl!, processResult.zipFile!)}>
                Descargar todas las facturas (ZIP)
              </GradientButton>
            )}
          </div>

          <DataTable
            ariaLabel="Resultado del procesamiento"
            columnas={columnasCuentas}
            filas={processResult.cuentas ?? []}
            getKey={(c) => String(processResult.cuentas.indexOf(c))}
          />
        </section>
      )}

      {(previewFile || previewLoading) && (
        <ModalPortal>
        <div
          className="flit-modal kit-velo items-center justify-center p-3 sm:p-6"
          {...previewBackdrop}
        >
          <div
            className="kit-modal my-auto max-h-[90vh] max-w-4xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="kit-modal__cabeza !items-start !text-left">
              <p className="kit-modal__titulo w-full truncate pr-10 !text-lg">{previewFile?.name || 'Cargando…'}</p>
              <button type="button" onClick={closePreview} aria-label="Cerrar" className="kit-modal__cerrar flit-focus">
                <Icono nombre="cerrar" size={20} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-[color:var(--color-surface)]" style={{ maxHeight: 'calc(90vh - 60px)' }}>
              {previewLoading && <Cargador texto="Cargando…" />}
              {previewFile && previewFile.mimeType?.includes('image') && (
                <img src={previewFile.data} alt={previewFile.name} className="h-auto w-full" />
              )}
              {previewFile?.pages && previewFile.pages.length > 0 && (
                <div className="flex flex-col items-center gap-3 p-4">
                  {previewFile.pages.map((pg, i) => (
                    <div key={i} className={`w-full overflow-hidden ${TARJETA}`}>
                      <img src={pg} alt={`Página ${i + 1}`} className="block h-auto w-full" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        </ModalPortal>
      )}
    </div>
  );
}
