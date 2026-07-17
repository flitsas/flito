import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import StatusChip from '../../components/flit/StatusChip';

interface RumGroup {
  metric: string;
  route: string;
  device: string;
  samples: number;
  p75: number | string;
  avg: number | string;
  first_at: string;
  last_at: string;
}

interface RumSummaryResponse {
  ok: boolean;
  windowDays: number;
  minSamples: number;
  totalRows: number;
  groups: RumGroup[];
  note?: string;
}

const DAY_OPTIONS = [7, 14, 30] as const;

function formatMetricValue(metric: string, raw: number | string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  if (metric === 'CLS') return n.toFixed(3);
  if (metric === 'INP' || metric === 'LCP' || metric === 'FCP' || metric === 'TTFB') {
    return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
  }
  return String(n);
}

function p75Tone(metric: string, raw: number | string): 'success' | 'warning' | 'danger' | 'neutral' {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'neutral';
  if (metric === 'LCP') {
    if (n <= 2500) return 'success';
    if (n <= 4000) return 'warning';
    return 'danger';
  }
  if (metric === 'INP') {
    if (n <= 200) return 'success';
    if (n <= 500) return 'warning';
    return 'danger';
  }
  if (metric === 'CLS') {
    if (n <= 0.1) return 'success';
    if (n <= 0.25) return 'warning';
    return 'danger';
  }
  return 'neutral';
}

export default function RumSummary() {
  const { user } = useAuth();
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(7);
  const [data, setData] = useState<RumSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<RumSummaryResponse>(`/rum/summary?days=${days}&min=3`);
      const groups = Array.isArray(r.groups)
        ? r.groups
        : (r.groups as { rows?: RumGroup[] })?.rows ?? [];
      setData({ ...r, groups });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'No se pudo cargar el resumen RUM';
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    load();
  }, [user?.role, load]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeaderCard
        title="Rendimiento en campo (RUM)"
        subtitle={`Percentil 75 de Core Web Vitals · ventana ${days} días · muestreo ~20% en producción`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium transition-colors"
                style={{
                  borderColor: days === d ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                  background: days === d ? 'var(--flit-blue-soft)' : 'white',
                  color: days === d ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
                }}
              >
                {d} días
              </button>
            ))}
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            >
              {loading ? 'Cargando…' : 'Actualizar'}
            </button>
          </div>
        }
      />

      {error && (
        <p className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger)' }}>
          {error}
        </p>
      )}

      {data?.note && !error && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{data.note}</p>
      )}

      <div
        className="overflow-x-auto bg-white"
        style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
      >
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
              {['Métrica', 'Ruta', 'Dispositivo', 'Muestras', 'p75', 'Promedio', 'Desde', 'Hasta'].map((h) => (
                <th key={h} className="px-4 py-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center" style={{ color: 'var(--flit-text-muted)' }}>
                  Cargando métricas…
                </td>
              </tr>
            )}
            {!loading && !error && (data?.groups?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center" style={{ color: 'var(--flit-text-muted)' }}>
                  Sin grupos con suficientes muestras (mín. 3 por métrica/ruta/dispositivo).
                </td>
              </tr>
            )}
            {!loading && data?.groups?.map((row, i) => (
              <tr
                key={`${row.metric}-${row.route}-${row.device}-${i}`}
                className="border-t"
                style={{ borderColor: 'var(--flit-border-soft)' }}
              >
                <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{row.metric}</td>
                <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{row.route}</td>
                <td className="px-4 py-3">{row.device}</td>
                <td className="px-4 py-3 tabular-nums">{row.samples}</td>
                <td className="px-4 py-3">
                  <StatusChip tone={p75Tone(row.metric, row.p75)}>
                    {formatMetricValue(row.metric, row.p75)}
                  </StatusChip>
                </td>
                <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
                  {formatMetricValue(row.metric, row.avg)}
                </td>
                <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--flit-text-muted)' }}>
                  {row.first_at ? new Date(row.first_at).toLocaleString('es-CO') : '—'}
                </td>
                <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--flit-text-muted)' }}>
                  {row.last_at ? new Date(row.last_at).toLocaleString('es-CO') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && !loading && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Total filas en ventana: {data.totalRows} · umbral de agrupación: ≥{data.minSamples} muestras
        </p>
      )}
    </div>
  );
}
