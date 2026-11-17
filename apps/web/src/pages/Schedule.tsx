import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import Placa from '../components/flit/Placa';

interface ScheduleRow {
  id: number;
  vehicleId: number;
  plate: string | null;
  alias: string | null;
  routineNombre: string | null;
  jobNombre: string | null;
  fechaProgramada: string;
  medicionProgramada: number | null;
  tipo: 'manual' | 'automatica';
  estado: 'pendiente' | 'ejecutada' | 'vencida' | 'cancelada';
  notas: string | null;
}

const ESTADO_FILTERS = ['pendiente', 'ejecutada', 'vencida', 'cancelada'] as const;

export default function Schedule() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('maintenance.inicio.administrar');
  const [items, setItems] = useState<ScheduleRow[]>([]);
  const [estado, setEstado] = useState('pendiente');
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      const r = await api.get<{ data: ScheduleRow[] }>(`/maintenance/schedule${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [estado]);
  useEffect(() => { load(); }, [load]);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const r = await api.post<{ stats: { schedules_creados: number; schedules_actualizados: number; vencidas_marcadas: number } }>('/maintenance/schedule/recompute');
      toast.success(`Schedule recalculado: ${r.stats.schedules_creados} nuevos, ${r.stats.schedules_actualizados} actualizados`);
      load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setRecomputing(false); }
  };

  const cancel = async (id: number) => {
    if (!confirm('¿Cancelar esta programación?')) return;
    try { await api.patch(`/maintenance/schedule/${id}/cancel`); toast.success('Cancelado'); load(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const columnas: ColumnaTabla<ScheduleRow>[] = [
    {
      key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo',
      render: (s) => (
        <>
          <Link to={`/fleet/${s.vehicleId}`} className="flit-focus inline-flex rounded-[9px] font-semibold text-[color:var(--color-text-primary)] transition-colors hover:underline">
            {s.plate ? <Placa placa={s.plate} formatear={false} /> : `#${s.vehicleId}`}
          </Link>
          {s.alias && <p className="text-[11px] text-[color:var(--color-text-tertiary)]">{s.alias}</p>}
        </>
      ),
    },
    { key: 'mantenimiento', header: 'Mantenimiento', etiqueta: 'Mantenimiento', render: (s) => <span className="text-[color:var(--color-text-secondary)]">{s.routineNombre || s.jobNombre || '—'}</span> },
    { key: 'fecha', header: 'Fecha', etiqueta: 'Fecha', render: (s) => <span className="text-[color:var(--color-text-secondary)]">{s.fechaProgramada}</span> },
    { key: 'medicion', header: 'Medición', etiqueta: 'Medición', render: (s) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{s.medicionProgramada ? `${s.medicionProgramada} km` : '—'}</span> },
    { key: 'origen', header: 'Origen', etiqueta: 'Origen', render: (s) => <span className="text-[11px] capitalize text-[color:var(--color-text-tertiary)]">{s.tipo}</span> },
    {
      key: 'acciones', header: '', acciones: true, align: 'right',
      render: (s) => (s.estado === 'pendiente' && isAdmin ? (
        <GradientButton type="button" variant="alerta" size="sm" onClick={() => cancel(s.id)}>Cancelar</GradientButton>
      ) : null),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Programación de mantenimiento"
        subtitle="Calculado automáticamente cada día a las 6:15 AM por las rutinas y mediciones"
        icono="flito-mantenimiento"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }]}
        actions={isAdmin ? (
          <GradientButton type="button" variant="secondary" onClick={recompute} disabled={recomputing}>
            {recomputing ? 'Recalculando…' : 'Recalcular ahora'}
          </GradientButton>
        ) : undefined}
      />

      <div className="capitalize">
        <FiltroSegmentado
          ariaLabel="Estado de la programación"
          opciones={ESTADO_FILTERS.map((e) => ({ valor: e, etiqueta: e }))}
          valor={estado as (typeof ESTADO_FILTERS)[number]}
          onCambio={(e) => setEstado(e)}
        />
      </div>

      <DataTable
        ariaLabel="Programación de mantenimiento"
        columnas={columnas}
        filas={items}
        getKey={(s) => String(s.id)}
        emptyMessage="Sin programaciones en este estado"
      />
    </div>
  );
}
