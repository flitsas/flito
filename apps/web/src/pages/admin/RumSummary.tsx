// HU #13589 (Feature #13416) — «Rendimiento» es el ítem `admin_rendimiento` de Administración: la guarda
// es la de la ruta (`ProtectedRoute page="admin_rendimiento"` en App.tsx), no un permiso suelto. Cuatro
// estados: cargando, error con reintento (sin el mensaje crudo del API), vacío y lleno.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import StatusChip from '../../components/flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../components/flit/flitPageKit';

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
const COLUMNAS = ['Métrica', 'Ruta', 'Dispositivo', 'Muestras', 'p75', 'Promedio', 'Desde', 'Hasta'] as const;

export const COPY_ERROR_RUM = 'No se pudo cargar el resumen de rendimiento. Revise su conexión y vuelva a intentarlo.';
export const COPY_VACIO_RUM = 'Todavía no hay grupos con suficientes muestras (mínimo 3 por métrica, ruta y dispositivo) en esta ventana. Pruebe con una ventana más larga.';

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
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(7);
  const [data, setData] = useState<RumSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await api.get<RumSummaryResponse>(`/rum/summary?days=${days}&min=3`);
      const groups = Array.isArray(r.groups)
        ? r.groups
        : (r.groups as { rows?: RumGroup[] })?.rows ?? [];
      setData({ ...r, groups });
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const grupos = data?.groups ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeaderCard
        title="Rendimiento en campo (RUM)"
        subtitle={`Percentil 75 de Core Web Vitals · ventana ${days} días · muestreo ~20% en producción`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FlitPillGroup>
              {DAY_OPTIONS.map((d) => (
                <FlitPillButton key={d} active={days === d} pressed={days === d} onClick={() => setDays(d)}>
                  {d} días
                </FlitPillButton>
              ))}
            </FlitPillGroup>
            <button type="button" onClick={() => void load()} disabled={loading} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              {loading ? 'Cargando…' : 'Actualizar'}
            </button>
          </div>
        }
      />

      {loading && (
        <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }} data-estado="cargando">Cargando métricas…</p>
      )}

      {!loading && error && (
        <FlitCard className="mx-auto w-full max-w-xl text-center">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{COPY_ERROR_RUM}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void load()}>Reintentar</button>
        </FlitCard>
      )}

      {!loading && !error && grupos.length === 0 && (
        <FlitEmpty>
          <p data-estado="vacio">{COPY_VACIO_RUM}</p>
          {data?.note && <p className="mt-2">{data.note}</p>}
        </FlitEmpty>
      )}

      {!loading && !error && grupos.length > 0 && (
        <>
          {data?.note && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{data.note}</p>}
          <FlitTable label="Resumen de rendimiento por métrica, ruta y dispositivo">
            <thead>
              <tr>{COLUMNAS.map((h) => <FlitTh key={h}>{h}</FlitTh>)}</tr>
            </thead>
            <tbody className="text-sm">
              {grupos.map((row, i) => (
                <FlitTr key={`${row.metric}-${row.route}-${row.device}-${i}`}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{row.metric}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{row.route}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-primary)' }}>{row.device}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{row.samples}</td>
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
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          {data && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Total filas en ventana: {data.totalRows} · umbral de agrupación: ≥{data.minSamples} muestras
            </p>
          )}
        </>
      )}
    </div>
  );
}
