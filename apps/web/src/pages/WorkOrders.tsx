import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  flitInp, FlitTh, FlitTr, FlitTable, FlitField, flitBtnPrimary, flitBtnPrimaryStyle,
  flitBtnSecondary, flitBtnSecondaryStyle, FlitPillGroup, FlitPillButton, FlitEmpty,
} from '../components/flit/flitPageKit';

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
const ESTADO_TONE: Record<string, ChipTone> = {
  abierta: 'warning',
  cerrada_tecnica: 'active',
  cerrada_final: 'success',
  anulada: 'neutral',
};
const TIPO_LABEL: Record<string, string> = {
  preventivo: 'Preventivo',
  correctivo: 'Correctivo',
  predictivo: 'Predictivo',
};

export default function WorkOrders() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva OT</GradientButton> : undefined}
      />

      <FlitPillGroup>
        <FlitPillButton active={estadoFilter === ''} onClick={() => setEstadoFilter('')}>Todas</FlitPillButton>
        {ESTADOS.map((e) => (
          <FlitPillButton key={e} active={estadoFilter === e} onClick={() => setEstadoFilter(e)}>
            {ESTADO_LABEL[e]}
          </FlitPillButton>
        ))}
      </FlitPillGroup>

      {items.length === 0 ? (
        <FlitEmpty>No hay órdenes de trabajo en este filtro</FlitEmpty>
      ) : (
        <FlitTable>
          <table className="w-full text-sm">
            <thead><tr>
              <FlitTh>Número</FlitTh><FlitTh>Vehículo</FlitTh><FlitTh>Tipo</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Ingreso</FlitTh><FlitTh>Cierre</FlitTh><FlitTh>Costo total</FlitTh>
            </tr></thead>
            <tbody>
              {items.map((wo) => (
                <FlitTr key={wo.id}>
                  <td className="px-4 py-3">
                    <Link to={`/maintenance/work-orders/${wo.id}`} className="font-mono text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>{wo.numero}</Link>
                  </td>
                  <td className="px-4 py-3 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{wo.plate || `#${wo.vehicleId}`}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{TIPO_LABEL[wo.tipoTrabajo] ?? wo.tipoTrabajo}</td>
                  <td className="px-4 py-3"><StatusChip tone={ESTADO_TONE[wo.estado] ?? 'neutral'}>{ESTADO_LABEL[wo.estado] ?? wo.estado}</StatusChip></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{(wo.fechaIngresoTaller as string)?.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{wo.fechaCierreFinal ? (wo.fechaCierreFinal as string).slice(0, 10) : '—'}</td>
                  <td className="px-4 py-3 tabular-nums font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                    {wo.costoTotalCalculado ? Number(wo.costoTotalCalculado).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }) : '—'}
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </table>
        </FlitTable>
      )}

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
    <FlitModal title="Nueva orden de trabajo" onClose={onClose}>
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
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>{submitting ? 'Creando…' : 'Crear OT'}</button>
        </div>
      </form>
    </FlitModal>
  );
}
