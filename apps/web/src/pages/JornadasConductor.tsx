import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import { IconClose } from '../components/flit/icons';

interface Jornada {
  id: number;
  conductorId: number;
  vehicleId: number | null;
  inicioAt: string;
  finAt: string | null;
  horasConduccion: string | null;
  horasDescansoPre: string | null;
  cerrada: boolean;
  cerradaAutomatica: boolean;
}
interface Alarma {
  id: number;
  jornadaId: number;
  tipo: 'mas_4h_continuas' | 'mas_10h_jornada' | 'menos_8h_descanso' | 'mas_60h_semanal' | 'sin_pausa_obligatoria';
  valorObservado: string;
  valorLimite: string;
  unidad: string;
  ackAt: string | null;
  generadaAt: string;
}
interface Detalle extends Jornada {
  pausas: { id: number; motivo: string; inicioAt: string; finAt: string | null; duracionMin: number | null }[];
  alarmas: Alarma[];
}

const ALARMA_LABEL: Record<Alarma['tipo'], string> = {
  mas_4h_continuas: 'Más de 4h continuas sin pausa',
  mas_10h_jornada: 'Jornada total > 10h',
  menos_8h_descanso: 'Descanso entre jornadas < 8h',
  mas_60h_semanal: 'Semana > 60h',
  sin_pausa_obligatoria: 'Sin pausa obligatoria (15min cada 2h)',
};

const inputCls = 'flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function JornadasConductor() {
  const [items, setItems] = useState<Jornada[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ from: '', to: '', conductorId: '' });
  const [selected, setSelected] = useState<Detalle | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.from) params.set('from', filter.from);
      if (filter.to) params.set('to', filter.to);
      if (filter.conductorId) params.set('conductorId', filter.conductorId);
      const r = await api.get<{ data: Jornada[] }>('/jornadas' + (params.toString() ? '?' + params.toString() : ''));
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter]);

  const openDetail = async (id: number) => {
    try {
      const r = await api.get<Detalle>(`/jornadas/${id}`);
      setSelected(r);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const ackAlarma = async (alarmaId: number) => {
    const obs = prompt('Observación (opcional):');
    try {
      await api.post(`/jornadas/alarmas/${alarmaId}/ack`, { observaciones: obs });
      toast.success('Alarma reconocida');
      if (selected) await openDetail(selected.id);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Control de jornada"
        subtitle="Decreto 1079/2015 art. 2.2.1.7.1.10 · Tope 10h/día, 60h/sem, 4h continuas, pausa 15min cada 2h"
      />

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className={inputCls} placeholder="Desde" />
        <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className={inputCls} placeholder="Hasta" />
        <input value={filter.conductorId} onChange={(e) => setFilter({ ...filter, conductorId: e.target.value })} className={inputCls} placeholder="ID conductor" />
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        {loading && <div className="p-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>ID</Th><Th>Conductor</Th><Th>Inicio</Th><Th>Fin</Th><Th>Horas</Th><Th>Estado</Th><Th>Acción</Th>
            </tr></thead>
            <tbody>
              {!loading && items.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin jornadas</td></tr>}
              {items.map((j) => (
                <tr key={j.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>#{j.id}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{j.conductorId}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{j.inicioAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{j.finAt?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                  <td className="px-4 py-3 text-xs font-medium tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{j.horasConduccion ?? '—'}</td>
                  <td className="px-4 py-3"><EstadoPill j={j} /></td>
                  <td className="px-4 py-3"><button onClick={() => openDetail(j.id)} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Ver</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <section className="bg-white p-5" style={CARD}>
          <div className="mb-4 flex items-start justify-between">
            <h2 className="text-lg font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>Jornada #{selected.id} · {selected.horasConduccion ?? '—'}h conducción</h2>
            <button onClick={() => setSelected(null)} aria-label="Cerrar detalle" className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ color: 'var(--flit-text-muted)' }}><IconClose className="h-5 w-5" /></button>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Conductor:</span> {selected.conductorId}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Vehículo:</span> {selected.vehicleId ?? '—'}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Inicio:</span> {selected.inicioAt}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Fin:</span> {selected.finAt ?? 'En curso'}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Descanso previo:</span> {selected.horasDescansoPre ?? '—'}h</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Cierre automático:</span> {selected.cerradaAutomatica ? 'sí' : 'no'}</div>
          </div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Pausas ({selected.pausas.length})</h3>
          {selected.pausas.length === 0 && <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin pausas registradas</p>}
          {selected.pausas.map((p) => (
            <div key={p.id} className="flex gap-3 border-b py-1 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <span className="font-mono" style={{ color: 'var(--flit-text-secondary)' }}>{p.inicioAt.slice(11, 16)} → {p.finAt?.slice(11, 16) ?? '...'}</span>
              <span className="capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{p.motivo}</span>
              {p.duracionMin && <span style={{ color: 'var(--flit-text-muted)' }}>{p.duracionMin}min</span>}
            </div>
          ))}
          <h3 className="mb-2 mt-4 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Alarmas ({selected.alarmas.length})</h3>
          {selected.alarmas.length === 0 && <p className="text-xs font-medium" style={{ color: 'var(--flit-success)' }}>Sin alarmas — cumple norma</p>}
          {selected.alarmas.map((a) => (
            <div key={a.id} className="mb-1 rounded-[12px] p-3" style={a.ackAt
              ? { border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }
              : { border: '1px solid rgba(228,61,48,0.30)', background: 'rgba(228,61,48,0.10)' }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>{ALARMA_LABEL[a.tipo]}</p>
                  <p className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>Observado: <strong>{a.valorObservado} {a.unidad}</strong> · Límite: {a.valorLimite} {a.unidad}</p>
                </div>
                {!a.ackAt && (
                  <button onClick={() => ackAlarma(a.id)} aria-label="Reconocer alarma" className="flit-focus rounded-[999px] px-3 py-1.5 text-[10px] font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-warning)' }}>Reconocer</button>
                )}
                {a.ackAt && <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Ack {a.ackAt.slice(0, 10)}</span>}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function EstadoPill({ j }: { j: Jornada }) {
  let tone: ChipTone = 'success';
  let label = 'Cerrada';
  if (!j.cerrada) { tone = 'active'; label = 'En curso'; }
  else if (j.cerradaAutomatica) { tone = 'warning'; label = 'Cierre auto'; }
  return <StatusChip tone={tone}>{label}</StatusChip>;
}
