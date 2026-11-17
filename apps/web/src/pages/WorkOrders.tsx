import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import Placa from '../components/flit/Placa';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { flitInp, FlitField } from '../components/flit/flitPageKit';
import { ESTADO_OT } from '../components/maintenance/estados-mantenimiento';

interface WorkOrder {
  id: number;
  numero: string;
  vehicleId: number;
  plate: string | null;
  tipoTrabajo: 'preventivo' | 'correctivo' | 'predictivo';
  estado: 'abierta' | 'cerrada_tecnica' | 'cerrada_final' | 'anulada';
  fechaIngresoTaller: string;
  fechaCierreFinal: string | null;
  costoTotalCalculado: string | null;
}

interface FleetVehicle { id: number; plate: string | null; alias: string | null; }

const ESTADOS = ['abierta', 'cerrada_tecnica', 'cerrada_final', 'anulada'] as const;
const ESTADO_LABEL: Record<string, string> = {
  abierta: 'Abierta',
  cerrada_tecnica: 'Cerrada técnica',
  cerrada_final: 'Cerrada final',
  anulada: 'Anulada',
};
const TIPO_LABEL: Record<string, string> = {
  preventivo: 'Preventivo',
  correctivo: 'Correctivo',
  predictivo: 'Predictivo',
};

const COLUMNAS: ColumnaTabla<WorkOrder>[] = [
  {
    key: 'numero', header: 'Número', etiqueta: 'Número',
    render: (wo) => (
      <Link to={`/maintenance/work-orders/${wo.id}`} className="flit-focus rounded-[9px] font-mono text-xs font-semibold text-[color:var(--color-action)] transition-colors hover:underline">{wo.numero}</Link>
    ),
  },
  {
    key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo',
    render: (wo) => (wo.plate ? <Placa placa={wo.plate} formatear={false} /> : <span className="font-semibold text-[color:var(--color-text-primary)]">#{wo.vehicleId}</span>),
  },
  { key: 'tipo', header: 'Tipo', etiqueta: 'Tipo', render: (wo) => <span className="text-[color:var(--color-text-secondary)]">{TIPO_LABEL[wo.tipoTrabajo] ?? wo.tipoTrabajo}</span> },
  {
    key: 'estado', header: 'Estado', etiqueta: 'Estado',
    render: (wo) => <EtiquetaEstado estado={ESTADO_OT[wo.estado] ?? wo.estado}>{ESTADO_LABEL[wo.estado] ?? wo.estado}</EtiquetaEstado>,
  },
  { key: 'ingreso', header: 'Ingreso', etiqueta: 'Ingreso', render: (wo) => <span className="text-xs text-[color:var(--color-text-secondary)]">{(wo.fechaIngresoTaller as string)?.slice(0, 16).replace('T', ' ')}</span> },
  { key: 'cierre', header: 'Cierre', etiqueta: 'Cierre', render: (wo) => <span className="text-xs text-[color:var(--color-text-secondary)]">{wo.fechaCierreFinal ? (wo.fechaCierreFinal as string).slice(0, 10) : '—'}</span> },
  {
    key: 'costo', header: 'Costo total', etiqueta: 'Costo total', align: 'right',
    render: (wo) => (
      <span className="tabular-nums font-medium text-[color:var(--color-text-primary)]">
        {wo.costoTotalCalculado ? Number(wo.costoTotalCalculado).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }) : '—'}
      </span>
    ),
  },
];

export default function WorkOrders() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('maintenance.ordenes.administrar');
  const [items, setItems] = useState<WorkOrder[]>([]);
  const [estadoFilter, setEstadoFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (estadoFilter) params.set('estado', estadoFilter);
      const r = await api.get<{ data: WorkOrder[] }>(`/maintenance/work-orders${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [estadoFilter]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Órdenes de trabajo"
        subtitle={`${items.length} órdenes · ejecución de taller con descuento automático de inventario`}
        icono="flito-ordenes-trabajo"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }]}
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva OT</GradientButton> : undefined}
      />

      <FiltroSegmentado
        ariaLabel="Estado de la orden de trabajo"
        opciones={[{ valor: '', etiqueta: 'Todas' }, ...ESTADOS.map((e) => ({ valor: e, etiqueta: ESTADO_LABEL[e] }))]}
        valor={estadoFilter}
        onCambio={(e) => setEstadoFilter(e)}
      />

      <DataTable
        ariaLabel="Órdenes de trabajo"
        columnas={COLUMNAS}
        filas={items}
        getKey={(wo) => String(wo.id)}
        emptyMessage="No hay órdenes de trabajo en este filtro"
      />

      {showCreate && <WoCreateForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function WoCreateForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [tipoTrabajo, setTipoTrabajo] = useState<'preventivo' | 'correctivo' | 'predictivo'>('correctivo');
  const [falla, setFalla] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [medicion, setMedicion] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ data: FleetVehicle[] }>('/fleet/vehicles?limit=500').then((r) => setVehicles(r.data)).catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!vehicleId) { toast.error('Seleccione un vehículo'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        vehicleId: parseInt(vehicleId, 10),
        tipoTrabajo,
        falla: falla.trim() || null,
        observaciones: observaciones.trim() || null,
      };
      if (medicion.trim()) body.medicionIngreso = parseInt(medicion, 10);
      await api.post('/maintenance/work-orders', body);
      toast.success('OT creada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nueva orden de trabajo" onClose={onClose} icono="mas">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Vehículo *">
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={flitInp}>
            <option value="">— seleccione —</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate || `#${v.id}`} {v.alias ? `(${v.alias})` : ''}</option>)}
          </select>
        </FlitField>
        <FlitField label="Tipo de trabajo">
          <select value={tipoTrabajo} onChange={(e) => setTipoTrabajo(e.target.value as typeof tipoTrabajo)} className={flitInp}>
            <option value="correctivo">Correctivo</option>
            <option value="preventivo">Preventivo</option>
            <option value="predictivo">Predictivo</option>
          </select>
        </FlitField>
        <FlitField label="Falla / motivo"><input value={falla} onChange={(e) => setFalla(e.target.value)} maxLength={500} className={flitInp} /></FlitField>
        <FlitField label="Medición de ingreso (km)"><input type="number" value={medicion} onChange={(e) => setMedicion(e.target.value)} className={flitInp} /></FlitField>
        <FlitField label="Observaciones"><textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} rows={3} className={flitInp} /></FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Creando…' : 'Crear OT'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
