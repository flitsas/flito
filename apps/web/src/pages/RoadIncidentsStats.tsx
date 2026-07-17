// Dashboard estadístico de siniestros — PESV Paso 21 + indicadores Res. 40595 anexo.
// Fuente: GET /api/drivers/incidents/stats con agregados precomputados en backend.
// Capa visual FLIT (Fase 6E1). Labels/títulos del gate pesv-stats-siniestros conservados.

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

interface Stats {
  periodo: { from: string; to: string };
  totales: {
    total: number; accidentes: number; casi: number; comparendos: number;
    fatales: number; graves: number; leves: number;
    victimas_total: number; dias_perdidos_total: number; costos_total: string;
    investigaciones: number; investigaciones_cerradas: number;
  };
  mensual: Array<{ mes: string; total: number; accidentes: number; graves_fatales: number; victimas: number }>;
  porCausa: Array<{ metodo: string; c: number }>;
  topConductores: Array<{ conductor_id: number; name: string | null; c: number; victimas: number }>;
  indicadoresPesv: { hht: number; frecuencia: number; severidad: number; indiceGravedad: number; formula: string };
}

type KpiTone = 'neutral' | 'danger' | 'warning' | 'info' | 'success';
const TONE_COLOR: Record<KpiTone, string> = {
  neutral: 'var(--flit-text-primary)', danger: 'var(--flit-danger)', warning: 'var(--flit-warning)', info: 'var(--flit-blue)', success: 'var(--flit-success)',
};
const dateInput = 'flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RoadIncidentsStats() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const r = await api.get<Stats>('/drivers/incidents/stats' + (params.toString() ? '?' + params.toString() : ''));
      setData(r);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [from, to]);

  if (loading) return <div className="p-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando estadísticas...</div>;
  if (!data) return null;

  const t = data.totales;
  const maxMes = Math.max(1, ...data.mensual.map((m) => m.total));
  const maxCausa = Math.max(1, ...data.porCausa.map((c) => c.c));
  const maxConductor = Math.max(1, ...data.topConductores.map((c) => c.c));
  const cierreInvestigacion = t.investigaciones > 0 ? (t.investigaciones_cerradas / t.investigaciones) * 100 : 0;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Estadística de siniestros viales"
        subtitle="PESV Paso 21 · Res. 40595/2022 · indicadores frecuencia + severidad + gravedad"
      />

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Desde</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label className="mb-1 block text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Hasta</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={dateInput} />
        </div>
        <span className="ml-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Periodo actual: {data.periodo.from} → {data.periodo.to}</span>
      </div>

      {/* KPIs principales */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Total" v={t.total} tone="neutral" />
        <Kpi label="Accidentes" v={t.accidentes} tone="danger" />
        <Kpi label="Casi accidentes" v={t.casi} tone="warning" />
        <Kpi label="Comparendos" v={t.comparendos} tone="info" />
        <Kpi label="Fatales" v={t.fatales} tone="danger" />
        <Kpi label="Víctimas" v={t.victimas_total} tone="warning" />
      </div>

      {/* Indicadores PESV anexo Res. 40595 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <PesvCard label="HHT (horas-hombre trabajadas)" v={data.indicadoresPesv.hht.toFixed(2)} sub="suma horas conducción cerradas" />
        <PesvCard label="Índice frecuencia" v={data.indicadoresPesv.frecuencia.toFixed(2)} sub="(accidentes × 200K) / HHT" />
        <PesvCard label="Índice severidad" v={data.indicadoresPesv.severidad.toFixed(2)} sub="(días perdidos × 200K) / HHT" />
        <PesvCard label="Índice gravedad" v={data.indicadoresPesv.indiceGravedad.toFixed(2)} sub="frecuencia × severidad / 1000" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Serie mensual */}
        <div className="bg-white p-5" style={CARD}>
          <h3 className="mb-4 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Incidentes por mes (12 meses)</h3>
          {data.mensual.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin datos en el periodo</p>}
          <div className="space-y-2">
            {data.mensual.map((m) => (
              <div key={m.mes} className="text-xs">
                <div className="mb-1 flex justify-between">
                  <span className="font-mono" style={{ color: 'var(--flit-text-secondary)' }}>{m.mes}</span>
                  <span style={{ color: 'var(--flit-text-muted)' }}>{m.total} total · {m.graves_fatales} graves · {m.victimas} víctimas</span>
                </div>
                <div className="flex h-3 gap-px overflow-hidden rounded-[999px]" style={{ background: 'var(--flit-bg-app)' }}>
                  <div style={{ width: `${(m.accidentes / maxMes) * 100}%`, background: 'var(--flit-danger)' }} title={`${m.accidentes} accidentes`} />
                  <div style={{ width: `${((m.total - m.accidentes) / maxMes) * 100}%`, background: 'var(--flit-warning)' }} title={`${m.total - m.accidentes} casi/comparendos`} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Por causa raíz */}
        <div className="bg-white p-5" style={CARD}>
          <h3 className="mb-4 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Por metodología de investigación</h3>
          {data.porCausa.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin investigaciones registradas en el periodo</p>}
          <div className="space-y-2">
            {data.porCausa.map((c) => (
              <div key={c.metodo} className="text-xs">
                <div className="mb-1 flex justify-between">
                  <span style={{ color: 'var(--flit-text-primary)' }}>{c.metodo.replace(/_/g, ' ')}</span>
                  <span className="font-mono font-semibold tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{c.c}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-[999px]" style={{ background: 'var(--flit-bg-app)' }}>
                  <div className="h-full rounded-[999px]" style={{ width: `${(c.c / maxCausa) * 100}%`, background: 'var(--flit-blue)' }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <p className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>Cobertura investigación causa raíz</p>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-3 flex-1 overflow-hidden rounded-[999px]" style={{ background: 'var(--flit-bg-app)' }}>
                <div className="h-full rounded-[999px]" style={{ width: `${cierreInvestigacion}%`, background: cierreInvestigacion >= 80 ? 'var(--flit-success)' : cierreInvestigacion >= 50 ? 'var(--flit-warning)' : 'var(--flit-danger)' }} />
              </div>
              <span className="font-mono text-xs font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{cierreInvestigacion.toFixed(0)}%</span>
            </div>
            <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{t.investigaciones_cerradas} cerradas / {t.investigaciones} con investigación / {t.total} total</p>
          </div>
        </div>

        {/* Top conductores */}
        <div className="bg-white p-5 md:col-span-2" style={CARD}>
          <h3 className="mb-4 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Top 10 conductores con más incidentes</h3>
          {data.topConductores.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin datos</p>}
          <table className="w-full text-sm">
            <thead><tr className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
              <th className="pb-2 text-left">Conductor</th>
              <th className="pb-2 text-right">Incidentes</th>
              <th className="pb-2 text-right">Víctimas</th>
              <th className="pb-2">Distribución</th>
            </tr></thead>
            <tbody>
              {data.topConductores.map((c) => (
                <tr key={c.conductor_id} className="border-b last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="py-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{c.name ?? `#${c.conductor_id}`}</td>
                  <td className="py-2 text-right font-mono text-xs font-semibold tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{c.c}</td>
                  <td className="py-2 text-right text-xs tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{c.victimas}</td>
                  <td className="w-1/2 py-2 pl-3">
                    <div className="h-2 overflow-hidden rounded-[999px]" style={{ background: 'var(--flit-bg-app)' }}>
                      <div className="h-full rounded-[999px]" style={{ width: `${(c.c / maxConductor) * 100}%`, background: 'var(--flit-danger)' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Fórmula: {data.indicadoresPesv.formula}</p>
    </div>
  );
}

function Kpi({ label, v, tone }: { label: string; v: number; tone: KpiTone }) {
  return (
    <div className="bg-white p-5" style={CARD}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight" style={{ color: TONE_COLOR[tone] }}>{v.toLocaleString('es-CO')}</div>
    </div>
  );
}

function PesvCard({ label, v, sub }: { label: string; v: string | number; sub: string }) {
  return (
    <div className="bg-white p-5" style={CARD}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <div className="mt-2 font-mono text-3xl font-bold tabular-nums tracking-tight" style={{ color: 'var(--flit-text-primary)' }}>{v}</div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{sub}</p>
    </div>
  );
}
