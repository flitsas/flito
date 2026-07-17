// TRAMITES-ABCD · Sprint A — panel admin de KPIs del epic TRAM-INNOV.
// Patrón RumSummary.tsx: guard admin, selector de ventana, tarjetas KPI + tablas FLIT.

import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';

interface MetricsResponse {
  ok: boolean;
  windowDays: number;
  preflight: { overall_status: string; n: number }[];
  tiempoTransito: { horas_mediana: number | null; n: number };
  rechazosOt: { rechazos: number; enviados: number };
  rechazosPorMotivo: { codigo: string; n: number }[];
  tipologias: { tipologia: string; n: number }[];
  notificaciones: { canal: string; n: number }[];
  portal: { rol: string; invitados: number; con_consentimiento: number }[];
  lotes: { lotes: number; filas: number; tramites_creados: number };
}

const DAY_OPTIONS = [7, 30, 90] as const;

const PREFLIGHT_TONE: Record<string, ChipTone> = { green: 'success', yellow: 'warning', red: 'danger' };
const PREFLIGHT_LABEL: Record<string, string> = { green: 'Verde', yellow: 'Amarillo', red: 'Rojo' };

const CARD = 'bg-white p-5';
const CARD_STYLE = { borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' } as const;

function KpiCard({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: ChipTone }) {
  const color = tone === 'success' ? 'var(--flit-success)' : tone === 'warning' ? 'var(--flit-warning)' : tone === 'danger' ? 'var(--flit-danger)' : 'var(--flit-text-primary)';
  return (
    <div className={CARD} style={CARD_STYLE}>
      <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums" style={{ color }}>{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>}
    </div>
  );
}

function MiniTable({ title, head, rows, empty }: { title: string; head: string[]; rows: (string | number)[][]; empty: string }) {
  return (
    <div className="overflow-x-auto bg-white" style={CARD_STYLE}>
      <p className="px-5 pt-4 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{title}</p>
      <table className="mt-2 w-full text-left text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            {head.map((h) => <th key={h} className="px-5 py-2.5 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={head.length} className="px-5 py-6 text-center" style={{ color: 'var(--flit-text-muted)' }}>{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              {r.map((c, j) => <td key={j} className="px-5 py-2.5 tabular-nums" style={{ color: j === 0 ? 'var(--flit-text-primary)' : 'var(--flit-text-secondary)' }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

export default function TramitesMetricas() {
  const { user } = useAuth();
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<MetricsResponse>(`/tramites/metrics/summary?days=${days}`);
      setData(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el resumen de métricas');
      setData(null);
    } finally { setLoading(false); }
  }, [days]);

  useEffect(() => { if (user?.role !== 'admin') return; load(); }, [user?.role, load]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const preflightTotal = data?.preflight.reduce((s, p) => s + p.n, 0) ?? 0;
  const preflightVerde = data?.preflight.find((p) => p.overall_status === 'green')?.n ?? 0;
  const rechazos = data?.rechazosOt.rechazos ?? 0;
  const enviados = data?.rechazosOt.enviados ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeaderCard
        title="Métricas de trámites"
        subtitle={`KPIs del epic TRAM-INNOV · ventana ${days} días`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {DAY_OPTIONS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium transition-colors"
                style={{ borderColor: days === d ? 'var(--flit-blue)' : 'var(--flit-border-input)', background: days === d ? 'var(--flit-blue-soft)' : 'white', color: days === d ? 'var(--flit-blue)' : 'var(--flit-text-secondary)' }}>
                {d} días
              </button>
            ))}
            <button type="button" onClick={() => load()} disabled={loading}
              className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              {loading ? 'Cargando…' : 'Actualizar'}
            </button>
          </div>
        }
      />

      {error && (
        <p className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger)' }}>{error}</p>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Pre-vuelo en verde" value={loading ? '·' : pct(preflightVerde, preflightTotal)} hint={`${preflightVerde}/${preflightTotal} pre-vuelos`} tone="success" />
        <KpiCard label="Mediana wizard → tránsito" value={loading ? '·' : data?.tiempoTransito.horas_mediana != null ? `${data.tiempoTransito.horas_mediana} h` : '—'} hint={`${data?.tiempoTransito.n ?? 0} enviados`} tone="neutral" />
        <KpiCard label="Rechazo OT" value={loading ? '·' : pct(rechazos, enviados)} hint={`${rechazos} de ${enviados} enviados`} tone={rechazos > 0 ? 'warning' : 'success'} />
        <KpiCard label="Trámites en lote" value={loading ? '·' : String(data?.lotes.tramites_creados ?? 0)} hint={`${data?.lotes.lotes ?? 0} lote(s) · ${data?.lotes.filas ?? 0} filas`} tone="neutral" />
      </div>

      {/* Tablas */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MiniTable
          title="Pre-vuelo por resultado"
          head={['Estado', 'Trámites']}
          rows={(data?.preflight ?? []).map((p) => [PREFLIGHT_LABEL[p.overall_status] ?? p.overall_status, p.n])}
          empty="Sin pre-vuelos en la ventana"
        />
        <MiniTable
          title="Rechazos OT por motivo"
          head={['Motivo', 'Casos']}
          rows={(data?.rechazosPorMotivo ?? []).map((m) => [m.codigo, m.n])}
          empty="Sin rechazos tipificados en la ventana"
        />
        <MiniTable
          title="Adopción por tipología"
          head={['Tipología', 'Trámites']}
          rows={(data?.tipologias ?? []).map((t) => [t.tipologia, t.n])}
          empty="Sin trámites en la ventana"
        />
        <MiniTable
          title="Notificaciones por canal"
          head={['Canal', 'Enviadas']}
          rows={(data?.notificaciones ?? []).map((n) => [n.canal, n.n])}
          empty="Sin notificaciones en la ventana"
        />
        <MiniTable
          title="Portal externo (Ley 1581)"
          head={['Rol', 'Invitados', 'Consentimiento', '%']}
          rows={(data?.portal ?? []).map((p) => [p.rol, p.invitados, p.con_consentimiento, pct(p.con_consentimiento, p.invitados)])}
          empty="Sin participantes en la ventana"
        />
      </div>

      {/* Semáforo pre-vuelo (chips FLIT) */}
      {(data?.preflight.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Distribución pre-vuelo:</span>
          {data!.preflight.map((p) => (
            <StatusChip key={p.overall_status} tone={PREFLIGHT_TONE[p.overall_status] ?? 'neutral'}>
              {PREFLIGHT_LABEL[p.overall_status] ?? p.overall_status}: {p.n}
            </StatusChip>
          ))}
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Solo agregados — sin datos personales. Fuente: tablas del epic TRAM-INNOV (§11). Baseline al merge de A1, remedir a 30/60 días.
      </p>
    </div>
  );
}
