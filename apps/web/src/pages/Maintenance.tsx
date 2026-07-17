import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';

interface ScheduleRow {
  id: number;
  vehicleId: number;
  plate: string | null;
  alias: string | null;
  routineNombre: string | null;
  jobNombre: string | null;
  fechaProgramada: string;
  estado: 'pendiente' | 'ejecutada' | 'vencida' | 'cancelada';
}

interface PartLowStock {
  id: number; codigo: string; nombre: string;
  existenciaMin: string; stockTotal: string; unidadMedida: string;
}

type KpiTone = 'neutral' | 'warning' | 'danger';

export default function Maintenance() {
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [lowStock, setLowStock] = useState<PartLowStock[]>([]);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const in60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
      const [s, p] = await Promise.all([
        api.get<{ data: ScheduleRow[] }>(`/maintenance/schedule?desde=${today}&hasta=${in60}&estado=pendiente`),
        api.get<{ data: PartLowStock[] }>('/parts?conStockBajo=1'),
      ]);
      setSchedule(s.data); setLowStock(p.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const today = new Date().toISOString().slice(0, 10);
  const vencidasHoy = schedule.filter((s) => s.fechaProgramada <= today).length;
  const proximas7 = schedule.filter((s) => {
    const dias = Math.round((new Date(s.fechaProgramada).getTime() - Date.now()) / 86_400_000);
    return dias > 0 && dias <= 7;
  }).length;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Mantenimiento" subtitle="Programación, rutinas, repuestos e inventario" />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile label="Vencidas hoy" value={vencidasHoy} tone="danger" />
        <KpiTile label="Próximas (7 días)" value={proximas7} tone="warning" />
        <KpiTile label="Programadas (60 días)" value={schedule.length} tone="neutral" />
        <KpiTile label="Repuestos con stock bajo" value={lowStock.length} tone="danger" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <ActionCard to="/maintenance/work-orders" label="Órdenes de trabajo" desc="OT de taller, repuestos y cierre con inventario" />
        <ActionCard to="/maintenance/schedule" label="Programación" desc="Calendario de mantenimiento preventivo" />
        <ActionCard to="/maintenance/routines" label="Rutinas" desc="Catálogos de mantenimiento agrupado" />
        <ActionCard to="/parts" label="Repuestos e inventario" desc="Stock por ubicación y kardex" />
      </div>

      <Section title={`Programación próxima (${schedule.length})`}>
        {schedule.length === 0 ? (
          <Empty msg="Sin programaciones en los próximos 60 días" />
        ) : (
          <ul className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
            {schedule.slice(0, 10).map((s, i) => {
              const dias = Math.round((new Date(s.fechaProgramada).getTime() - Date.now()) / 86_400_000);
              return (
                <li key={s.id} className="flex items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-[color:var(--flit-bg-app)]" style={i > 0 ? { borderTop: '1px solid var(--flit-border-soft)' } : undefined}>
                  <div>
                    <Link to={`/fleet/${s.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>
                      {s.plate || `#${s.vehicleId}`}
                    </Link>
                    <span className="ml-2" style={{ color: 'var(--flit-text-muted)' }}>— {s.routineNombre || s.jobNombre || 'Mantenimiento'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{s.fechaProgramada}</span>
                    <ExpiryPill dias={dias} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={`Repuestos con stock bajo (${lowStock.length})`}>
        {lowStock.length === 0 ? (
          <Empty msg="Sin repuestos por debajo del mínimo" />
        ) : (
          <ul className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
            {lowStock.slice(0, 10).map((p, i) => (
              <li key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={i > 0 ? { borderTop: '1px solid var(--flit-border-soft)' } : undefined}>
                <Link to="/parts" className="font-medium hover:underline" style={{ color: 'var(--flit-text-primary)' }}>
                  {p.codigo} <span className="font-normal" style={{ color: 'var(--flit-text-muted)' }}>— {p.nombre}</span>
                </Link>
                <span className="text-xs">
                  <span className="font-semibold" style={{ color: 'var(--flit-danger)' }}>{Number(p.stockTotal)}</span>
                  <span style={{ color: 'var(--flit-text-muted)' }}> / mín {Number(p.existenciaMin)} {p.unidadMedida}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: number; tone: KpiTone }) {
  const color = tone === 'warning' ? 'var(--flit-warning)' : tone === 'danger' ? 'var(--flit-danger)' : 'var(--flit-text-primary)';
  return (
    <div className="bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-4xl font-bold tabular-nums leading-none" style={{ color }}>{value}</p>
    </div>
  );
}

function ActionCard({ to, label, desc }: { to: string; label: string; desc: string }) {
  return (
    <Link to={to} className="flit-focus block bg-white p-5 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{desc}</p>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="p-6 text-center text-sm" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}>{msg}</div>;
}

function ExpiryPill({ dias }: { dias: number }) {
  if (dias <= 0) return <StatusChip tone="danger">Vencida</StatusChip>;
  if (dias <= 7) return <StatusChip tone="danger">{dias}d</StatusChip>;
  if (dias <= 30) return <StatusChip tone="warning">{dias}d</StatusChip>;
  return <StatusChip tone="success">{dias}d</StatusChip>;
}
