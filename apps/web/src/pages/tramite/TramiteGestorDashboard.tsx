// TRAM-DASH-01 — KPIs del gestor (trámites creados por el usuario autenticado).

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';

interface GestorMetrics {
  ok: boolean;
  windowDays: number;
  totales: { creados: number; enviados: number; rechazados: number; activos: number };
  preflight: { overall_status: string; n: number }[];
  tipologias: { tipologia: string; n: number }[];
  tiempoTransito: { horas_mediana: number | null; n: number };
  rechazosPorMotivo: { codigo: string; n: number }[];
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

function pct(part: number, total: number) {
  if (!total) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

export default function TramiteGestorDashboard() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<GestorMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<GestorMetrics>(`/tramites/metrics/gestor?days=${days}`);
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const preflightTotal = data?.preflight.reduce((s, p) => s + p.n, 0) ?? 0;
  const preflightVerde = data?.preflight.find((p) => p.overall_status === 'green')?.n ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Métricas de <strong>tus trámites</strong> (creados por tu usuario). Sin datos de otros gestores.
        </p>
        <div className="flex gap-2">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
              style={{
                borderColor: days === d ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                background: days === d ? 'var(--flit-blue-soft)' : 'white',
                color: days === d ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando métricas…</p>
      ) : !data ? (
        <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>No se pudieron cargar las métricas.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Trámites creados" value={String(data.totales.creados)} hint={`Últimos ${data.windowDays} días`} />
            <KpiCard label="Enviados a tránsito" value={String(data.totales.enviados)} tone="success" />
            <KpiCard label="Activos (en curso)" value={String(data.totales.activos)} tone="warning" />
            <KpiCard label="Rechazados OT" value={String(data.totales.rechazados)} tone={data.totales.rechazados > 0 ? 'danger' : 'neutral'} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <KpiCard
              label="Pre-vuelo en verde"
              value={pct(preflightVerde, preflightTotal)}
              hint={preflightTotal ? `${preflightVerde}/${preflightTotal} pre-vuelos` : 'Sin pre-vuelos en el periodo'}
              tone="success"
            />
            <KpiCard
              label="Tiempo a tránsito (mediana)"
              value={data.tiempoTransito.horas_mediana != null ? `${data.tiempoTransito.horas_mediana} h` : '—'}
              hint={data.tiempoTransito.n ? `${data.tiempoTransito.n} envíos` : 'Sin envíos en el periodo'}
            />
            <div className={CARD} style={CARD_STYLE}>
              <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Tipologías usadas</p>
              {data.tipologias.length === 0 ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin tipologías en el periodo.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {data.tipologias.slice(0, 5).map((t) => (
                    <li key={t.tipologia} className="flex justify-between text-xs">
                      <span style={{ color: 'var(--flit-text-secondary)' }}>{t.tipologia.replace(/_/g, ' ')}</span>
                      <span className="font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{t.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {data.preflight.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.preflight.map((p) => (
                <StatusChip key={p.overall_status} tone={PREFLIGHT_TONE[p.overall_status] ?? 'neutral'}>
                  {PREFLIGHT_LABEL[p.overall_status] ?? p.overall_status}: {p.n}
                </StatusChip>
              ))}
            </div>
          )}

          {data.rechazosPorMotivo.length > 0 && (
            <div className={CARD} style={CARD_STYLE}>
              <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Rechazos OT por motivo</p>
              <ul className="mt-2 space-y-1">
                {data.rechazosPorMotivo.map((r) => (
                  <li key={r.codigo} className="flex justify-between text-xs">
                    <span style={{ color: 'var(--flit-text-secondary)' }}>{r.codigo}</span>
                    <span className="font-bold" style={{ color: 'var(--flit-danger)' }}>{r.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
