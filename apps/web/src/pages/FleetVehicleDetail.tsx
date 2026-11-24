import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import MeasurementsPanel from '../components/fleet/MeasurementsPanel';
import LinksPanel from '../components/fleet/LinksPanel';
import DocumentsPanel from '../components/fleet/DocumentsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PasaporteVehiculo from './vehiculo/PasaporteVehiculo';
import Pestanas from '../components/flit/Pestanas';
import { Cargador } from '../components/flit/Cargador';
import { FlitCard } from '../components/flit/flitPageKit';
import { Vehiculo } from '../components/flit/Placa';
import { Fichas } from '../components/flit/Bloques';

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
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('fleet.flota.administrar');
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [tab, setTab] = useState<Tab>('datos');

  const load = useCallback(async () => {
    if (!id) return;
    try { const r = await api.get<DetailResp>(`/fleet/vehicles/${id}`); setDetail(r); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!detail) return <Cargador texto="Cargando…" />;
  const v = detail.data;
  const subtitle = [v.alias, v.brand, v.model, v.year ? `(${v.year})` : '']
    .filter(Boolean).join(' ')
    + (detail.lastMeasurement
      ? ` · Último: ${detail.lastMeasurement.odometro ? `${detail.lastMeasurement.odometro} km` : ''}${detail.lastMeasurement.horometro ? ` · ${detail.lastMeasurement.horometro} h` : ''} (${detail.lastMeasurement.fecha})`
      : '');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title={v.plate || 'Sin placa'}
        subtitle={subtitle || undefined}
        icono="flito-vehiculos"
        miga={[{ etiqueta: 'Flota', to: '/fleet' }]}
      />

      {v.plate && (
        <FlitCard>
          <Vehiculo
            placa={v.plate}
            icono="flito-flota"
            nombre={[v.brand, v.model].filter(Boolean).join(' ') || '—'}
            meta={[v.alias, v.year].filter(Boolean).join(' · ') || undefined}
          />
        </FlitCard>
      )}

      <Pestanas
        etiqueta="Secciones del vehículo"
        activa={tab}
        onElegir={(id) => setTab(id as Tab)}
        pestanas={[
          { id: 'datos', etiqueta: 'Datos' },
          { id: 'mediciones', etiqueta: 'Mediciones' },
          { id: 'vinculos', etiqueta: 'Vinculaciones' },
          { id: 'documentos', etiqueta: 'Documentos' },
          { id: 'pasaporte', etiqueta: 'Pasaporte' },
        ]}
      />

      {tab === 'datos' && <DatosPanel v={v} />}
      {tab === 'mediciones' && <MeasurementsPanel vehicleId={v.id} tipoMedicion={v.tipoMedicion} canCreate={true} />}
      {tab === 'vinculos' && <LinksPanel vehicleId={v.id} canEdit={isAdmin} onChanged={load} />}
      {tab === 'documentos' && <DocumentsPanel vehicleId={v.id} canEdit={isAdmin} />}
      {tab === 'pasaporte' && (
        <FlitCard>
          {v.vin ? (
            <PasaporteVehiculo vin={v.vin} />
          ) : (
            <p className="text-sm text-[color:var(--color-text-tertiary)]">
              Este vehículo no tiene VIN registrado. Agrega el VIN en los datos del vehículo para ver el pasaporte e historial encadenado.
            </p>
          )}
        </FlitCard>
      )}
    </div>
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
    <FlitCard>
      <Fichas items={rows.map(([k, val]) => ({ etiqueta: k, valor: val ?? '—' }))} />
    </FlitCard>
  );
}
