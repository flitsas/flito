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
import ModalPortal from '../components/flit/ModalPortal';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { ErrorVista } from '../components/flit/Cargador';
import { Fichas } from '../components/flit/Bloques';
import { Icono } from '../components/flit/kit/Icono';
import type { PasoMiga } from '../components/flit/Miga';

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

const NIVEL_TONE: Record<NivelRubrica, ChipTone> = {
  no_implementado: 'neutral', en_desarrollo: 'warning',
  implementado: 'active', sostenido: 'success',
};

// Tarjeta del kit: borde, radio 9, sin sombra.
const CARD = 'rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)]';
const MIGA: PasoMiga[] = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }, { etiqueta: 'Diagnóstico', to: '/pesv/diagnostico' }];
const H3 = 'mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]';

export default function PesvDiagnosticoAuditoria() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = parseInt(idParam ?? '', 10);
  const navigate = useNavigate();
  const { user, hasFuncion } = useAuth();
  const puedeConsultar = hasFuncion('pesv.diagnostico_consulta.administrar');
  const puedeEditar = hasFuncion('pesv.diagnostico.administrar');
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

  // Guarda por función (HU #12872) — el backend rechaza con 403 pero damos UX clara antes del request.
  if (user && !puedeConsultar) {
    return <Sin403 />;
  }

  if (Number.isNaN(id)) return <Sin403 />;
  if (loading) return <SkeletonAuditoria />;
  if (error || !detail) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <ErrorVista texto={error ?? 'Diagnóstico no encontrado.'} onReintentar={load} />
      </div>
    );
  }

  // Empty state: borrador todavía no auditable
  if (detail.estado !== 'cerrado') {
    return <EmptyBorrador id={id} anio={detail.anio} canEdit={puedeEditar} navigate={navigate} />;
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

  const puedeVolverEditor = puedeEditar;

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 print:p-0 lg:gap-6">
      {/* Cabecera + aviso de modo lectura */}
      <div className="flex flex-col gap-3" role="region" aria-label="Aviso de modo lectura">
        <PageHeaderCard
          title={`Diagnóstico ${detail.anio}`}
          subtitle={`Score ${parseFloat(detail.scoreGlobal).toFixed(1)}% · Diagnóstico cerrado el ${fmtDate(detail.cerradoAt)} por responsable id ${detail.responsableId ?? '—'}.`}
          icono="flito-pesv"
          miga={MIGA}
          actions={
            <div className="flex flex-wrap gap-2 print:hidden">
              <GradientButton type="button" onClick={exportarExpediente}><DownloadIcon /> Exportar expediente (ZIP)</GradientButton>
              <GradientButton type="button" variant="secondary" onClick={imprimir}><PrinterIcon /> Imprimir</GradientButton>
              {puedeVolverEditor && (
                <GradientButton type="button" variant="secondary" onClick={() => navigate(`/pesv/diagnostico/${id}`)}>Volver al editor</GradientButton>
              )}
            </div>
          }
        />
        <div className="kit-alerta print:rounded-none" data-tono="warn" data-kit="alerta">
          <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="m-0 font-semibold">Modo auditoría · solo lectura</p>
            <p className="mt-1 max-w-3xl text-xs text-[color:var(--color-text-secondary)]">Cada estándar muestra evidencias originales, comentarios del responsable e historial de cambios. Res. 40595/2022 anexo metodológico.</p>
          </div>
        </div>
      </div>

      {detail.nivelCriterioJustificacion && (
        <div className={`${CARD} p-4`}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">Justificación del nivel ({detail.nivelEmpresa ?? 'avanzado'})</p>
          <p className="whitespace-pre-wrap text-sm text-[color:var(--color-text-secondary)]">{detail.nivelCriterioJustificacion}</p>
        </div>
      )}

      {/* Lista expediente */}
      <div className="space-y-5">
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
type FilaHistorial = HistorialEntry & { _k: string };
const COLUMNAS_HISTORIAL: ColumnaTabla<FilaHistorial>[] = [
  { key: 'fecha', header: 'Fecha', etiqueta: 'Fecha', render: (h) => <span className="tabular-nums">{fmtDate(h.createdAt)}</span> },
  { key: 'usuario', header: 'Usuario', etiqueta: 'Usuario', render: (h) => h.userId ?? '—' },
  { key: 'accion', header: 'Acción', etiqueta: 'Acción', render: (h) => h.action },
  { key: 'detalle', header: 'Detalle', etiqueta: 'Detalle', render: (h) => <span className="block max-w-md truncate" title={h.detail ?? ''}>{h.detail}</span> },
];

function TarjetaEstandarExpediente({ item, historial, onVerEvidencia, onExportar }: {
  item: ItemDetail; historial: HistorialEntry[];
  onVerEvidencia: (ev: EvidenciaPublic) => void; onExportar: () => void;
}) {
  const score = parseFloat(item.scorePct);
  const peso = parseFloat(item.peso);
  const aporte = (score * peso) / 100;
  const filasHistorial = historial.map((h, i) => ({ ...h, _k: String(i) }));

  return (
    <article className={`${CARD} p-4 print:break-inside-avoid sm:p-6`}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-border)] pb-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">{item.fase} · paso {item.paso}</p>
          <h2 className="mt-1 text-xl font-bold text-[color:var(--color-text-primary)]"><span className="text-base tabular-nums text-[color:var(--color-text-secondary)]">{item.codigo}</span> · {item.nombre}</h2>
        </div>
        <StatusChip tone={NIVEL_TONE[item.nivelRubrica]}>{NIVEL_RUBRICA_LABEL[item.nivelRubrica]}</StatusChip>
      </header>

      <div className="mb-4">
        <Fichas items={[
          { etiqueta: 'Score', valor: `${score.toFixed(0)}%` },
          { etiqueta: 'Peso', valor: peso.toFixed(2) },
          { etiqueta: 'Aporte', valor: aporte.toFixed(2) },
        ]} />
      </div>

      {item.descripcion && (
        <section className="mb-4">
          <h3 className={H3}>Descripción normativa</h3>
          <p className="whitespace-pre-wrap text-sm text-[color:var(--color-text-secondary)]">{item.descripcion}</p>
        </section>
      )}

      <section className="mb-4">
        <h3 className={H3}>Comentarios del responsable</h3>
        {item.comentarios
          ? <blockquote className="whitespace-pre-wrap border-l-2 border-[color:var(--kit-azul)] py-1 pl-4 text-sm text-[color:var(--color-text-primary)]">{item.comentarios}</blockquote>
          : <p className="text-xs italic text-[color:var(--color-text-tertiary)]">Sin comentarios</p>}
      </section>

      <section className="mb-4">
        <h3 className={H3}>Evidencias adjuntas ({item.evidencias.length})</h3>
        {item.evidencias.length === 0 ? (
          <p className="text-xs italic text-[color:var(--color-text-tertiary)]">Sin evidencias adjuntas.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {item.evidencias.map((ev) => (
              <li key={ev.keyHash}>
                <button onClick={() => onVerEvidencia(ev)} className={`${CARD} flit-focus flex w-full items-center gap-3 p-3 text-left text-[color:var(--color-text-tertiary)] transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[color:var(--kit-hover)]`}>
                  <IconoArchivo mime={ev.mime} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-[color:var(--color-text-primary)]">{ev.filename}</p>
                    <p className="truncate text-[10px] tabular-nums text-[color:var(--color-text-tertiary)]">SHA-256 {ev.keyHash} · {fmtDate(ev.uploadedAt)}</p>
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
          <h3 className={H3}>Historial</h3>
          <DataTable
            ariaLabel={`Historial de ${item.codigo}`}
            columnas={COLUMNAS_HISTORIAL}
            filas={filasHistorial}
            getKey={(h) => h._k}
            status="ready"
          />
        </section>
      )}

      <footer className="mt-2 flex justify-end border-t border-[color:var(--color-border)] pt-3 print:hidden">
        <GradientButton type="button" variant="secondary" size="sm" onClick={onExportar}><DownloadIcon /> Exportar este estándar (PDF + ZIP)</GradientButton>
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
  // Diálogo propio (conserva su aria-label y el cierre por clic en el velo) con las clases del modal del kit.
  return (
    <ModalPortal>
    <div className="kit-velo fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[5px] sm:p-6" role="dialog" aria-modal="true" aria-label={`Vista previa de ${filename}`} onClick={onClose}>
      <div className="kit-modal max-h-[90vh] w-auto max-w-5xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="kit-modal__cabeza flex items-center justify-between gap-3">
          <p className="kit-modal__titulo m-0 min-w-0 truncate text-sm">{filename}</p>
          <button onClick={onClose} className="kit-modal__cerrar flit-focus" aria-label="Cerrar"><CloseXIcon /></button>
        </div>
        <div className="kit-modal__cuerpo">
          {esImagen(mime)
            ? <img src={url} alt={filename} className="max-h-[75vh] max-w-full rounded-[9px] bg-[color:var(--color-surface)] object-contain" />
            : <p className="p-4 text-sm text-[color:var(--color-text-secondary)]">Vista previa no disponible — <a href={url} target="_blank" rel="noopener noreferrer" className="flit-focus font-semibold text-[color:var(--color-action)] underline transition-colors">abrir en nueva pestaña</a></p>}
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

function EmptyBorrador({ id, anio, canEdit, navigate }: { id: number; anio: number; canEdit: boolean; navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div className="mx-auto max-w-[800px]">
      <div className={`${CARD} p-8 text-center sm:p-12`} data-kit="vacio">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--kit-hover)] text-[color:var(--kit-naranja-texto)]" aria-hidden="true"><Icono nombre="espera" className="h-7 w-7" /></div>
        <h2 className="text-2xl font-bold text-[color:var(--color-text-primary)]">Diagnóstico {anio} aún en borrador</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[color:var(--color-text-secondary)]">La vista de auditoría se habilita cuando el líder PESV cierra formalmente el diagnóstico y emite la línea base WORM.</p>
        {canEdit && (
          <div className="mt-6 flex justify-center">
            <GradientButton type="button" onClick={() => navigate(`/pesv/diagnostico/${id}`)}>Ir al editor</GradientButton>
          </div>
        )}
      </div>
    </div>
  );
}

function Sin403() {
  return (
    <div className="mx-auto max-w-[600px]">
      <div className={`${CARD} p-8 text-center`}>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--kit-hover)] text-[color:var(--color-action)]" aria-hidden="true"><Icono nombre="rol" className="h-7 w-7" /></div>
        <h2 className="text-2xl font-bold text-[color:var(--color-text-primary)]">Sin acceso</h2>
        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">No tienes permisos para acceder al expediente de auditoría.</p>
      </div>
    </div>
  );
}

function SkeletonAuditoria() {
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
      <div className="kit-esqueleto h-32 rounded-[9px]" data-kit="esqueleto" />
      {[0, 1, 2].map((i) => <div key={i} className="kit-esqueleto h-40 rounded-[9px]" data-kit="esqueleto" />)}
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
  const cls = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--kit-hover)]';
  if (isPdf) return <span className={`${cls} text-[color:var(--kit-rojo-texto)]`} aria-hidden="true"><Icono nombre="documento" className="h-5 w-5" /></span>;
  if (isImg) return <span className={`${cls} text-[color:var(--color-action)]`} aria-hidden="true"><Icono nombre="ojo" className="h-5 w-5" /></span>;
  return <span className={`${cls} text-[color:var(--color-text-secondary)]`} aria-hidden="true"><Icono nombre="archivo" className="h-5 w-5" /></span>;
}
