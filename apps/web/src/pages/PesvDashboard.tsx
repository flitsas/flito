import { useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';

interface Indicators {
  desde: string; hasta: string;
  accidentes: number; casi_accidentes: number; comparendos: number;
  lesionados: number; fatales: number; dias_perdidos_total: number;
  costo_total: number; km_recorridos: number;
  tasa_accidentalidad: number | null;
  tasa_lesionados: number | null;
  tasa_fatales: number | null;
  severidad: number | null;
  cumplimiento_documental_pct: number | null;
  capacitacion_pct: number | null;
  total_conductores: number;
  top_conductores: { userId: number; name: string; incidentes: number; fatales: number; victimas: number }[];
}

type KpiTone = 'danger' | 'warning' | 'accent' | 'success' | 'info';

const fmtCurrency = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const dateInput = 'flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const default90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [desde, setDesde] = useState(default90);
  const [hasta, setHasta] = useState(today);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/drivers/pesv-indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Tablero PESV" subtitle="Indicadores Res. 40595/2022" />

      <div className="flex flex-wrap items-end gap-3 bg-white p-4" style={CARD}>
        <div>
          <label className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={dateInput} />
        </div>
        <button onClick={load} className="flit-focus inline-flex h-[38px] items-center rounded-[999px] px-5 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Actualizar</button>
      </div>

      {!data ? <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Accidentes" value={String(data.accidentes)} hint={`${data.fatales} fatales · ${data.lesionados} lesionados`} tone="danger" />
            <Kpi label="Tasa accidentalidad" value={data.tasa_accidentalidad != null ? `${data.tasa_accidentalidad}` : '—'} hint="por millón de km" tone="warning" />
            <Kpi label="Severidad" value={data.severidad != null ? `${data.severidad}` : '—'} hint="días perdidos / accidente" tone="info" />
            <Kpi label="Tasa fatalidad" value={data.tasa_fatales != null ? `${data.tasa_fatales}` : '—'} hint="por millón de km" tone="accent" />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Conductores totales" value={String(data.total_conductores)} hint="activos PESV" tone="success" />
            <Kpi label="Cumplimiento documental" value={data.cumplimiento_documental_pct != null ? `${data.cumplimiento_documental_pct}%` : '—'} hint="docs vigentes >30d" tone={data.cumplimiento_documental_pct != null && data.cumplimiento_documental_pct < 80 ? 'danger' : 'success'} />
            <Kpi label="Capacitación anual" value={data.capacitacion_pct != null ? `${data.capacitacion_pct}%` : '—'} hint="con ≥1 capacitación" tone={data.capacitacion_pct != null && data.capacitacion_pct < 80 ? 'warning' : 'success'} />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Costo total" value={fmtCurrency(data.costo_total)} hint="incidentes en período" tone="danger" />
            <Kpi label="Km recorridos" value={data.km_recorridos.toLocaleString('es-CO')} hint="flota propia" tone="accent" />
            <Kpi label="Días perdidos" value={String(data.dias_perdidos_total)} hint="total accidentes" tone="warning" />
          </div>

          <Section title={`Top conductores con accidentes (${data.top_conductores.length})`}>
            {data.top_conductores.length === 0 ? (
              <Empty msg="Sin accidentes registrados en el período" />
            ) : (
              <div className="overflow-hidden bg-white" style={CARD}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr>
                      <Th>Conductor</Th><Th>Accidentes</Th><Th>Fatales</Th><Th>Víctimas</Th>
                    </tr></thead>
                    <tbody>
                      {data.top_conductores.map((c) => (
                        <tr key={c.userId} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-4 py-3"><Link to={`/pesv/conductores/${c.userId}`} className="font-semibold transition-colors hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</Link></td>
                          <td className="px-4 py-3"><StatusChip tone="danger">{c.incidentes}</StatusChip></td>
                          <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{c.fatales}</td>
                          <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{c.victimas}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>

          <Section title="Otros eventos">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="bg-white p-5" style={CARD}>
                <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Casi-accidentes</p>
                <p className="mt-1 text-3xl font-bold" style={{ color: 'var(--flit-warning)' }}>{data.casi_accidentes}</p>
              </div>
              <div className="bg-white p-5" style={CARD}>
                <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Comparendos</p>
                <p className="mt-1 text-3xl font-bold" style={{ color: 'var(--flit-blue)' }}>{data.comparendos}</p>
              </div>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

const TONE_COLOR: Record<KpiTone, string> = {
  danger: 'var(--flit-danger)', warning: 'var(--flit-warning)', accent: 'var(--flit-blue)',
  success: 'var(--flit-success)', info: 'var(--flit-blue)',
};

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: KpiTone }) {
  return (
    <div className="bg-white p-5" style={CARD}>
      <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums" style={{ color: TONE_COLOR[tone] }}>{value}</p>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</h2>{children}</section>;
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="p-6 text-center text-sm" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}>{msg}</div>;
}
