import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import MeasurementsPanel from '../components/fleet/MeasurementsPanel';
import LinksPanel from '../components/fleet/LinksPanel';
import DocumentsPanel from '../components/fleet/DocumentsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PasaporteVehiculo from './vehiculo/PasaporteVehiculo';

interface Vehicle {
  id: number; plate: string | null; vin: string | null; alias: string | null; brand: string | null;
  model: string | null; year: number | null; color: string | null;
  tipoVehiculo: string | null; tipoMedicion: string | null; medicionPrincipal: string | null;
  combustiblePrincipal: string | null; numMotor: string | null; numSerie: string | null;
  distPromedioDia: number | null; rendimientoIdeal: string | null;
  esFlotaPropia: boolean;
}
interface DetailResp {
  data: Vehicle;
  lastMeasurement: { fecha: string; odometro: number | null; horometro: number | null } | null;
}

type Tab = 'datos' | 'mediciones' | 'vinculos' | 'documentos' | 'pasaporte';

export default function FleetVehicleDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [tab, setTab] = useState<Tab>('datos');

  const load = useCallback(async () => {
    if (!id) return;
    try { const r = await api.get<DetailResp>(`/fleet/vehicles/${id}`); setDetail(r); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!detail) return <div className="p-6 text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</div>;
  const v = detail.data;
  const subtitle = [v.alias, v.brand, v.model, v.year ? `(${v.year})` : '']
    .filter(Boolean).join(' ')
    + (detail.lastMeasurement
      ? ` · Último: ${detail.lastMeasurement.odometro ? `${detail.lastMeasurement.odometro} km` : ''}${detail.lastMeasurement.horometro ? ` · ${detail.lastMeasurement.horometro} h` : ''} (${detail.lastMeasurement.fecha})`
      : '');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <Link to="/fleet" className="flit-focus inline-flex w-fit items-center gap-1 text-xs font-medium" style={{ color: 'var(--flit-blue)' }}>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Flota
      </Link>

      <PageHeaderCard title={v.plate || 'Sin placa'} subtitle={subtitle || undefined} />

      <div className="border-b" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <nav className="-mb-px flex gap-6">
          <TabBtn active={tab === 'datos'} onClick={() => setTab('datos')}>Datos</TabBtn>
          <TabBtn active={tab === 'mediciones'} onClick={() => setTab('mediciones')}>Mediciones</TabBtn>
          <TabBtn active={tab === 'vinculos'} onClick={() => setTab('vinculos')}>Vinculaciones</TabBtn>
          <TabBtn active={tab === 'documentos'} onClick={() => setTab('documentos')}>Documentos</TabBtn>
          <TabBtn active={tab === 'pasaporte'} onClick={() => setTab('pasaporte')}>Pasaporte</TabBtn>
        </nav>
      </div>

      {tab === 'datos' && <DatosPanel v={v} />}
      {tab === 'mediciones' && <MeasurementsPanel vehicleId={v.id} tipoMedicion={v.tipoMedicion} canCreate={true} />}
      {tab === 'vinculos' && <LinksPanel vehicleId={v.id} canEdit={isAdmin} onChanged={load} />}
      {tab === 'documentos' && <DocumentsPanel vehicleId={v.id} canEdit={isAdmin} />}
      {tab === 'pasaporte' && (
        <div className="bg-white p-6" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
          {v.vin ? (
            <PasaporteVehiculo vin={v.vin} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              Este vehículo no tiene VIN registrado. Agrega el VIN en los datos del vehículo para ver el pasaporte e historial encadenado.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flit-focus border-b-2 pb-2 text-sm font-semibold transition-colors"
      style={active ? { borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' } : { borderColor: 'transparent', color: 'var(--flit-text-muted)' }}
    >
      {children}
    </button>
  );
}

function DatosPanel({ v }: { v: Vehicle }) {
  const rows: [string, string | number | null | undefined][] = [
    ['Placa', v.plate], ['VIN', v.vin], ['Alias', v.alias], ['Marca', v.brand], ['Modelo', v.model],
    ['Año', v.year], ['Color', v.color], ['Tipo', v.tipoVehiculo], ['Combustible', v.combustiblePrincipal],
    ['Medición', `${v.tipoMedicion ?? '—'} (principal: ${v.medicionPrincipal ?? '—'})`],
    ['Motor #', v.numMotor], ['Chasis #', v.numSerie],
    ['Promedio día', v.distPromedioDia ? `${v.distPromedioDia} km` : null],
    ['Rendimiento ideal', v.rendimientoIdeal ? `${v.rendimientoIdeal} km/gal` : null],
  ];
  return (
    <div className="bg-white p-6" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
            <dd className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{val ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
