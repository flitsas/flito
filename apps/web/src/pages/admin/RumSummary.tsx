// HU #13589 (Feature #13416) — «Rendimiento» es el ítem `admin_rendimiento` de Administración: la guarda
// es la de la ruta (`ProtectedRoute page="admin_rendimiento"` en App.tsx), no un permiso suelto. Cuatro
// estados: cargando, error con reintento (sin el mensaje crudo del API), vacío y lleno.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import StatusChip from '../../components/flit/StatusChip';
import GradientButton from '../../components/flit/GradientButton';
import KpiCard from '../../components/flit/KpiCard';
import { Cargador, Vacio } from '../../components/flit/Cargador';
import { Icono } from '../../components/flit/kit/Icono';
import { FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr } from '../../components/flit/flitPageKit';

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
    <div className="flex flex-col">
      <PageHeaderCard
        title="Rendimiento en campo (RUM)"
        subtitle={`Percentil 75 de Core Web Vitals · ventana ${days} días · muestreo ~20% en producción`}
        icono="flito-reporte-costos"
        miga={[{ etiqueta: 'Administración' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FlitPillGroup>
              {DAY_OPTIONS.map((d) => (
                <FlitPillButton key={d} active={days === d} pressed={days === d} onClick={() => setDays(d)}>
                  {d} días
                </FlitPillButton>
              ))}
            </FlitPillGroup>
            <GradientButton variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? 'Cargando…' : 'Actualizar'}
            </GradientButton>
          </div>
        }
      />

      {loading && (
        <div className="card" data-estado="cargando"><Cargador texto="Cargando métricas…" /></div>
      )}

      {!loading && error && (
        <div className="card">
          <div className="kit-vacio" data-kit="error">
            <span className="kit-disco h-[72px] w-[72px] !text-[color:var(--kit-naranja)]"><Icono nombre="nube-alerta" size={36} /></span>
            <p role="alert" className="!text-[color:var(--color-text-primary)]">{COPY_ERROR_RUM}</p>
            <GradientButton variant="secondary" size="sm" onClick={() => void load()}>Reintentar</GradientButton>
          </div>
        </div>
      )}

      {!loading && !error && grupos.length === 0 && (
        <div className="card" data-estado="vacio">
          <Vacio icono="reportes" texto={COPY_VACIO_RUM} detalle={data?.note} />
        </div>
      )}

      {!loading && !error && grupos.length > 0 && (
        <>
          {data && (
            <div className="metricas">
              <KpiCard label="Total filas en ventana" value={data.totalRows} icono="flito-reporte-costos" />
              <KpiCard label="Umbral de agrupación" value={`≥${data.minSamples}`} hint="muestras" icono="flito-checklists" />
            </div>
          )}
          <section className="card">
            {data?.note && <p className="mb-3 text-sm text-[color:var(--color-text-secondary)]">{data.note}</p>}
            <FlitTable label="Resumen de rendimiento por métrica, ruta y dispositivo">
              <thead>
                <tr>{COLUMNAS.map((h) => <FlitTh key={h}>{h}</FlitTh>)}</tr>
              </thead>
              <tbody className="text-sm">
                {grupos.map((row, i) => (
                  <FlitTr key={`${row.metric}-${row.route}-${row.device}-${i}`}>
                    <td className="px-4 py-3 font-medium text-[color:var(--color-text-primary)]">{row.metric}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-text-secondary)]">{row.route}</td>
                    <td className="px-4 py-3 text-[color:var(--color-text-primary)]">{row.device}</td>
                    <td className="px-4 py-3 tabular-nums text-[color:var(--color-text-primary)]">{row.samples}</td>
                    <td className="px-4 py-3">
                      <StatusChip tone={p75Tone(row.metric, row.p75)}>
                        {formatMetricValue(row.metric, row.p75)}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-[color:var(--color-text-secondary)]">
                      {formatMetricValue(row.metric, row.avg)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-[color:var(--color-text-tertiary)]">
                      {row.first_at ? new Date(row.first_at).toLocaleString('es-CO') : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-[color:var(--color-text-tertiary)]">
                      {row.last_at ? new Date(row.last_at).toLocaleString('es-CO') : '—'}
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
          </section>
        </>
      )}
    </div>
  );
}
