import { useEffect, useState, useRef, FormEvent, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import toast from 'react-hot-toast';
import RuntLookup from '../components/RuntLookup';
import Pipeline from '../components/Pipeline';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton, { claseBoton } from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import PasaporteVehiculo from './vehiculo/PasaporteVehiculo';
import { fechaHoyColombia, restarDias, etiquetaRango, type RangoFechas } from '../lib/dateColombia';
import RangoFechaFilter from '../components/flit/RangoFechaFilter';
import Pestanas from '../components/flit/Pestanas';
import Placa from '../components/flit/Placa';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { FlitCard, flitInp, flitBtnIconoSm } from '../components/flit/flitPageKit';
import { Icono } from '../components/flit/kit/Icono';

interface Vehicle {
  id: number;
  vin: string;
  plate: string | null;
  ownerName: string | null;
  ownerDocument: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  vehicleClass: string | null;
  stage: string;
  clientId: number | null;
  taxPaid: boolean;
  soatStatus: string | null;
  policyNumber: string | null;
  insurer: string | null;
  expiryDate: string | null;
  multasEstado?: 'no_consultado' | 'sin_multas' | 'con_multas' | 'acuerdo_pago';
  multasTotal?: string | null;
  multasCount?: number | null;
  multasConsultadoAt?: string | null;
  createdAt?: string;
}

const SOAT_TONE: Record<string, ChipTone> = {
  pendiente: 'warning', enviado: 'active', comprado: 'success',
  verificado: 'success', rechazado: 'danger', sin_solicitud: 'neutral',
};

const MIGA = [{ etiqueta: 'Flota', to: '/fleet' }];

const PESTANAS = [
  { id: 'pipeline', etiqueta: 'Pipeline' },
  { id: 'list', etiqueta: 'Listado' },
  { id: 'runt', etiqueta: 'Consulta RUNT' },
];

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  /** null = histórico completo; por defecto solo hoy. */
  const [rangoFechas, setRangoFechas] = useState<RangoFechas | null>(() => {
    const h = fechaHoyColombia();
    return { desde: restarDias(h, 6), hasta: h };
  });
  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'pipeline' | 'list' | 'runt'>('pipeline');
  const hoy = fechaHoyColombia();
  // B1: pasaporte vehicular (timeline + certificado) en modal por VIN.
  const [pasaporteVin, setPasaporteVin] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ vin: '', plate: '', ownerName: '', ownerDocument: '', brand: '', model: '', year: '', vehicleClass: '' });

  const rangoLabel = rangoFechas ? etiquetaRango(rangoFechas.desde, rangoFechas.hasta) : null;

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    if (rangoFechas) {
      q.set('desde', rangoFechas.desde);
      q.set('hasta', rangoFechas.hasta);
    }
    const qs = q.toString();
    setLoading(true);
    api.get<Vehicle[]>(`/vehicles${qs ? `?${qs}` : ''}`)
      .then(setVehicles)
      .catch((err) => toast.error(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [search, rangoFechas]);

  useEffect(() => { load(); }, [load]);
  const handleSearch = (e: FormEvent) => { e.preventDefault(); load(); };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/vehicles', { ...form, year: form.year ? parseInt(form.year) : null, plate: form.plate || null, ownerName: form.ownerName || null, ownerDocument: form.ownerDocument || null, brand: form.brand || null, model: form.model || null, vehicleClass: form.vehicleClass || null });
      toast.success('Vehículo creado');
      setShowForm(false);
      setForm({ vin: '', plate: '', ownerName: '', ownerDocument: '', brand: '', model: '', year: '', vehicleClass: '' });
      setSearch('');
      load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    try {
      const res = await api.upload<{ total: number; inserted: number; skipped: number }>('/vehicles/upload', file);
      toast.success(`${res.inserted} vehículos cargados, ${res.skipped} omitidos`);
      setSearch('');
      load();
    } catch (err) { toast.error(errorMessage(err)); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleDelete = async (id: number) => {
    try { await api.delete(`/vehicles/${id}`); toast.success('Vehículo eliminado'); load(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const columnas: ColumnaTabla<Vehicle>[] = [
    { key: 'placa', header: 'Placa', etiqueta: 'Placa', render: (v) => (v.plate ? <Placa placa={v.plate} /> : <span className="text-[color:var(--color-text-tertiary)]">—</span>) },
    { key: 'propietario', header: 'Propietario', etiqueta: 'Propietario', render: (v) => <span className="text-sm text-[color:var(--color-text-secondary)]">{v.ownerName || '—'}</span> },
    { key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo', render: (v) => <span className="text-sm text-[color:var(--color-text-secondary)]">{[v.brand, v.model].filter(Boolean).join(' ') || '—'} {v.year || ''}</span> },
    { key: 'vin', header: 'VIN', etiqueta: 'VIN', render: (v) => <span className="font-mono text-xs break-all text-[color:var(--color-text-tertiary)]">{v.vin}</span> },
    { key: 'soat', header: 'SOAT', etiqueta: 'SOAT', render: (v) => <StatusChip tone={SOAT_TONE[v.soatStatus || 'sin_solicitud'] ?? 'neutral'}>{v.soatStatus || 'Sin solicitud'}</StatusChip> },
    {
      key: 'acciones', header: 'Acciones', etiqueta: 'Acciones', acciones: true, align: 'right',
      render: (v) => (
        <div className="flex items-center justify-end gap-2">
          <GradientButton
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setPasaporteVin(v.vin)}
            aria-label={`Ver pasaporte del vehículo ${v.plate ?? v.vin}`}
            title="Pasaporte vehicular"
          >
            Pasaporte
          </GradientButton>
          <button
            type="button"
            onClick={() => handleDelete(v.id)}
            aria-label={`Eliminar vehículo ${v.plate ?? v.vin}`}
            className={`${flitBtnIconoSm} transition-colors hover:text-[color:var(--kit-rojo-texto)]`}
            title="Eliminar"
          >
            <Icono nombre="papelera" size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Vehículos"
        icono="flito-vehiculos"
        miga={MIGA}
        subtitle={
          rangoFechas
            ? `${vehicles.length} ingresos · ${rangoLabel}`
            : `${vehicles.length} registros (histórico)`
        }
        actions={
          <>
            <GradientButton type="button" onClick={() => setShowForm(!showForm)} aria-label="Nuevo vehículo" aria-expanded={showForm}>Nuevo</GradientButton>
            <label className={`${claseBoton('secondary')} cursor-pointer`}>
              <Icono nombre="archivo-subir" size={18} />
              Importar matrículas
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            </label>
            <GradientButton type="button" variant="secondary" onClick={() => api.download('/vehicles/export', 'vehiculos.xlsx')}>
              <Icono nombre="nube-bajar" size={18} />
              Exportar
            </GradientButton>
          </>
        }
      />

      <RangoFechaFilter
        rango={rangoFechas}
        onChange={setRangoFechas}
        loading={loading}
        descripcion="Filtra vehículos por fecha de registro (hora Colombia). Pipeline y listado usan el mismo rango."
      />

      {/* Tools tabs */}
      <Pestanas
        etiqueta="Vistas de vehículos"
        pestanas={PESTANAS}
        activa={activeTab}
        onElegir={(id) => setActiveTab(id as 'pipeline' | 'list' | 'runt')}
      />

      {/* Tool panels */}
      {activeTab === 'pipeline' && (
        <Pipeline
          vehicles={vehicles}
          onRefresh={load}
          rangoLabel={rangoLabel ?? undefined}
          onOpenVehicle={(v) => {
            if (!v.vin) { toast.error('Este vehículo no tiene VIN registrado'); return; }
            setPasaporteVin(v.vin);
          }}
        />
      )}
      {activeTab === 'runt' && <RuntLookup />}

      {/* Create form */}
      {showForm && (
        <FlitCard className="p-5">
          <h3 className="mb-3 text-sm font-bold text-[color:var(--color-action)]">Nuevo vehículo</h3>
          <form onSubmit={handleCreate}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
              <input required value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} placeholder="VIN *" aria-label="VIN *" className={flitInp} />
              <input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} placeholder="Placa" aria-label="Placa" className={flitInp} />
              <input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} placeholder="Propietario" aria-label="Propietario" className={flitInp} />
              <input value={form.ownerDocument} onChange={(e) => setForm({ ...form, ownerDocument: e.target.value })} placeholder="Documento" aria-label="Documento" className={flitInp} />
              <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="Marca" aria-label="Marca" className={flitInp} />
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Modelo" aria-label="Modelo" className={flitInp} />
              <input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} placeholder="Año" aria-label="Año" type="number" className={flitInp} />
              <input value={form.vehicleClass} onChange={(e) => setForm({ ...form, vehicleClass: e.target.value })} placeholder="Clase" aria-label="Clase" className={flitInp} />
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
              <GradientButton type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancelar</GradientButton>
              <GradientButton type="submit">Guardar</GradientButton>
            </div>
          </form>
        </FlitCard>
      )}

      {/* Search */}
      <form onSubmit={handleSearch} className="filtros" data-kit="filtros">
        <div className="filtros__barra">
          <div className="control-icono filtros__buscar">
            <Icono nombre="buscar" size={18} />
            <input
              className="control"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por VIN, placa, propietario o documento..."
              aria-label="Buscar por VIN, placa, propietario o documento..."
            />
          </div>
        </div>
      </form>

      {/* Vehicle list */}
      {activeTab === 'list' && (
        <DataTable
          ariaLabel="Listado de vehículos"
          columnas={columnas}
          filas={vehicles}
          getKey={(v) => String(v.id)}
          status={loading && vehicles.length === 0 ? 'loading' : vehicles.length === 0 ? 'empty' : 'ready'}
          emptyMessage={rangoFechas ? `Sin ingresos en el rango (${rangoLabel})` : 'No hay vehículos registrados'}
          emptyDetalle="Crea uno nuevo, importa desde Excel o cambia la fecha del filtro"
        />
      )}

      {pasaporteVin && (
        <FlitModal title="Pasaporte vehicular" icono="carro" wide onClose={() => setPasaporteVin(null)}>
          <PasaporteVehiculo vin={pasaporteVin} />
        </FlitModal>
      )}
    </div>
  );
}
