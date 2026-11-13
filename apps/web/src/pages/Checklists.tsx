import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { claseBoton } from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import type { EstadoUi } from '../components/flit/Cargador';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { FlitCard, FlitPillGroup, FlitPillButton } from '../components/flit/flitPageKit';
import Placa from '../components/flit/Placa';
import '../components/fleet/estados-checklists';

interface ChecklistRow {
  id: number;
  vehicleId: number;
  plate: string | null;
  conductorId: number;
  conductorName: string | null;
  fechaHora: string;
  decision: 'apto' | 'no_apto' | 'condicional';
  anuladoAt: string | null;
}

const FILTROS = ['', 'apto', 'condicional', 'no_apto'];

const COLUMNAS: ColumnaTabla<ChecklistRow>[] = [
  {
    key: 'fecha', header: 'Fecha', etiqueta: 'Fecha',
    render: (c) => <span className="text-xs tabular-nums text-[color:var(--color-text-secondary)]">{(c.fechaHora as string).slice(0, 16).replace('T', ' ')}</span>,
  },
  {
    key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo',
    render: (c) => (
      <Link to={`/fleet/${c.vehicleId}`} className="flit-focus inline-flex rounded-[9px] transition-opacity hover:opacity-80">
        {c.plate ? <Placa placa={c.plate} /> : <span className="font-semibold text-[color:var(--color-text-primary)]">{`#${c.vehicleId}`}</span>}
      </Link>
    ),
  },
  {
    key: 'conductor', header: 'Conductor', etiqueta: 'Conductor',
    render: (c) => <Link to={`/pesv/conductores/${c.conductorId}`} className="flit-focus text-xs text-[color:var(--color-action)] transition-colors hover:underline">{c.conductorName}</Link>,
  },
  { key: 'decision', header: 'Decisión', etiqueta: 'Decisión', render: (c) => <DecisionPill d={c.decision} /> },
  {
    key: 'estado', header: 'Estado', etiqueta: 'Estado',
    render: (c) => c.anuladoAt
      ? <EtiquetaEstado estado="checklist-anulado">Anulado</EtiquetaEstado>
      : <EtiquetaEstado estado="checklist-vigente">Vigente</EtiquetaEstado>,
  },
];

export default function Checklists() {
  const [items, setItems] = useState<ChecklistRow[]>([]);
  const [decision, setDecision] = useState('');
  // Solo presentación: alimenta los 4 estados de la tabla del kit (cargando / error con reintento / vacío / lleno).
  const [status, setStatus] = useState<EstadoUi>('loading');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const params = new URLSearchParams();
      if (decision) params.set('decision', decision);
      const r = await api.get<{ data: ChecklistRow[] }>(`/drivers/checklists${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
      setStatus(r.data.length ? 'ready' : 'empty');
    } catch (err) { toast.error(errorMessage(err)); setStatus('error'); }
  }, [decision]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Checklists preoperacionales"
        subtitle="Inspecciones diarias del vehículo antes de salir (Res. 40595/2022 paso 21)"
        icono="flito-checklists"
        miga={[{ etiqueta: 'PESV' }]}
        actions={
          <Link to="/pesv/checklists/nuevo" className={claseBoton('primary')}>
            Nuevo checklist
          </Link>
        }
      />

      <FlitCard className="flex min-w-0 flex-col gap-4">
        <FlitPillGroup>
          {FILTROS.map((d) => (
            <FlitPillButton key={d || 'todos'} active={decision === d} onClick={() => setDecision(d)}>
              {d || 'Todos'}
            </FlitPillButton>
          ))}
        </FlitPillGroup>

        <DataTable
          ariaLabel="Checklists preoperacionales"
          columnas={COLUMNAS}
          filas={items}
          getKey={(c) => String(c.id)}
          status={status}
          onRetry={load}
          emptyMessage="Sin checklists"
        />
      </FlitCard>
    </div>
  );
}

function DecisionPill({ d }: { d: string }) {
  return <EtiquetaEstado estado={d}>{d.replace('_', ' ')}</EtiquetaEstado>;
}
