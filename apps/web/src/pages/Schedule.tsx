import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitTh, FlitTr, FlitTable, flitPillWrap, flitPillBtn } from '../components/flit/flitPageKit';

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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Programación de mantenimiento"
        subtitle="Calculado automáticamente cada día a las 6:15 AM por las rutinas y mediciones"
        actions={isAdmin ? (
          <button
            type="button"
            onClick={recompute}
            disabled={recomputing}
            className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-5 text-sm font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue)' }}
          >
            {recomputing ? 'Recalculando…' : 'Recalcular ahora'}
          </button>
        ) : undefined}
      />

      <div className="inline-flex w-fit flex-wrap gap-1 rounded-[999px] p-1" style={flitPillWrap}>
        {ESTADO_FILTERS.map((e) => (
          <button key={e} type="button" onClick={() => setEstado(e)} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold capitalize transition-colors" style={flitPillBtn(estado === e)}>{e}</button>
        ))}
      </div>

      <FlitTable>
        <table className="w-full text-sm">
          <thead><tr>
            <FlitTh>Vehículo</FlitTh><FlitTh>Mantenimiento</FlitTh><FlitTh>Fecha</FlitTh><FlitTh>Medición</FlitTh><FlitTh>Origen</FlitTh><FlitTh></FlitTh>
          </tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin programaciones en este estado</td></tr>}
            {items.map((s) => (
              <FlitTr key={s.id}>
                <td className="px-4 py-2.5">
                  <Link to={`/fleet/${s.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>
                    {s.plate || `#${s.vehicleId}`}
                  </Link>
                  {s.alias && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{s.alias}</p>}
                </td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{s.routineNombre || s.jobNombre || '—'}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{s.fechaProgramada}</td>
                <td className="px-4 py-2.5 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{s.medicionProgramada ? `${s.medicionProgramada} km` : '—'}</td>
                <td className="px-4 py-2.5 capitalize text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{s.tipo}</td>
                <td className="px-4 py-2.5 text-right">
                  {s.estado === 'pendiente' && isAdmin && (
                    <button type="button" onClick={() => cancel(s.id)} className="text-xs hover:underline" style={{ color: 'var(--flit-danger, #dc2626)' }}>Cancelar</button>
                  )}
                </td>
              </FlitTr>
            ))}
          </tbody>
        </table>
      </FlitTable>
    </div>
  );
}
