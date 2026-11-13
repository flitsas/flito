import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import PanelFiltros from '../components/flit/PanelFiltros';
import { EtiquetaEstado, Fichas } from '../components/flit/Bloques';
import { FlitCard, flitInp, flitBtnSecondarySm, flitBtnIconoSm } from '../components/flit/flitPageKit';
import { Icono } from '../components/flit/kit/Icono';
import '../components/fleet/estados-conductores';

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

  const fecha = (iso: string | null) => <span className="text-xs text-[color:var(--color-text-secondary)]">{iso ? iso.slice(0, 16).replace('T', ' ') : '—'}</span>;
  const columnas: ColumnaTabla<Jornada>[] = [
    { key: 'id', header: 'ID', render: (j) => <span className="mono text-xs text-[color:var(--color-text-secondary)]">#{j.id}</span> },
    { key: 'conductor', header: 'Conductor', render: (j) => <span className="text-xs text-[color:var(--color-text-secondary)]">{j.conductorId}</span> },
    { key: 'inicio', header: 'Inicio', render: (j) => fecha(j.inicioAt) },
    { key: 'fin', header: 'Fin', render: (j) => fecha(j.finAt) },
    { key: 'horas', header: 'Horas', render: (j) => <span className="text-xs font-medium tabular-nums text-[color:var(--color-text-primary)]">{j.horasConduccion ?? '—'}</span> },
    { key: 'estado', header: 'Estado', render: (j) => <EstadoPill j={j} /> },
    { key: 'accion', header: 'Acción', acciones: true, render: (j) => <button type="button" onClick={() => openDetail(j.id)} className={flitBtnSecondarySm}>Ver</button> },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Control de jornada"
        subtitle="Decreto 1079/2015 art. 2.2.1.7.1.10 · Tope 10h/día, 60h/sem, 4h continuas, pausa 15min cada 2h"
        icono="flito-jornadas"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
      />

      <FlitCard className="flex flex-col gap-4">
        <PanelFiltros
          busqueda={filter.conductorId}
          onBusqueda={(v) => setFilter({ ...filter, conductorId: v })}
          placeholder="ID conductor"
          campos={(
            <>
              <label className="campo">
                <span>Desde</span>
                <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className={flitInp} placeholder="Desde" />
              </label>
              <label className="campo">
                <span>Hasta</span>
                <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className={flitInp} placeholder="Hasta" />
              </label>
            </>
          )}
        />
        <DataTable
          ariaLabel="Jornadas"
          columnas={columnas}
          filas={items}
          getKey={(j) => String(j.id)}
          status={loading ? 'loading' : undefined}
          emptyMessage="Sin jornadas"
        />
      </FlitCard>

      {selected && (
        <FlitCard className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight text-[color:var(--color-action)]">Jornada #{selected.id} · {selected.horasConduccion ?? '—'}h conducción</h2>
            <button type="button" onClick={() => setSelected(null)} aria-label="Cerrar detalle" className={flitBtnIconoSm}><Icono nombre="cerrar" size={18} /></button>
          </div>
          <Fichas items={[
            { etiqueta: 'Conductor', valor: selected.conductorId },
            { etiqueta: 'Vehículo', valor: selected.vehicleId ?? '—' },
            { etiqueta: 'Inicio', valor: selected.inicioAt },
            { etiqueta: 'Fin', valor: selected.finAt ?? 'En curso' },
            { etiqueta: 'Descanso previo', valor: `${selected.horasDescansoPre ?? '—'}h` },
            { etiqueta: 'Cierre automático', valor: selected.cerradaAutomatica ? 'sí' : 'no' },
          ]} />
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[color:var(--color-text-primary)]">Pausas ({selected.pausas.length})</h3>
            {selected.pausas.length === 0 && <p className="text-xs text-[color:var(--color-text-tertiary)]">Sin pausas registradas</p>}
            {selected.pausas.map((p) => (
              <div key={p.id} className="flex flex-wrap gap-3 border-b border-[color:var(--color-border)] py-1.5 text-xs">
                <span className="mono text-[color:var(--color-text-secondary)]">{p.inicioAt.slice(11, 16)} → {p.finAt?.slice(11, 16) ?? '...'}</span>
                <span className="capitalize text-[color:var(--color-text-secondary)]">{p.motivo}</span>
                {p.duracionMin && <span className="text-[color:var(--color-text-tertiary)]">{p.duracionMin}min</span>}
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[color:var(--color-text-primary)]">Alarmas ({selected.alarmas.length})</h3>
            {selected.alarmas.length === 0 && <p className="text-xs font-medium text-[color:var(--kit-verde-texto)]">Sin alarmas — cumple norma</p>}
            <div className="flex flex-col gap-2">
              {selected.alarmas.map((a) => (
                <div key={a.id} className={a.ackAt
                  ? 'rounded-[9px] border border-[color:var(--color-border)] bg-[var(--kit-hover)] p-3'
                  : 'rounded-[9px] border border-[color:var(--kit-rojo)] bg-[color-mix(in_srgb,var(--kit-rojo)_10%,transparent)] p-3'}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <Icono nombre="alerta" size={18} className={a.ackAt ? 'shrink-0 text-[color:var(--color-text-tertiary)]' : 'shrink-0 text-[color:var(--kit-rojo-texto)]'} />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[color:var(--color-text-primary)]">{ALARMA_LABEL[a.tipo]}</p>
                        <p className="text-[0.6875rem] text-[color:var(--color-text-secondary)]">Observado: <strong>{a.valorObservado} {a.unidad}</strong> · Límite: {a.valorLimite} {a.unidad}</p>
                      </div>
                    </div>
                    {!a.ackAt && (
                      <GradientButton type="button" size="sm" variant="success" onClick={() => ackAlarma(a.id)} aria-label="Reconocer alarma">Reconocer</GradientButton>
                    )}
                    {a.ackAt && <span className="text-[0.625rem] text-[color:var(--color-text-tertiary)]">Ack {a.ackAt.slice(0, 10)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </FlitCard>
      )}
    </div>
  );
}

function EstadoPill({ j }: { j: Jornada }) {
  let estado = 'jornada-cerrada';
  let label = 'Cerrada';
  if (!j.cerrada) { estado = 'jornada-en-curso'; label = 'En curso'; }
  else if (j.cerradaAutomatica) { estado = 'jornada-cierre-auto'; label = 'Cierre auto'; }
  return <EtiquetaEstado estado={estado}>{label}</EtiquetaEstado>;
}
