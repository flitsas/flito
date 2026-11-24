// PESV Auto-diagnóstico PHVA · Workspace líder + listado anualidades.
// UI Kit 2026 (Épica #14560, S5): molde M-DETALLE + M-MODAL. Estructura/paneles/rúbrica, roles y aria-labels
// conservados (E2E pesv-diagnostico-*). Modales/drawer viven en components/pesv/*.
//
// Contratos zod en `apps/api/src/modules/pesv/diagnostico.schemas.ts`. Las columnas
// numeric llegan como string (driver postgres-js).
//
// Microcopy MOLANO: "Res. 40595/2022 anexo metodológico". NUNCA 20223040045295.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import DiagnosticoCrearModal from '../components/pesv/DiagnosticoCrearModal';
import DiagnosticoEvaluacionDrawer from '../components/pesv/DiagnosticoEvaluacionDrawer';
import DiagnosticoCierreModal from '../components/pesv/DiagnosticoCierreModal';
import {
  ArrowRightIcon, LockIcon, ClipboardCheckIcon, SearchIcon,
} from '../components/pesv/icons';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import { ErrorVista } from '../components/flit/Cargador';
import type { PasoMiga } from '../components/flit/Miga';
import type {
  FasePhva, NivelEmpresa, NivelRubrica, PreflightResponse,
} from '../types/pesv';

// Tipos espejo de contratos zod del backend ─────────────────────────────
interface DiagRow {
  id: number; anio: number; fecha: string;
  scoreGlobal: string; estado: 'borrador' | 'cerrado';
  cerradoAt: string | null; createdAt?: string; updatedAt?: string;
  nivelEmpresa?: NivelEmpresa; responsableId?: number | null;
}
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
interface DiagDetail extends DiagRow { items: ItemDetail[]; historial?: HistorialEntry[]; }
interface HistorialEntry { createdAt: string; userId: number | null; action: string; detail: string | null; resourceId?: string | null; }

const FASES: FasePhva[] = ['planear', 'hacer', 'verificar', 'actuar'];
const FASE_LABEL: Record<FasePhva, string> = { planear: 'Planear', hacer: 'Hacer', verificar: 'Verificar', actuar: 'Actuar' };

// Tarjeta del kit: borde, radio 9, sin sombra.
const CARD = 'rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)]';
const MIGA_PESV: PasoMiga[] = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];

// Página raíz: decide lista vs detalle según params ──────────────────────
export default function PesvDiagnostico() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <DetalleDiagnostico id={parseInt(id, 10)} />;
  return <ListaDiagnosticos />;
}

// ══════════════════════════════════════════════════════════════════════════
// VISTA LISTA — grid de tarjetas anualidad
// ══════════════════════════════════════════════════════════════════════════
function ListaDiagnosticos() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DiagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: DiagRow[] }>('/pesv/diagnostico');
      setItems([...r.data].sort((a, b) => b.anio - a.anio));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onCreated = (newId: number) => { setShowCreate(false); navigate(`/pesv/diagnostico/${newId}`); };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Diagnóstico PESV"
        subtitle="Auto-evaluación PHVA con evidencia documental ante MinTransporte, SuperTransporte y ONAC."
        icono="flito-pesv"
        miga={MIGA_PESV}
        actions={
          <GradientButton type="button" onClick={() => setShowCreate(true)} aria-label="Crear nuevo diagnóstico">
            Nuevo diagnóstico
          </GradientButton>
        }
      />

      {loading ? <SkeletonGrid /> : items.length === 0 ? (
        <EmptyState onCreate={() => setShowCreate(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((d, idx) => {
            const prev = items[idx + 1]; // ordenado desc por año → siguiente en array es año anterior
            return <TarjetaAnualidad key={d.id} diag={d} prev={prev ?? null} onOpen={() => navigate(`/pesv/diagnostico/${d.id}`)} />;
          })}
        </div>
      )}

      {showCreate && <DiagnosticoCrearModal onClose={() => setShowCreate(false)} onCreated={onCreated} />}
    </div>
  );
}

function TarjetaAnualidad({ diag, prev, onOpen }: { diag: DiagRow; prev: DiagRow | null; onOpen: () => void }) {
  const score = parseFloat(diag.scoreGlobal);
  const prevScore = prev ? parseFloat(prev.scoreGlobal) : null;
  const delta = prevScore !== null ? score - prevScore : null;
  const tone = score >= 80 ? 'text-[color:var(--kit-verde-texto)]' : score >= 60 ? 'text-[color:var(--kit-naranja-texto)]' : 'text-[color:var(--kit-rojo-texto)]';
  const relativeEdit = diag.updatedAt ? relativeTime(diag.updatedAt) : null;

  return (
    <button onClick={onOpen} className={`${CARD} flit-focus p-5 text-left transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[color:var(--kit-hover)]`}>
      <div className="mb-3 flex items-start justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">Año {diag.anio}</span>
        <StatusChip tone={diag.estado === 'cerrado' ? 'success' : 'active'}>{diag.estado}</StatusChip>
      </div>
      <div className="flex items-baseline gap-2">
        <div className={`text-3xl font-bold tabular-nums ${tone}`}>{score.toFixed(1)}<span className="text-base font-normal text-[color:var(--color-text-tertiary)]">%</span></div>
        {delta !== null && delta !== 0 && (
          <span className={`text-xs font-semibold ${delta > 0 ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>{delta > 0 ? '+' : ''}{delta.toFixed(1)} pts</span>
        )}
      </div>
      <p className="mt-2 text-[11px] tabular-nums text-[color:var(--color-text-tertiary)]">{diag.fecha}</p>
      {relativeEdit && <p className="mt-1 text-[11px] text-[color:var(--color-text-tertiary)]">Última edición {relativeEdit}</p>}
      <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-[color:var(--color-action)]">Abrir expediente <ArrowRightIcon /></span>
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={`${CARD} mx-auto w-full max-w-lg p-8 text-center sm:p-12`} data-kit="vacio">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--kit-hover)] text-[color:var(--color-action)]" aria-hidden="true">
        <ClipboardCheckIcon />
      </div>
      <h2 className="text-2xl font-bold text-[color:var(--color-text-primary)]">Aún sin diagnósticos</h2>
      <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">El expediente PESV inicia con la línea base anual. Cada estándar requerirá evidencia documental para ser válido ante auditor.</p>
      <div className="mt-6 flex justify-center">
        <GradientButton type="button" onClick={onCreate}>Crear primer diagnóstico</GradientButton>
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => <div key={i} className="kit-esqueleto h-40 rounded-[9px]" data-kit="esqueleto" />)}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// VISTA DETALLE — workspace líder con drawer + modal cierre
// ══════════════════════════════════════════════════════════════════════════
function DetalleDiagnostico({ id }: { id: number }) {
  const navigate = useNavigate();
  const { user, hasFuncion } = useAuth();
  const [detail, setDetail] = useState<DiagDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [faseFiltro, setFaseFiltro] = useState<FasePhva | null>(null);
  const [search, setSearch] = useState('');
  const [drawerEstandarId, setDrawerEstandarId] = useState<number | null>(null);
  const [cierre, setCierre] = useState<PreflightResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<DiagDetail>(`/pesv/diagnostico/${id}`);
      setDetail(r);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Redirect a /auditoria de quien solo CONSULTA (HU #12872: por función, no por rol) — el backend
  // ya emite header X-Redirect-To, pero `lib/api.ts` no lo intercepta.
  const soloConsulta = hasFuncion('pesv.diagnostico_consulta.administrar') && !hasFuncion('pesv.diagnostico.administrar');
  useEffect(() => {
    if (!user) return;
    if (soloConsulta) navigate(`/pesv/diagnostico/${id}/auditoria`, { replace: true });
  }, [user, soloConsulta, id, navigate]);

  const stats = useMemo(() => computeStats(detail?.items ?? []), [detail]);
  const itemsVisibles = useMemo(() => filterItems(detail?.items ?? [], faseFiltro, search), [detail, faseFiltro, search]);
  const isWorm = detail?.estado === 'cerrado';

  const abrirCierre = async () => {
    try {
      const pre = await api.get<PreflightResponse>(`/pesv/diagnostico/${id}/preflight`);
      setCierre(pre);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const confirmarCierre = async () => {
    try {
      await api.post(`/pesv/diagnostico/${id}/cerrar`);
      toast.success('Diagnóstico cerrado. Línea base WORM emitida.');
      setCierre(null);
      navigate(`/pesv/diagnostico/${id}/auditoria`, { replace: true });
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (loading) {
    return (
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <div className="kit-esqueleto h-32 rounded-[9px]" data-kit="esqueleto" />
        <div className="kit-esqueleto h-64 rounded-[9px]" data-kit="esqueleto" />
      </div>
    );
  }
  if (!detail) return <div className="mx-auto max-w-[1600px]"><ErrorVista texto="Diagnóstico no encontrado." onReintentar={load} /></div>;

  const drawerItem = drawerEstandarId !== null ? detail.items.find((i) => i.estandarId === drawerEstandarId) ?? null : null;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title={`Diagnóstico ${detail.anio}`}
        subtitle={`PESV · Res. 40595/2022 · Nivel ${detail.nivelEmpresa ?? 'avanzado'} · Score ${parseFloat(detail.scoreGlobal).toFixed(1)}%`}
        icono="flito-pesv"
        miga={[...MIGA_PESV, { etiqueta: 'Diagnóstico', to: '/pesv/diagnostico' }]}
        actions={
          <>
            <GradientButton type="button" variant="secondary" onClick={() => navigate(`/pesv/diagnostico/${id}/auditoria`)}>Ver como auditor</GradientButton>
            {!isWorm && (
              <GradientButton type="button" onClick={abrirCierre} disabled={stats.evaluados === 0} aria-label="Cerrar diagnóstico">
                <LockIcon /> Cerrar diagnóstico
              </GradientButton>
            )}
          </>
        }
      />

      {isWorm && (
        <div className="kit-alerta" data-tono="warn" data-kit="alerta" role="status">
          <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="m-0 font-semibold">Diagnóstico cerrado el {fmtDate(detail.cerradoAt)}. Vista solo lectura.</p>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">Para vista auditor accesible al compliance officer, <button onClick={() => navigate(`/pesv/diagnostico/${id}/auditoria`)} className="flit-focus rounded-sm font-semibold text-[color:var(--color-action)] transition-colors hover:underline">abrir modo auditoría</button>.</p>
          </div>
        </div>
      )}

      <div className={`${CARD} px-5 py-4`}>
        <ProgressBar evaluados={stats.evaluados} total={stats.total} conEvidencia={stats.conEvidencia} advertencias={stats.advertencias} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)_240px]">
        {/* Sidebar fases */}
        <aside aria-label="Filtros por fase PHVA">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-tertiary)]">Fases PHVA</h2>
          <nav className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:flex sm:flex-row sm:flex-wrap lg:flex-col">
            <FaseChip activo={faseFiltro === null} onClick={() => setFaseFiltro(null)} label="Todas" count={stats.total} progreso={stats.total > 0 ? (stats.evaluados / stats.total) * 100 : 0} />
            {FASES.map((f) => {
              const fItems = detail.items.filter((i) => i.fase === f);
              const ev = fItems.filter((i) => i.scorePct !== '0' || i.nivelRubrica !== 'no_implementado').length;
              return <FaseChip key={f} activo={faseFiltro === f} onClick={() => setFaseFiltro(f)} label={FASE_LABEL[f]} count={fItems.length} progreso={fItems.length > 0 ? (ev / fItems.length) * 100 : 0} />;
            })}
          </nav>
        </aside>

        {/* Centro: lista estándares */}
        <section aria-label="Lista de estándares" className="min-w-0">
          <div className="relative mb-3">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por código o nombre…" className="control w-full !pl-9" />
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-tertiary)]" />
          </div>
          <div className={`${CARD} overflow-hidden`}>
            {itemsVisibles.length === 0
              ? <p className="p-6 text-center text-sm text-[color:var(--color-text-tertiary)]">Sin estándares para los filtros activos.</p>
              : itemsVisibles.map((it) => <FilaEstandar key={it.estandarId} item={it} onOpen={() => setDrawerEstandarId(it.estandarId)} />)}
          </div>
        </section>

        {/* Panel der: próximos pasos */}
        <aside aria-label="Resumen y próximos pasos" className="lg:sticky lg:top-24 lg:self-start">
          <div className={`${CARD} p-4`}>
            <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Próximos pasos</h3>
            <ul className="mt-3 space-y-2 text-xs">
              <li className="flex justify-between"><span className="text-[color:var(--color-text-secondary)]">Sin evaluar</span><span className="font-semibold tabular-nums text-[color:var(--color-text-primary)]">{stats.sinEvaluar}</span></li>
              <li className="flex justify-between"><span className="text-[color:var(--color-text-secondary)]">Sin evidencia</span><span className="font-semibold tabular-nums text-[color:var(--color-text-primary)]">{stats.sinEvidencia}</span></li>
              <li className="flex justify-between"><span className="text-[color:var(--color-text-secondary)]">Advertencias</span><span className="font-semibold tabular-nums text-[color:var(--kit-naranja-texto)]">{stats.advertencias}</span></li>
            </ul>
            {!isWorm && (
              <GradientButton type="button" variant="secondary" size="sm" onClick={abrirCierre} disabled={stats.evaluados === 0} className="mt-4 w-full justify-center">Ver preflight</GradientButton>
            )}
          </div>
        </aside>
      </div>

      <DiagnosticoEvaluacionDrawer
        open={drawerItem !== null}
        diagnosticoId={id}
        item={drawerItem}
        disabled={isWorm}
        onClose={() => setDrawerEstandarId(null)}
        onSaved={() => { load(); }}
      />

      <DiagnosticoCierreModal
        open={cierre !== null}
        diagnosticoId={id}
        preflight={cierre}
        anio={detail?.anio}
        onClose={() => setCierre(null)}
        onConfirm={confirmarCierre}
        onGoToStandard={(estandarId: number) => { setCierre(null); setDrawerEstandarId(estandarId); }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-componentes detalle
// ──────────────────────────────────────────────────────────────────────────
function ProgressBar({ evaluados, total, conEvidencia, advertencias }: { evaluados: number; total: number; conEvidencia: number; advertencias: number }) {
  const pct = total > 0 ? (evaluados / total) * 100 : 0;
  return (
    <div className="max-w-xl">
      <div className="h-2 overflow-hidden rounded-full bg-[color:var(--kit-hover)]" role="progressbar" aria-valuenow={evaluados} aria-valuemin={0} aria-valuemax={total} aria-label={`${evaluados} de ${total} estándares evaluados`}>
        <div className="h-full rounded-full bg-[color:var(--kit-azul)] transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[11px] text-[color:var(--color-text-tertiary)]">{evaluados}/{total} evaluados · {conEvidencia}/{total} con evidencia · <span className="font-semibold text-[color:var(--kit-naranja-texto)]">{advertencias} advertencias</span></p>
    </div>
  );
}

function FaseChip({ activo, onClick, label, count, progreso }: { activo: boolean; onClick: () => void; label: string; count: number; progreso: number }) {
  const estado = activo
    ? 'border-[color:var(--kit-azul)] bg-[color:var(--kit-hover)] text-[color:var(--color-text-primary)]'
    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--kit-hover)]';
  return (
    <button onClick={onClick} className={`flit-focus w-full rounded-[9px] border p-2.5 text-left transition-colors sm:w-auto lg:w-full ${estado}`} aria-pressed={activo}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label} <span className="text-[color:var(--color-text-tertiary)]">({count})</span></span>
        <span className="text-[10px] tabular-nums text-[color:var(--color-text-tertiary)]">{progreso.toFixed(0)}%</span>
      </div>
    </button>
  );
}

const DOT_NIVEL: Record<NivelRubrica, string> = {
  no_implementado: 'bg-[color:var(--color-text-tertiary)]', en_desarrollo: 'bg-[color:var(--kit-naranja)]',
  implementado: 'bg-[color:var(--kit-azul)]', sostenido: 'bg-[color:var(--kit-verde)]',
};
function FilaEstandar({ item, onOpen }: { item: ItemDetail; onOpen: () => void }) {
  const evCount = item.evidencias.length;
  return (
    <button onClick={onOpen} className="flit-focus flex w-full items-center gap-3 border-b border-[color:var(--color-border)] px-4 py-3 text-left transition-colors last:border-0 hover:bg-[color:var(--kit-hover)]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_NIVEL[item.nivelRubrica]}`} aria-hidden="true" />
      <span className="w-14 shrink-0 truncate text-[11px] font-semibold tabular-nums text-[color:var(--color-text-tertiary)] sm:w-20">{item.codigo}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--color-text-primary)]">{item.nombre}</span>
      <span className="hidden items-center gap-2 text-[11px] text-[color:var(--color-text-tertiary)] md:flex">
        <span>{evCount} evidencia{evCount === 1 ? '' : 's'}</span>
        {item.comentarios && <span title="Con comentario" className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--kit-azul)]" aria-label="con comentario" />}
      </span>
      <ArrowRightIcon className="h-4 w-4 shrink-0 text-[color:var(--color-text-tertiary)]" />
    </button>
  );
}

// Helpers ────────────────────────────────────────────────────────────────
function computeStats(items: ItemDetail[]) {
  let evaluados = 0, conEvidencia = 0, advertencias = 0;
  for (const it of items) {
    if (it.nivelRubrica !== 'no_implementado' || parseFloat(it.scorePct) > 0) evaluados += 1;
    if (it.evidencias.length > 0) conEvidencia += 1;
    if (it.nivelRubrica === 'en_desarrollo' && (!it.comentarios || it.comentarios.trim().length < 10)) advertencias += 1;
  }
  return { total: items.length, evaluados, conEvidencia, advertencias, sinEvaluar: items.length - evaluados, sinEvidencia: items.length - conEvidencia };
}
function filterItems(items: ItemDetail[], fase: FasePhva | null, search: string) {
  const q = search.trim().toLowerCase();
  return items.filter((it) => {
    if (fase && it.fase !== fase) return false;
    if (q && !it.codigo.toLowerCase().includes(q) && !it.nombre.toLowerCase().includes(q)) return false;
    return true;
  });
}
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d <= 0) return 'hoy'; if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d}d`;
  const m = Math.floor(d / 30);
  if (m < 12) return `hace ${m}m`;
  return `hace ${Math.floor(m / 12)}a`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
