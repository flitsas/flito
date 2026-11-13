import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import KpiCard from '../components/flit/KpiCard';
import Pestanas from '../components/flit/Pestanas';
import PanelFiltros, { type FiltroAplicado } from '../components/flit/PanelFiltros';
import DataTable from '../components/flit/DataTable';
import Placa from '../components/flit/Placa';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { Icono } from '../components/flit/kit/Icono';
import { claseBoton } from '../components/flit/GradientButton';
import { flitInp, FlitField } from '../components/flit/flitPageKit';
import { ESTADO_FLOTA, estadoPorDias } from '../components/fleet/estados-flota';

interface FleetVehicle {
  id: number;
  plate: string | null;
  alias: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  tipoVehiculo: string | null;
  tipoMedicion: string | null;
  combustiblePrincipal: string | null;
  distPromedioDia: number | null;
}

interface ExpiringDoc {
  id: number;
  vehicleId: number;
  plate: string | null;
  alias: string | null;
  tipoNombre: string;
  vigenciaHasta: string;
  estado: 'vigente' | 'por_vencer' | 'vencido' | 'archivado';
}

const TIPO_LABEL: Record<string, string> = {
  tractomula: 'Tractomula', camion: 'Camión', buseta: 'Buseta',
  camioneta: 'Camioneta', automovil: 'Automóvil', motocicleta: 'Motocicleta', otro: 'Otro',
};
const FUEL_LABEL: Record<string, string> = {
  acpm: 'ACPM', gasolina: 'Gasolina', gas: 'Gas', electrico: 'Eléctrico', hibrido: 'Híbrido',
};

export default function Fleet() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('fleet.flota.administrar');
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([]);
  const [expiring, setExpiring] = useState<ExpiringDoc[]>([]);
  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // FLOTA-04: deep link desde Dashboard (?tab=vencimientos) abre esa pestaña al montar.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'vehiculos' | 'vencimientos'>(
    searchParams.get('tab') === 'vencimientos' ? 'vencimientos' : 'vehiculos',
  );

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (tipoFilter) params.set('tipo', tipoFilter);
      const q = params.toString();
      const r = await api.get<{ data: FleetVehicle[] }>(`/fleet/vehicles${q ? '?' + q : ''}`);
      setVehicles(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [search, tipoFilter]);

  const loadExpiring = useCallback(async () => {
    try {
      const r = await api.get<{ data: ExpiringDoc[]; count: number }>('/fleet/documents/expiring?dias=60');
      setExpiring(r.data);
    } catch { /* silencioso, badge */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadExpiring(); }, [loadExpiring]);

  const expVencidos = expiring.filter((d) => d.estado === 'vencido').length;
  const expProximos = expiring.filter((d) => d.estado !== 'vencido').length;

  const tiposAplicados: FiltroAplicado[] = tipoFilter ? [{ id: 'tipo', etiqueta: TIPO_LABEL[tipoFilter] ?? tipoFilter }] : [];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Flota"
        subtitle="Vehículos operativos, mediciones, vinculaciones y documentación"
        icono="flito-flota"
        miga={[]}
        actions={isAdmin ? (
          <GradientButton type="button" onClick={() => setShowCreate(true)} aria-label="Crear nuevo vehículo">
            <Icono nombre="mas" size={18} />
            Nuevo vehículo
          </GradientButton>
        ) : undefined}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Total flota" value={vehicles.length} icono="flito-flota" />
        <KpiCard label="Documentos por vencer" value={expProximos} pendiente />
        <KpiCard label="Documentos vencidos" value={expVencidos} pendiente />
      </div>

      <Pestanas
        etiqueta="Secciones de flota"
        activa={tab}
        onElegir={(id) => setTab(id as 'vehiculos' | 'vencimientos')}
        pestanas={[
          { id: 'vehiculos', etiqueta: 'Vehículos', cuenta: vehicles.length },
          { id: 'vencimientos', etiqueta: 'Vencimientos', cuenta: expiring.length },
        ]}
      />

      {tab === 'vehiculos' && (
        <>
          <PanelFiltros
            busqueda={search}
            onBusqueda={setSearch}
            placeholder="Placa, alias, marca o modelo"
            aplicados={tiposAplicados}
            onQuitar={() => setTipoFilter('')}
            campos={(
              <FlitField label="Tipo de vehículo">
                <select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value)} className={flitInp}>
                  <option value="">Todos los tipos</option>
                  {Object.entries(TIPO_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </FlitField>
            )}
          />

          <DataTable<FleetVehicle>
            ariaLabel="Vehículos de la flota"
            filas={vehicles}
            getKey={(v) => String(v.id)}
            status={vehicles.length === 0 ? 'empty' : 'ready'}
            emptyMessage="Sin vehículos en la flota"
            columnas={[
              {
                key: 'placa', header: 'Placa / Alias', etiqueta: 'Placa',
                render: (v) => (
                  <div className="flex flex-col items-start gap-1">
                    {v.plate ? <Placa placa={v.plate} /> : <span className="text-[color:var(--color-text-primary)]">—</span>}
                    {v.alias && <span className="text-xs text-[color:var(--color-text-tertiary)]">{v.alias}</span>}
                  </div>
                ),
              },
              { key: 'tipo', header: 'Tipo', render: (v) => (v.tipoVehiculo ? TIPO_LABEL[v.tipoVehiculo] : '—') },
              {
                key: 'marca', header: 'Marca / Modelo', etiqueta: 'Marca / Modelo',
                render: (v) => (
                  <span className="text-[color:var(--color-text-secondary)]">
                    {v.brand || '—'} {v.model && <span className="text-[color:var(--color-text-tertiary)]">/ {v.model}</span>} {v.year && <span className="text-[color:var(--color-text-tertiary)]">({v.year})</span>}
                  </span>
                ),
              },
              { key: 'combustible', header: 'Combustible', render: (v) => (v.combustiblePrincipal ? FUEL_LABEL[v.combustiblePrincipal] : '—') },
              { key: 'promedio', header: 'Promedio día', etiqueta: 'Promedio día', render: (v) => (v.distPromedioDia ? `${v.distPromedioDia} km` : '—') },
              {
                key: 'acciones', header: '', acciones: true, align: 'right',
                render: (v) => <Link to={`/fleet/${v.id}`} className={claseBoton('secondary', 'sm')}>Detalle</Link>,
              },
            ]}
          />
        </>
      )}

      {tab === 'vencimientos' && <VencimientosPanel docs={expiring} />}

      {showCreate && <FleetCreateModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function VencimientosPanel({ docs }: { docs: ExpiringDoc[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const diasDe = (d: ExpiringDoc) => Math.round((new Date(d.vigenciaHasta).getTime() - new Date(today).getTime()) / 86_400_000);
  return (
    <DataTable<ExpiringDoc>
      ariaLabel="Documentos por vencer"
      filas={docs}
      getKey={(d) => String(d.id)}
      status={docs.length === 0 ? 'empty' : 'ready'}
      emptyMessage="Sin documentos por vencer en los próximos 60 días"
      columnas={[
        {
          key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo',
          render: (d) => (
            <div className="flex flex-col items-start gap-1">
              <Link to={`/fleet/${d.vehicleId}`} className="rounded-[9px] font-semibold text-[color:var(--color-action)] transition-colors hover:underline">
                {d.plate ? <Placa placa={d.plate} /> : `#${d.vehicleId}`}
              </Link>
              {d.alias && <span className="text-xs text-[color:var(--color-text-tertiary)]">{d.alias}</span>}
            </div>
          ),
        },
        { key: 'documento', header: 'Documento', render: (d) => d.tipoNombre },
        { key: 'vence', header: 'Vence', render: (d) => d.vigenciaHasta },
        { key: 'estado', header: 'Estado', render: (d) => <ExpiryPill estado={d.estado} dias={diasDe(d)} /> },
      ]}
    />
  );
}

function ExpiryPill({ estado, dias }: { estado: string; dias: number }) {
  if (estado === 'vencido' || dias <= 0) return <EtiquetaEstado estado={ESTADO_FLOTA.docVencido}>Vencido</EtiquetaEstado>;
  return <EtiquetaEstado estado={estadoPorDias(dias)}>{dias}d</EtiquetaEstado>;
}

interface CreateForm {
  plate: string; alias: string; brand: string; model: string;
  year: string; color: string; tipoVehiculo: string;
  tipoMedicion: 'km' | 'horas' | 'ambos'; medicionPrincipal: 'km' | 'horas';
  combustiblePrincipal: string; numMotor: string; numSerie: string;
  distPromedioDia: string; rendimientoIdeal: string;
}

const EMPTY_FORM: CreateForm = {
  plate: '', alias: '', brand: '', model: '', year: '', color: '',
  tipoVehiculo: '', tipoMedicion: 'km', medicionPrincipal: 'km',
  combustiblePrincipal: '', numMotor: '', numSerie: '',
  distPromedioDia: '', rendimientoIdeal: '',
};

function FleetCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<CreateForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.plate.trim()) { toast.error('Placa requerida'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        plate: f.plate.trim().toUpperCase(),
        alias: f.alias.trim() || null,
        brand: f.brand.trim() || null,
        model: f.model.trim() || null,
        color: f.color.trim() || null,
        numMotor: f.numMotor.trim() || null,
        numSerie: f.numSerie.trim() || null,
        tipoMedicion: f.tipoMedicion,
        medicionPrincipal: f.medicionPrincipal,
      };
      if (f.year.trim()) body.year = parseInt(f.year, 10);
      if (f.tipoVehiculo) body.tipoVehiculo = f.tipoVehiculo;
      if (f.combustiblePrincipal) body.combustiblePrincipal = f.combustiblePrincipal;
      if (f.distPromedioDia.trim()) body.distPromedioDia = parseInt(f.distPromedioDia, 10);
      if (f.rendimientoIdeal.trim()) body.rendimientoIdeal = parseFloat(f.rendimientoIdeal);
      await api.post('/fleet/vehicles', body);
      toast.success('Vehículo creado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nuevo vehículo de flota" onClose={onClose} icono="carro">
      <form onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FlitField label="Placa *"><input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} maxLength={10} className={flitInp} /></FlitField>
          <FlitField label="Alias"><input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} maxLength={80} className={flitInp} /></FlitField>
          <FlitField label="Marca"><input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Modelo"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Año"><input type="number" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Color"><input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Tipo de vehículo">
            <select value={f.tipoVehiculo} onChange={(e) => setF({ ...f, tipoVehiculo: e.target.value })} className={flitInp}>
              <option value="">— seleccione —</option>
              {Object.entries(TIPO_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </FlitField>
          <FlitField label="Combustible principal">
            <select value={f.combustiblePrincipal} onChange={(e) => setF({ ...f, combustiblePrincipal: e.target.value })} className={flitInp}>
              <option value="">— seleccione —</option>
              {Object.entries(FUEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </FlitField>
          <FlitField label="Tipo de medición">
            <select value={f.tipoMedicion} onChange={(e) => setF({ ...f, tipoMedicion: e.target.value as CreateForm['tipoMedicion'] })} className={flitInp}>
              <option value="km">Kilómetros</option>
              <option value="horas">Horas</option>
              <option value="ambos">Ambos</option>
            </select>
          </FlitField>
          <FlitField label="Medición principal">
            <select value={f.medicionPrincipal} onChange={(e) => setF({ ...f, medicionPrincipal: e.target.value as CreateForm['medicionPrincipal'] })} className={flitInp}>
              <option value="km">Kilómetros</option>
              <option value="horas">Horas</option>
            </select>
          </FlitField>
          <FlitField label="Número de motor"><input value={f.numMotor} onChange={(e) => setF({ ...f, numMotor: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Número de serie (chasis)"><input value={f.numSerie} onChange={(e) => setF({ ...f, numSerie: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Promedio km/día"><input type="number" value={f.distPromedioDia} onChange={(e) => setF({ ...f, distPromedioDia: e.target.value })} className={flitInp} /></FlitField>
          <FlitField label="Rendimiento ideal (km/gal)"><input type="number" step="0.01" value={f.rendimientoIdeal} onChange={(e) => setF({ ...f, rendimientoIdeal: e.target.value })} className={flitInp} /></FlitField>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear vehículo'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
