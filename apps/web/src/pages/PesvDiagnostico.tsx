// PESV Auto-diagnóstico PHVA · Workspace líder + listado anualidades.
// Capa visual FLIT (Fase 6A). Estructura/paneles/rúbrica, roles y aria-labels
// conservados (E2E pesv-diagnostico-*). Modales/drawer viven en components/pesv/*
// y NO se tocan en 6A.
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

// Input de búsqueda FLIT (local; no toca el inputCls compartido de components/pesv).
const searchCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white py-2.5 pl-9 pr-4 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

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
  const tone = score >= 80 ? 'var(--flit-success)' : score >= 60 ? 'var(--flit-warning)' : 'var(--flit-danger)';
  const relativeEdit = diag.updatedAt ? relativeTime(diag.updatedAt) : null;

  return (
    <button onClick={onOpen} className="flit-focus bg-white p-5 text-left transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]" style={CARD}>
      <div className="mb-3 flex items-start justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Año {diag.anio}</span>
        <StatusChip tone={diag.estado === 'cerrado' ? 'success' : 'active'}>{diag.estado}</StatusChip>
      </div>
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-bold" style={{ color: tone }}>{score.toFixed(1)}<span className="text-base font-normal" style={{ color: 'var(--flit-text-muted)' }}>%</span></div>
        {delta !== null && delta !== 0 && (
          <span className="text-xs font-semibold" style={{ color: delta > 0 ? 'var(--flit-success)' : 'var(--flit-danger)' }}>{delta > 0 ? '+' : ''}{delta.toFixed(1)} pts</span>
        )}
      </div>
      <p className="mt-2 font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{diag.fecha}</p>
      {relativeEdit && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Última edición {relativeEdit}</p>}
      <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Abrir expediente <ArrowRightIcon /></span>
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto max-w-lg bg-white p-12 text-center" style={CARD}>
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }} aria-hidden="true">
        <ClipboardCheckIcon />
      </div>
      <h2 className="text-2xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Aún sin diagnósticos</h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>El expediente PESV inicia con la línea base anual. Cada estándar requerirá evidencia documental para ser válido ante auditor.</p>
      <div className="mt-6 flex justify-center">
        <GradientButton type="button" onClick={onCreate}>Crear primer diagnóstico</GradientButton>
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse bg-white motion-reduce:animate-none" style={CARD} />)}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// VISTA DETALLE — workspace líder con drawer + modal cierre
// ══════════════════════════════════════════════════════════════════════════
function DetalleDiagnostico({ id }: { id: number }) {
  const navigate = useNavigate();
  const { user } = useAuth();
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

  // Redirect compliance → /auditoria — el backend ya emite header X-Redirect-To,
  // pero `lib/api.ts` no lo intercepta. Manejamos el redirect aquí por rol.
  useEffect(() => {
    if (!user) return;
    if (user.role === 'compliance') navigate(`/pesv/diagnostico/${id}/auditoria`, { replace: true });
  }, [user, id, navigate]);

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

  if (loading) return <div className="mx-auto max-w-[1600px]"><div className="h-32 animate-pulse bg-white motion-reduce:animate-none" style={CARD} /></div>;
  if (!detail) return <div className="mx-auto max-w-[1600px]"><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Diagnóstico no encontrado.</p></div>;

  const drawerItem = drawerEstandarId !== null ? detail.items.find((i) => i.estandarId === drawerEstandarId) ?? null : null;

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* Migas */}
      <div className="mb-4 text-xs" style={{ color: 'var(--flit-text-muted)' }}><button onClick={() => navigate('/pesv/diagnostico')} className="transition-colors hover:underline" style={{ color: 'var(--flit-blue)' }}>PESV · Diagnóstico</button> / <span style={{ color: 'var(--flit-text-secondary)' }}>{detail.anio}</span></div>

      {isWorm && (
        <div className="mb-4 rounded-[12px] p-4" style={{ border: '1px solid rgba(240,90,53,0.30)', background: 'rgba(240,90,53,0.10)' }} role="status">
          <p className="text-sm font-medium" style={{ color: 'var(--flit-warning)' }}>Diagnóstico cerrado el {fmtDate(detail.cerradoAt)}. Vista solo lectura.</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Para vista auditor accesible al compliance officer, <button onClick={() => navigate(`/pesv/diagnostico/${id}/auditoria`)} className="hover:underline" style={{ color: 'var(--flit-blue)' }}>abrir modo auditoría</button>.</p>
        </div>
      )}

      {/* top-16 = topbar (<lg); en lg+ se suma --flit-navbar-height (FlitNavBar sticky). */}
      <header className="sticky top-16 z-10 mb-6 bg-white p-5 lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height))]" style={CARD}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-muted)' }}>PESV · Res. 40595/2022 · Nivel {detail.nivelEmpresa ?? 'avanzado'}</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
              Diagnóstico {detail.anio}
              <span className="ml-3 font-mono text-base font-normal" style={{ color: 'var(--flit-text-secondary)' }}>Score {parseFloat(detail.scoreGlobal).toFixed(1)}%</span>
            </h1>
            <ProgressBar evaluados={stats.evaluados} total={stats.total} conEvidencia={stats.conEvidencia} advertencias={stats.advertencias} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => navigate(`/pesv/diagnostico/${id}/auditoria`)} className="flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Ver como auditor</button>
            {!isWorm && (
              <button onClick={abrirCierre} disabled={stats.evaluados === 0} className="flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] px-4 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40" style={{ background: 'var(--flit-gradient-primary)' }} aria-label="Cerrar diagnóstico">
                <LockIcon /> Cerrar diagnóstico
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)_240px]">
        {/* Sidebar fases */}
        <aside aria-label="Filtros por fase PHVA">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-muted)' }}>Fases PHVA</h2>
          <nav className="flex flex-row flex-wrap gap-2 lg:flex-col">
            <FaseChip activo={faseFiltro === null} onClick={() => setFaseFiltro(null)} label="Todas" count={stats.total} progreso={stats.total > 0 ? (stats.evaluados / stats.total) * 100 : 0} />
            {FASES.map((f) => {
              const fItems = detail.items.filter((i) => i.fase === f);
              const ev = fItems.filter((i) => i.scorePct !== '0' || i.nivelRubrica !== 'no_implementado').length;
              return <FaseChip key={f} activo={faseFiltro === f} onClick={() => setFaseFiltro(f)} label={FASE_LABEL[f]} count={fItems.length} progreso={fItems.length > 0 ? (ev / fItems.length) * 100 : 0} />;
            })}
          </nav>
        </aside>

        {/* Centro: lista estándares */}
        <section aria-label="Lista de estándares">
          <div className="relative mb-3">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por código o nombre…" className={searchCls} />
            <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-[color:var(--flit-text-muted)]" />
          </div>
          <div className="overflow-hidden bg-white" style={CARD}>
            {itemsVisibles.length === 0
              ? <p className="p-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin estándares para los filtros activos.</p>
              : itemsVisibles.map((it) => <FilaEstandar key={it.estandarId} item={it} onOpen={() => setDrawerEstandarId(it.estandarId)} />)}
          </div>
        </section>

        {/* Panel der: próximos pasos */}
        {/* Encadenado bajo el header sticky: topbar + navbar + 4rem (gap del header, antes top-32). */}
        <aside aria-label="Resumen y próximos pasos" className="lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height)_+_4rem)] lg:self-start">
          <div className="bg-white p-4" style={CARD}>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Próximos pasos</h3>
            <ul className="mt-3 space-y-2 text-xs">
              <li className="flex justify-between"><span style={{ color: 'var(--flit-text-secondary)' }}>Sin evaluar</span><span className="font-mono" style={{ color: 'var(--flit-text-primary)' }}>{stats.sinEvaluar}</span></li>
              <li className="flex justify-between"><span style={{ color: 'var(--flit-text-secondary)' }}>Sin evidencia</span><span className="font-mono" style={{ color: 'var(--flit-text-primary)' }}>{stats.sinEvidencia}</span></li>
              <li className="flex justify-between"><span style={{ color: 'var(--flit-text-secondary)' }}>Advertencias</span><span className="font-mono" style={{ color: 'var(--flit-warning)' }}>{stats.advertencias}</span></li>
            </ul>
            {!isWorm && (
              <button onClick={abrirCierre} disabled={stats.evaluados === 0} className="flit-focus mt-4 inline-flex h-9 w-full items-center justify-center rounded-[999px] border bg-white px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Ver preflight</button>
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
    <div className="mt-3 max-w-md">
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--flit-bg-app)' }} role="progressbar" aria-valuenow={evaluados} aria-valuemin={0} aria-valuemax={total} aria-label={`${evaluados} de ${total} estándares evaluados`}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: 'var(--flit-gradient-primary)' }} />
      </div>
      <p className="mt-1.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{evaluados}/{total} evaluados · {conEvidencia}/{total} con evidencia · <span style={{ color: 'var(--flit-warning)' }}>{advertencias} advertencias</span></p>
    </div>
  );
}

function FaseChip({ activo, onClick, label, count, progreso }: { activo: boolean; onClick: () => void; label: string; count: number; progreso: number }) {
  return (
    <button onClick={onClick} className="flit-focus w-full rounded-lg border p-2.5 text-left transition-colors" style={activo ? { borderColor: 'var(--flit-blue)', background: 'rgba(79,116,201,0.10)', color: 'var(--flit-text-primary)' } : { borderColor: 'var(--flit-border-soft)', background: '#fff', color: 'var(--flit-text-secondary)' }} aria-pressed={activo}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label} <span style={{ color: 'var(--flit-text-muted)' }}>({count})</span></span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{progreso.toFixed(0)}%</span>
      </div>
    </button>
  );
}

const DOT_NIVEL: Record<NivelRubrica, string> = {
  no_implementado: 'var(--flit-text-muted)', en_desarrollo: 'var(--flit-warning)',
  implementado: 'var(--flit-blue)', sostenido: 'var(--flit-success)',
};
function FilaEstandar({ item, onOpen }: { item: ItemDetail; onOpen: () => void }) {
  const evCount = item.evidencias.length;
  return (
    <button onClick={onOpen} className="flit-focus flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DOT_NIVEL[item.nivelRubrica] }} aria-hidden="true" />
      <span className="w-20 truncate font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{item.codigo}</span>
      <span className="flex-1 truncate text-sm" style={{ color: 'var(--flit-text-primary)' }}>{item.nombre}</span>
      <span className="hidden items-center gap-2 text-[11px] md:flex" style={{ color: 'var(--flit-text-muted)' }}>
        <span>{evCount} evidencia{evCount === 1 ? '' : 's'}</span>
        {item.comentarios && <span title="Con comentario" className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--flit-blue)' }} aria-label="con comentario" />}
      </span>
      <ArrowRightIcon className="h-4 w-4 text-[color:var(--flit-text-muted)]" />
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
