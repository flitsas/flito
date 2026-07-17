import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';

interface Indicators {
  desde: string; hasta: string; vehicleId: number | null;
  mtbf_dias_promedio: number | null;
  mttr_horas: number | null;
  costo_total: number;
  costo_por_km: number | null;
  km_recorridos: number;
  disponibilidad_pct: number;
  ots_cerradas: number;
  costo_por_sistema: { sistema: string; monto: number }[];
  ots_reincidentes: { vehicleId: number; plate: string | null; falla: string; ocurrencias: number }[];
  mtbf_por_vehiculo: { vehicleId: number; plate: string | null; mtbfDias: number | null; ots: number }[];
}

type KpiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const fmtCurrency = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });

function defaultRange(): { desde: string; hasta: string } {
  const hasta = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  return { desde, hasta };
}

const dateInput = 'flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow';

export default function MaintenanceIndicators() {
  const initial = defaultRange();
  const [desde, setDesde] = useState(initial.desde);
  const [hasta, setHasta] = useState(initial.hasta);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/maintenance/indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  const maxCostoSist = data ? Math.max(1, ...data.costo_por_sistema.map((s) => s.monto)) : 1;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Indicadores de mantenimiento" subtitle="MTBF, MTTR, costo por kilómetro y por sistema, disponibilidad y reincidencias" />

      <div className="flex flex-wrap items-end gap-3 bg-white p-4" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="MTBF promedio" value={data.mtbf_dias_promedio != null ? `${data.mtbf_dias_promedio} días` : '—'} hint="Tiempo entre fallas correctivas" tone="neutral" />
            <Kpi label="MTTR" value={data.mttr_horas != null ? `${data.mttr_horas} h` : '—'} hint="Tiempo medio de reparación" tone="warning" />
            <Kpi label="Disponibilidad" value={`${data.disponibilidad_pct}%`} hint="Tiempo fuera de taller" tone="success" />
            <Kpi label="OTs cerradas" value={String(data.ots_cerradas)} hint="En el período" tone="info" />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Costo total" value={fmtCurrency(data.costo_total)} hint="Mano de obra + repuestos + otros" tone="danger" />
            <Kpi label="Km recorridos" value={data.km_recorridos.toLocaleString('es-CO')} hint="MAX − MIN odómetro" tone="neutral" />
            <Kpi label="Costo por km" value={data.costo_por_km != null ? fmtCurrency(data.costo_por_km) : '—'} hint="costo total / km" tone="accent" />
          </div>

          <Section title={`Costo por sistema (${data.costo_por_sistema.length})`}>
            {data.costo_por_sistema.length === 0 ? (
              <Empty msg="Sin datos en el período" />
            ) : (
              <div className="space-y-3 bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
                {data.costo_por_sistema.map((s) => (
                  <div key={s.sistema}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{s.sistema}</span>
                      <span className="tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{fmtCurrency(s.monto)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-[999px]" style={{ background: 'var(--flit-bg-app)' }}>
                      <div className="h-2 rounded-[999px]" style={{ width: `${(s.monto / maxCostoSist) * 100}%`, background: 'var(--flit-gradient-primary)' }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={`OTs reincidentes (${data.ots_reincidentes.length})`}>
            {data.ots_reincidentes.length === 0 ? (
              <Empty msg="Sin reincidencias en el período" />
            ) : (
              <TableCard>
                <table className="w-full text-sm">
                  <thead><tr><Th>Vehículo</Th><Th>Falla</Th><Th>Ocurrencias</Th></tr></thead>
                  <tbody>
                    {data.ots_reincidentes.map((r, i) => (
                      <Tr key={i}>
                        <td className="px-4 py-2.5"><Link to={`/fleet/${r.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{r.plate || `#${r.vehicleId}`}</Link></td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{r.falla}</td>
                        <td className="px-4 py-2.5"><StatusChip tone="danger">{r.ocurrencias}</StatusChip></td>
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            )}
          </Section>

          <Section title={`MTBF por vehículo (${data.mtbf_por_vehiculo.length})`}>
            {data.mtbf_por_vehiculo.length === 0 ? (
              <Empty msg="Sin datos suficientes (se requieren al menos 2 OTs correctivas por vehículo)" />
            ) : (
              <TableCard>
                <table className="w-full text-sm">
                  <thead><tr><Th>Vehículo</Th><Th>MTBF</Th><Th>OTs correctivas</Th></tr></thead>
                  <tbody>
                    {data.mtbf_por_vehiculo.map((m) => (
                      <Tr key={m.vehicleId}>
                        <td className="px-4 py-2.5"><Link to={`/fleet/${m.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{m.plate || `#${m.vehicleId}`}</Link></td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{m.mtbfDias != null ? `${m.mtbfDias} días` : '—'}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{m.ots}</td>
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: KpiTone }) {
  const color: Record<KpiTone, string> = {
    neutral: 'var(--flit-text-primary)', success: 'var(--flit-success)', warning: 'var(--flit-warning)',
    danger: 'var(--flit-danger)', info: 'var(--flit-blue)', accent: 'var(--flit-blue)',
  };
  return (
    <div className="bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-3xl font-bold tabular-nums leading-none" style={{ color: color[tone] }}>{value}</p>
      <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</h2>{children}</section>;
}

function TableCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}><div className="overflow-x-auto">{children}</div></div>;
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>{children}</tr>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="p-6 text-center text-sm" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}>{msg}</div>;
}
