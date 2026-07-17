import { useEffect, useState, useRef, FormEvent, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import toast from 'react-hot-toast';
import RuntLookup from '../components/RuntLookup';
import Pipeline from '../components/Pipeline';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import PasaporteVehiculo from './vehiculo/PasaporteVehiculo';
import { fechaHoyColombia, restarDias, etiquetaRango, type RangoFechas } from '../lib/dateColombia';
import RangoFechaFilter from '../components/flit/RangoFechaFilter';

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

const inp = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Vehículos"
        subtitle={
          rangoFechas
            ? `${vehicles.length} ingresos · ${rangoLabel}`
            : `${vehicles.length} registros (histórico)`
        }
        actions={
          <>
            <GradientButton type="button" onClick={() => setShowForm(!showForm)} aria-label="Nuevo vehículo" aria-expanded={showForm}>Nuevo</GradientButton>
            <label className="flit-focus inline-flex cursor-pointer items-center gap-2 rounded-[999px] border bg-white px-4 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              <svg className="h-4 w-4" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
              Importar matrículas
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            </label>
            <button onClick={() => api.download('/vehicles/export', 'vehiculos.xlsx')} className="flit-focus inline-flex items-center gap-2 rounded-[999px] border bg-white px-4 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              <svg className="h-4 w-4" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
              Exportar
            </button>
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
      <div className="inline-flex w-fit gap-1 rounded-[999px] p-1" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
        {[
          { key: 'pipeline' as const, label: 'Pipeline' },
          { key: 'list' as const, label: 'Listado' },
          { key: 'runt' as const, label: 'Consulta RUNT' },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
            style={activeTab === tab.key ? { background: '#fff', color: 'var(--flit-blue)', boxShadow: 'var(--flit-shadow-card)' } : { color: 'var(--flit-text-muted)' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
        <div className="bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
          <h3 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Nuevo vehículo</h3>
          <form onSubmit={handleCreate}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <input required value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} placeholder="VIN *" className={inp} />
              <input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} placeholder="Placa" className={inp} />
              <input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} placeholder="Propietario" className={inp} />
              <input value={form.ownerDocument} onChange={(e) => setForm({ ...form, ownerDocument: e.target.value })} placeholder="Documento" className={inp} />
              <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="Marca" className={inp} />
              <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Modelo" className={inp} />
              <input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} placeholder="Año" type="number" className={inp} />
              <input value={form.vehicleClass} onChange={(e) => setForm({ ...form, vehicleClass: e.target.value })} placeholder="Clase" className={inp} />
            </div>
            <div className="mt-4 flex gap-2">
              <GradientButton type="submit">Guardar</GradientButton>
              <button type="button" onClick={() => setShowForm(false)} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            </div>
          </form>
        </div>
      )}

      {/* Search */}
      <form onSubmit={handleSearch}>
        <div className="relative">
          <svg className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por VIN, placa, propietario o documento..."
            className="flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white py-2.5 pl-10 pr-4 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow"
          />
        </div>
      </form>

      {/* Vehicle cards */}
      {activeTab === 'list' && (vehicles.length === 0 ? (
        <div className="p-12 text-center" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)' }}>
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
            {rangoFechas ? `Sin ingresos en el rango (${rangoLabel})` : 'No hay vehículos registrados'}
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Crea uno nuevo, importa desde Excel o cambia la fecha del filtro</p>
        </div>
      ) : (
        <div className="space-y-2">
          {vehicles.map((v) => (
            <div key={v.id} className="group bg-white p-4 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
              <div className="flex items-center gap-4">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-1 lg:grid-cols-5">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Placa</p>
                    <p className="text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>{v.plate || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Propietario</p>
                    <p className="truncate text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{v.ownerName || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Vehículo</p>
                    <p className="truncate text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{[v.brand, v.model].filter(Boolean).join(' ') || '—'} {v.year || ''}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>VIN</p>
                    <p className="font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{v.vin}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>SOAT</p>
                    <div className="mt-0.5"><StatusChip tone={SOAT_TONE[v.soatStatus || 'sin_solicitud'] ?? 'neutral'}>{v.soatStatus || 'Sin solicitud'}</StatusChip></div>
                  </div>
                </div>

                <button
                  onClick={() => setPasaporteVin(v.vin)}
                  aria-label={`Ver pasaporte del vehículo ${v.plate ?? v.vin}`}
                  className="flit-focus shrink-0 rounded-[999px] border px-3 py-1.5 text-xs font-semibold"
                  style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
                  title="Pasaporte vehicular"
                >
                  Pasaporte
                </button>

                <button
                  onClick={() => handleDelete(v.id)}
                  aria-label={`Eliminar vehículo ${v.plate ?? v.vin}`}
                  className="flit-focus rounded-lg p-2 opacity-0 transition-all hover:bg-[rgba(228,61,48,0.10)] group-hover:opacity-100 focus-visible:opacity-100"
                  style={{ color: 'var(--flit-text-muted)' }}
                  title="Eliminar"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {pasaporteVin && (
        <FlitModal title="Pasaporte vehicular" wide onClose={() => setPasaporteVin(null)}>
          <PasaporteVehiculo vin={pasaporteVin} />
        </FlitModal>
      )}
    </div>
  );
}
