import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import KpiCard from '../components/flit/KpiCard';
import { Accesos, ListaFila } from '../components/flit/Bloques';
import { Vacio } from '../components/flit/Cargador';

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

const ICONO_PROGRAMACION = 'flito-mantenimiento';
const ICONO_RUTINAS = 'flito-checklists';

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
      <PageHeaderCard title="Mantenimiento" subtitle="Programación, rutinas, repuestos e inventario" icono="flito-mantenimiento" />

      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Vencidas hoy" value={vencidasHoy} pendiente={vencidasHoy > 0} icono="flito-mantenimiento" />
        <KpiCard label="Próximas (7 días)" value={proximas7} pendiente={proximas7 > 0} icono="flito-mantenimiento" />
        <KpiCard label="Programadas (60 días)" value={schedule.length} icono="flito-mantenimiento" />
        <KpiCard label="Repuestos con stock bajo" value={lowStock.length} pendiente={lowStock.length > 0} icono="flito-repuestos" />
      </div>

      <Accesos
        items={[
          { to: '/maintenance/work-orders', titulo: 'Órdenes de trabajo', detalle: 'OT de taller, repuestos y cierre con inventario', icono: 'flito-ordenes-trabajo' },
          { to: '/maintenance/schedule', titulo: 'Programación', detalle: 'Calendario de mantenimiento preventivo', icono: ICONO_PROGRAMACION },
          { to: '/maintenance/routines', titulo: 'Rutinas', detalle: 'Catálogos de mantenimiento agrupado', icono: ICONO_RUTINAS },
          { to: '/parts', titulo: 'Repuestos e inventario', detalle: 'Stock por ubicación y kardex', icono: 'flito-repuestos' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title={`Programación próxima (${schedule.length})`}>
          {schedule.length === 0 ? (
            <Vacio texto="Sin programaciones en los próximos 60 días" icono="calendario" />
          ) : (
            <ListaFila
              filas={schedule.slice(0, 10).map((s) => {
                const dias = Math.round((new Date(s.fechaProgramada).getTime() - Date.now()) / 86_400_000);
                return {
                  id: String(s.id),
                  titulo: (
                    <Link to={`/fleet/${s.vehicleId}`} className={ENLACE}>
                      {s.plate || `#${s.vehicleId}`}
                    </Link>
                  ),
                  detalle: s.routineNombre || s.jobNombre || 'Mantenimiento',
                  extra: (
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <span className="mono text-xs text-[color:var(--color-text-tertiary)]">{s.fechaProgramada}</span>
                      <ExpiryPill dias={dias} />
                    </span>
                  ),
                };
              })}
            />
          )}
        </Section>

        <Section title={`Repuestos con stock bajo (${lowStock.length})`}>
          {lowStock.length === 0 ? (
            <Vacio texto="Sin repuestos por debajo del mínimo" icono="procesos" />
          ) : (
            <ListaFila
              filas={lowStock.slice(0, 10).map((p) => ({
                id: String(p.id),
                titulo: <Link to="/parts" className={ENLACE}>{p.codigo}</Link>,
                detalle: p.nombre,
                extra: (
                  <span className="shrink-0 text-xs">
                    <span className="font-semibold tabular-nums text-[color:var(--kit-rojo-texto)]">{Number(p.stockTotal)}</span>
                    <span className="text-[color:var(--color-text-tertiary)]"> / mín {Number(p.existenciaMin)} {p.unidadMedida}</span>
                  </span>
                ),
              }))}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

const ENLACE = 'flit-focus rounded-[4px] font-semibold text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-action)] hover:underline';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-5">
      <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
      {children}
    </section>
  );
}

function ExpiryPill({ dias }: { dias: number }) {
  if (dias <= 0) return <StatusChip tone="danger">Vencida</StatusChip>;
  if (dias <= 7) return <StatusChip tone="danger">{dias}d</StatusChip>;
  if (dias <= 30) return <StatusChip tone="warning">{dias}d</StatusChip>;
  return <StatusChip tone="success">{dias}d</StatusChip>;
}
