import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';

interface Indicators {
  desde: string; hasta: string;
  conductores_activos: number;
  inspecciones: { realizadas: number; esperadas: number; dias_laborales: number; pct: number | null; no_aptos: number };
  alcoholimetria: { total: number; positivos: number; positivos_pct: number | null; alerta_umbral: boolean };
  simulacros: { ejecutados_anio: number; meta_anual: number; cumple: boolean };
  top_conductores_no_aptos: { userId: number; name: string; noAptos: number }[];
  top_vehiculos_no_aptos: { vehicleId: number; plate: string | null; noAptos: number }[];
}

type KpiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const dateInput = 'flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow';

export default function OperationalIndicators() {
  const today = new Date().toISOString().slice(0, 10);
  const default30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [desde, setDesde] = useState(default30);
  const [hasta, setHasta] = useState(today);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/drivers/operational-indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Indicadores operacionales PESV"
        subtitle="Inspecciones preoperacionales, alcoholimetría y simulacros"
      />

      <div className="flex flex-wrap items-end gap-3 bg-white p-4" style={CARD}>
        <div>
          <label className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Desde</label>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Hasta</label>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={dateInput} />
        </div>
        <GradientButton type="button" onClick={load}>Actualizar</GradientButton>
      </div>

      {!data ? <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Inspecciones realizadas" value={String(data.inspecciones.realizadas)} hint={`de ${data.inspecciones.esperadas} esperadas`} tone="neutral" />
            <Kpi
              label="% inspecciones"
              value={data.inspecciones.pct != null ? `${data.inspecciones.pct}%` : '—'}
              hint={`${data.inspecciones.dias_laborales} días lab × ${data.conductores_activos} conductores`}
              tone={data.inspecciones.pct != null && data.inspecciones.pct < 80 ? 'danger' : 'success'}
            />
            <Kpi label="No-aptos" value={String(data.inspecciones.no_aptos)} hint="checklists con falla crítica" tone="danger" />
            <Kpi label="Conductores activos" value={String(data.conductores_activos)} hint="con es_conductor=true" tone="info" />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Pruebas alcoholimetría" value={String(data.alcoholimetria.total)} hint="en el período" tone="neutral" />
            <Kpi
              label="Positivos"
              value={`${data.alcoholimetria.positivos}`}
              hint={data.alcoholimetria.positivos_pct != null ? `${data.alcoholimetria.positivos_pct}% del total` : 'sin datos'}
              tone={data.alcoholimetria.alerta_umbral ? 'danger' : 'success'}
            />
            <Kpi
              label="Simulacros (año actual)"
              value={`${data.simulacros.ejecutados_anio}/${data.simulacros.meta_anual}`}
              hint={data.simulacros.cumple ? 'meta cumplida' : 'meta pendiente'}
              tone={data.simulacros.cumple ? 'success' : 'warning'}
            />
          </div>

          <Section title={`Top conductores con checklists no-apto (${data.top_conductores_no_aptos.length})`}>
            {data.top_conductores_no_aptos.length === 0 ? (
              <Empty msg="Sin checklists no-apto en el período" />
            ) : (
              <div className="overflow-hidden bg-white" style={CARD}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr>
                      <Th>Conductor</Th><Th>No-aptos</Th>
                    </tr></thead>
                    <tbody>
                      {data.top_conductores_no_aptos.map((c) => (
                        <tr key={c.userId} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-4 py-3"><Link to={`/pesv/conductores/${c.userId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</Link></td>
                          <td className="px-4 py-3"><StatusChip tone="danger">{c.noAptos}</StatusChip></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>

          <Section title={`Top vehículos con checklists no-apto (${data.top_vehiculos_no_aptos.length})`}>
            {data.top_vehiculos_no_aptos.length === 0 ? (
              <Empty msg="Sin vehículos con checklists no-apto en el período" />
            ) : (
              <div className="overflow-hidden bg-white" style={CARD}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr>
                      <Th>Vehículo</Th><Th>No-aptos</Th>
                    </tr></thead>
                    <tbody>
                      {data.top_vehiculos_no_aptos.map((v) => (
                        <tr key={v.vehicleId} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-4 py-3"><Link to={`/fleet/${v.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{v.plate || `#${v.vehicleId}`}</Link></td>
                          <td className="px-4 py-3"><StatusChip tone="danger">{v.noAptos}</StatusChip></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

const TONE_COLOR: Record<KpiTone, string> = {
  neutral: 'var(--flit-text-primary)',
  success: 'var(--flit-success)',
  warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)',
  info: 'var(--flit-info)',
};

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: KpiTone }) {
  return (
    <div className="bg-white p-5" style={CARD}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-3xl font-bold leading-none tabular-nums tracking-tight" style={{ color: TONE_COLOR[tone] }}>{value}</p>
      <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</h2>{children}</section>;
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="bg-white p-6 text-center text-sm" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>{msg}</div>;
}
