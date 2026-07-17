// PESV Diagnóstico — vista auditor (plan §10). Capa visual FLIT (Fase 6A).
// Modo lectura del expediente. Rol `compliance` es redirigido aquí desde
// PesvDiagnostico/<id>. `lider_pesv` y `admin` pueden entrar voluntariamente
// desde el botón "Ver como auditor". Estructura/roles/aria/textos conservados (E2E).
//
// Microcopy MOLANO: Res. 40595/2022 anexo metodológico. NUNCA 20223040045295.
// Backend: GET /pesv/diagnostico/:id?view=auditoria devuelve items con `evidencias`
// y `historial` global del expediente. Cada GET presigned dispara audit + pii_access_log.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  NIVEL_RUBRICA_LABEL, type FasePhva, type NivelEmpresa,
  type NivelRubrica,
} from '../types/pesv';
import { DownloadIcon, PrinterIcon, ExternalLinkIcon, CloseXIcon } from '../components/pesv/icons';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface EvidenciaPublic {
  keyHash: string; filename: string; sizeBytes: number; mime: string;
  uploadedAt: string; uploadedBy: number;
}
interface ItemDetail {
  diagnosticoId: number; estandarId: number; codigo: string; paso: number;
  fase: FasePhva; nombre: string; descripcion: string | null;
  peso: string; orden: number; scorePct: string; nivelRubrica: NivelRubrica;
  comentarios: string | null; evidencias: EvidenciaPublic[]; updatedAt: string;
}
interface HistorialEntry {
  createdAt: string; userId: number | null; action: string;
  detail: string | null; resourceId: string | null;
}
interface DiagDetail {
  id: number; anio: number; fecha: string;
  scoreGlobal: string; estado: 'borrador' | 'cerrado';
  cerradoAt: string | null; createdAt?: string; updatedAt?: string;
  nivelEmpresa?: NivelEmpresa; responsableId?: number | null;
  items: ItemDetail[]; historial?: HistorialEntry[];
  nivelCriterioJustificacion?: string | null; observaciones?: string | null;
}

const ROL_PERMITIDO = new Set(['compliance', 'lider_pesv', 'admin']);

const NIVEL_TONE: Record<NivelRubrica, ChipTone> = {
  no_implementado: 'neutral', en_desarrollo: 'warning',
  implementado: 'active', sostenido: 'success',
};

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const navyBtn = 'flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] border bg-white px-4 text-sm font-medium';

export default function PesvDiagnosticoAuditoria() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = parseInt(idParam ?? '', 10);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [detail, setDetail] = useState<DiagDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; mime: string; filename: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<DiagDetail>(`/pesv/diagnostico/${id}?view=auditoria`);
      setDetail(r);
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      toast.error(msg);
    } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { if (!Number.isNaN(id)) load(); }, [id, load]);

  const historialPorItem = useMemo(() => {
    const map = new Map<number, HistorialEntry[]>();
    if (!detail?.historial) return map;
    for (const h of detail.historial) {
      const m = /^\d+\/(\d+)$/.exec(h.resourceId ?? '');
      const eid = m ? parseInt(m[1], 10) : null;
      if (eid !== null) {
        const arr = map.get(eid) ?? [];
        arr.push(h);
        map.set(eid, arr);
      }
    }
    return map;
  }, [detail]);

  // Guard de rol — el backend rechaza con 403 pero damos UX clara antes del request.
  if (user && !ROL_PERMITIDO.has(user.role)) {
    return <Sin403 />;
  }

  if (Number.isNaN(id)) return <Sin403 />;
  if (loading) return <SkeletonAuditoria />;
  if (error || !detail) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>{error ?? 'Diagnóstico no encontrado.'}</p>
      </div>
    );
  }

  // Empty state: borrador todavía no auditable
  if (detail.estado !== 'cerrado') {
    return <EmptyBorrador id={id} anio={detail.anio} canEdit={user?.role !== 'compliance'} navigate={navigate} />;
  }

  const verEvidencia = async (item: ItemDetail, ev: EvidenciaPublic) => {
    try {
      const r = await api.get<{ url: string; expiresAt: string; filename: string }>(
        `/pesv/diagnostico/${id}/items/${item.estandarId}/evidencias/${ev.keyHash}`
      );
      if (esImagen(ev.mime)) setLightbox({ url: r.url, mime: ev.mime, filename: ev.filename });
      else window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const exportarEstandar = (item: ItemDetail) => {
    window.location.href = `/api/pesv/export/diagnostico/${id}/estandar/${encodeURIComponent(item.codigo)}`;
  };
  const exportarExpediente = () => { window.location.href = `/api/pesv/export/diagnostico/${id}`; };
  const imprimir = () => window.print();

  const puedeVolverEditor = user?.role === 'admin' || user?.role === 'lider_pesv';

  return (
    <div className="mx-auto max-w-[1200px] print:p-0">
      {/* Banner alto contraste */}
      <div className="mb-6 rounded-[18px] p-5 print:rounded-none" style={{ border: '2px solid var(--flit-warning)', background: 'rgba(240,90,53,0.10)' }} role="region" aria-label="Aviso de modo lectura">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-warning)' }}>Modo auditoría · solo lectura</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl" style={{ color: 'var(--flit-blue-text)' }}>
              Diagnóstico {detail.anio}
              <span className="ml-3 text-sm font-normal" style={{ color: 'var(--flit-text-secondary)' }}>Score {parseFloat(detail.scoreGlobal).toFixed(1)}%</span>
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Diagnóstico cerrado el {fmtDate(detail.cerradoAt)} por responsable id {detail.responsableId ?? '—'}.</p>
            <p className="mt-2 max-w-3xl text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cada estándar muestra evidencias originales, comentarios del responsable e historial de cambios. Res. 40595/2022 anexo metodológico.</p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button onClick={exportarExpediente} className="flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] px-4 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}><DownloadIcon /> Exportar expediente (ZIP)</button>
            <button onClick={imprimir} className={navyBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}><PrinterIcon /> Imprimir</button>
            {puedeVolverEditor && (
              <button onClick={() => navigate(`/pesv/diagnostico/${id}`)} className={navyBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Volver al editor</button>
            )}
          </div>
        </div>
      </div>

      {detail.nivelCriterioJustificacion && (
        <div className="mb-6 bg-white p-4" style={CARD}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Justificación del nivel ({detail.nivelEmpresa ?? 'avanzado'})</p>
          <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{detail.nivelCriterioJustificacion}</p>
        </div>
      )}

      {/* Lista expediente */}
      <div className="space-y-6">
        {detail.items.map((it) => (
          <TarjetaEstandarExpediente
            key={it.estandarId}
            item={it}
            historial={historialPorItem.get(it.estandarId) ?? []}
            onVerEvidencia={(ev) => verEvidencia(it, ev)}
            onExportar={() => exportarEstandar(it)}
          />
        ))}
      </div>

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}

      {/* Print styles */}
      <style>{`@media print { .print\\:hidden { display: none !important; } body { background: white !important; } [role="region"] { page-break-after: avoid; } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ──────────────────────────────────────────────────────────────────────────
function TarjetaEstandarExpediente({ item, historial, onVerEvidencia, onExportar }: {
  item: ItemDetail; historial: HistorialEntry[];
  onVerEvidencia: (ev: EvidenciaPublic) => void; onExportar: () => void;
}) {
  const score = parseFloat(item.scorePct);
  const peso = parseFloat(item.peso);
  const aporte = (score * peso) / 100;

  return (
    <article className="bg-white p-6 print:shadow-none print:break-inside-avoid" style={CARD}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{item.fase} · paso {item.paso}</p>
          <h2 className="mt-1 text-xl font-bold" style={{ color: 'var(--flit-text-primary)' }}><span className="font-mono text-base" style={{ color: 'var(--flit-text-secondary)' }}>{item.codigo}</span> · {item.nombre}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={NIVEL_TONE[item.nivelRubrica]}>{NIVEL_RUBRICA_LABEL[item.nivelRubrica]}</StatusChip>
          <span className="font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Score {score.toFixed(0)}% · Peso {peso.toFixed(2)} · Aporte {aporte.toFixed(2)}</span>
        </div>
      </header>

      {item.descripcion && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Descripción normativa</h3>
          <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{item.descripcion}</p>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Comentarios del responsable</h3>
        {item.comentarios
          ? <blockquote className="border-l-2 py-1 pl-4 text-sm whitespace-pre-wrap" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-text-primary)' }}>{item.comentarios}</blockquote>
          : <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin comentarios</p>}
      </section>

      <section className="mb-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Evidencias adjuntas ({item.evidencias.length})</h3>
        {item.evidencias.length === 0 ? (
          <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin evidencias adjuntas.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {item.evidencias.map((ev) => (
              <li key={ev.keyHash}>
                <button onClick={() => onVerEvidencia(ev)} className="flit-focus flex w-full items-center gap-3 rounded-[12px] border bg-white p-3 text-left transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <IconoArchivo mime={ev.mime} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" style={{ color: 'var(--flit-text-primary)' }}>{ev.filename}</p>
                    <p className="font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>SHA-256 {ev.keyHash} · {fmtDate(ev.uploadedAt)}</p>
                  </div>
                  <ExternalLinkIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {historial.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Historial</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <th className="px-2 py-1.5 text-left font-medium" style={{ color: 'var(--flit-text-muted)' }}>Fecha</th>
                <th className="px-2 py-1.5 text-left font-medium" style={{ color: 'var(--flit-text-muted)' }}>Usuario</th>
                <th className="px-2 py-1.5 text-left font-medium" style={{ color: 'var(--flit-text-muted)' }}>Acción</th>
                <th className="px-2 py-1.5 text-left font-medium" style={{ color: 'var(--flit-text-muted)' }}>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {historial.map((h, i) => (
                <tr key={i} className="border-b last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--flit-text-secondary)' }}>{fmtDate(h.createdAt)}</td>
                  <td className="px-2 py-1.5" style={{ color: 'var(--flit-text-secondary)' }}>{h.userId ?? '—'}</td>
                  <td className="px-2 py-1.5" style={{ color: 'var(--flit-text-secondary)' }}>{h.action}</td>
                  <td className="max-w-md truncate px-2 py-1.5" style={{ color: 'var(--flit-text-secondary)' }} title={h.detail ?? ''}>{h.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="mt-2 flex justify-end border-t pt-3 print:hidden" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <button onClick={onExportar} className="flit-focus inline-flex h-9 items-center gap-2 rounded-[999px] border bg-white px-3 text-xs font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}><DownloadIcon /> Exportar este estándar (PDF + ZIP)</button>
      </footer>
    </article>
  );
}

function Lightbox({ url, mime, filename, onClose }: { url: string; mime: string; filename: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(22,39,68,0.45)', backdropFilter: 'blur(6px)' }} role="dialog" aria-modal="true" aria-label={`Vista previa de ${filename}`} onClick={onClose}>
      <div className="max-h-[90vh] max-w-5xl overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="truncate text-sm" style={{ color: 'var(--flit-text-primary)' }}>{filename}</p>
          <button onClick={onClose} className="flit-focus rounded-lg" style={{ color: 'var(--flit-text-muted)' }} aria-label="Cerrar"><CloseXIcon /></button>
        </div>
        {esImagen(mime)
          ? <img src={url} alt={filename} className="max-h-[80vh] max-w-full object-contain" style={{ background: 'var(--flit-bg-app)' }} />
          : <p className="p-8 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Vista previa no disponible — <a href={url} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--flit-blue)' }}>abrir en nueva pestaña</a></p>}
      </div>
    </div>
  );
}

function EmptyBorrador({ id, anio, canEdit, navigate }: { id: number; anio: number; canEdit: boolean; navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div className="mx-auto max-w-[800px]">
      <div className="bg-white p-12 text-center" style={CARD}>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'rgba(240,90,53,0.12)', color: 'var(--flit-warning)' }} aria-hidden="true"><svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Diagnóstico {anio} aún en borrador</h2>
        <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--flit-text-secondary)' }}>La vista de auditoría se habilita cuando el líder PESV cierra formalmente el diagnóstico y emite la línea base WORM.</p>
        {canEdit && (
          <button onClick={() => navigate(`/pesv/diagnostico/${id}`)} className="flit-focus mt-6 inline-flex h-10 items-center rounded-[999px] px-4 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Ir al editor</button>
        )}
      </div>
    </div>
  );
}

function Sin403() {
  return (
    <div className="mx-auto max-w-[600px]">
      <div className="bg-white p-8 text-center" style={CARD}>
        <h2 className="text-2xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Sin acceso</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>No tienes permisos para acceder al expediente de auditoría.</p>
      </div>
    </div>
  );
}

function SkeletonAuditoria() {
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-6 h-32 animate-pulse bg-white motion-reduce:animate-none" style={CARD} />
      <div className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse bg-white motion-reduce:animate-none" style={CARD} />)}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function esImagen(mime: string) { return mime.startsWith('image/'); }
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function IconoArchivo({ mime }: { mime: string }) {
  const isPdf = mime === 'application/pdf';
  const isImg = mime.startsWith('image/');
  const cls = 'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center';
  if (isPdf) return <span className={cls} style={{ background: 'rgba(228,61,48,0.12)', color: 'var(--flit-danger)' }} aria-hidden="true"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>;
  if (isImg) return <span className={cls} style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }} aria-hidden="true"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg></span>;
  return <span className={cls} style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }} aria-hidden="true"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>;
}
