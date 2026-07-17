import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';

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

type KpiTone = 'neutral' | 'warning' | 'danger';

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export default function Fleet() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Flota"
        subtitle="Vehículos operativos, mediciones, vinculaciones y documentación"
        actions={isAdmin ? (
          <GradientButton type="button" onClick={() => setShowCreate(true)} aria-label="Crear nuevo vehículo">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            Nuevo vehículo
          </GradientButton>
        ) : undefined}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiTile label="Total flota" value={vehicles.length} tone="neutral" />
        <KpiTile label="Documentos por vencer" value={expProximos} tone="warning" />
        <KpiTile label="Documentos vencidos" value={expVencidos} tone="danger" />
      </div>

      <div className="border-b" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <nav className="-mb-px flex gap-6">
          <TabBtn active={tab === 'vehiculos'} onClick={() => setTab('vehiculos')}>Vehículos ({vehicles.length})</TabBtn>
          <TabBtn active={tab === 'vencimientos'} onClick={() => setTab('vencimientos')}>Vencimientos ({expiring.length})</TabBtn>
        </nav>
      </div>

      {tab === 'vehiculos' && (
        <>
          <div className="flex gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Placa, alias, marca o modelo"
              className="flit-focus min-w-0 flex-1 rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow"
            />
            <select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value)} className="flit-focus shrink-0 rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow">
              <option value="">Todos los tipos</option>
              {Object.entries(TIPO_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          <TableCard>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Placa / Alias</Th>
                  <Th>Tipo</Th>
                  <Th>Marca / Modelo</Th>
                  <Th>Combustible</Th>
                  <Th>Promedio día</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {vehicles.length === 0 && (
                  <tr><td colSpan={6} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin vehículos en la flota</td></tr>
                )}
                {vehicles.map((v) => (
                  <Tr key={v.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{v.plate || '—'}</p>
                      {v.alias && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{v.alias}</p>}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{v.tipoVehiculo ? TIPO_LABEL[v.tipoVehiculo] : '—'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>
                      {v.brand || '—'} {v.model && <span style={{ color: 'var(--flit-text-muted)' }}>/ {v.model}</span>} {v.year && <span style={{ color: 'var(--flit-text-muted)' }}>({v.year})</span>}
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{v.combustiblePrincipal ? FUEL_LABEL[v.combustiblePrincipal] : '—'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{v.distPromedioDia ? `${v.distPromedioDia} km` : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/fleet/${v.id}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>Detalle</Link>
                    </td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </>
      )}

      {tab === 'vencimientos' && <VencimientosPanel docs={expiring} />}

      {showCreate && <FleetCreateModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: number; tone: KpiTone }) {
  const color = tone === 'warning' ? 'var(--flit-warning)' : tone === 'danger' ? 'var(--flit-danger)' : 'var(--flit-text-primary)';
  return (
    <div className="bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-4xl font-bold tabular-nums leading-none" style={{ color }}>{value}</p>
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

function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>{children}</tr>;
}

function VencimientosPanel({ docs }: { docs: ExpiringDoc[] }) {
  if (docs.length === 0) {
    return <div className="p-8 text-center text-sm" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}>Sin documentos por vencer en los próximos 60 días</div>;
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <TableCard>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Vehículo</Th>
            <Th>Documento</Th>
            <Th>Vence</Th>
            <Th>Estado</Th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const dias = Math.round((new Date(d.vigenciaHasta).getTime() - new Date(today).getTime()) / 86_400_000);
            return (
              <Tr key={d.id}>
                <td className="px-4 py-3">
                  <Link to={`/fleet/${d.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>
                    {d.plate || `#${d.vehicleId}`}
                  </Link>
                  {d.alias && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{d.alias}</p>}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{d.tipoNombre}</td>
                <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{d.vigenciaHasta}</td>
                <td className="px-4 py-3"><ExpiryPill estado={d.estado} dias={dias} /></td>
              </Tr>
            );
          })}
        </tbody>
      </table>
    </TableCard>
  );
}

function ExpiryPill({ estado, dias }: { estado: string; dias: number }) {
  if (estado === 'vencido' || dias <= 0) return <StatusChip tone="danger">Vencido</StatusChip>;
  if (dias <= 7) return <StatusChip tone="danger">{dias}d</StatusChip>;
  if (dias <= 30) return <StatusChip tone="warning">{dias}d</StatusChip>;
  return <StatusChip tone="success">{dias}d</StatusChip>;
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
    <FlitModal title="Nuevo vehículo de flota" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Placa *"><input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} maxLength={10} className={inputCls} /></Field>
          <Field label="Alias"><input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} maxLength={80} className={inputCls} /></Field>
          <Field label="Marca"><input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} className={inputCls} /></Field>
          <Field label="Modelo"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} className={inputCls} /></Field>
          <Field label="Año"><input type="number" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} className={inputCls} /></Field>
          <Field label="Color"><input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className={inputCls} /></Field>
          <Field label="Tipo de vehículo">
            <select value={f.tipoVehiculo} onChange={(e) => setF({ ...f, tipoVehiculo: e.target.value })} className={inputCls}>
              <option value="">— seleccione —</option>
              {Object.entries(TIPO_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Combustible principal">
            <select value={f.combustiblePrincipal} onChange={(e) => setF({ ...f, combustiblePrincipal: e.target.value })} className={inputCls}>
              <option value="">— seleccione —</option>
              {Object.entries(FUEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Tipo de medición">
            <select value={f.tipoMedicion} onChange={(e) => setF({ ...f, tipoMedicion: e.target.value as CreateForm['tipoMedicion'] })} className={inputCls}>
              <option value="km">Kilómetros</option>
              <option value="horas">Horas</option>
              <option value="ambos">Ambos</option>
            </select>
          </Field>
          <Field label="Medición principal">
            <select value={f.medicionPrincipal} onChange={(e) => setF({ ...f, medicionPrincipal: e.target.value as CreateForm['medicionPrincipal'] })} className={inputCls}>
              <option value="km">Kilómetros</option>
              <option value="horas">Horas</option>
            </select>
          </Field>
          <Field label="Número de motor"><input value={f.numMotor} onChange={(e) => setF({ ...f, numMotor: e.target.value })} className={inputCls} /></Field>
          <Field label="Número de serie (chasis)"><input value={f.numSerie} onChange={(e) => setF({ ...f, numSerie: e.target.value })} className={inputCls} /></Field>
          <Field label="Promedio km/día"><input type="number" value={f.distPromedioDia} onChange={(e) => setF({ ...f, distPromedioDia: e.target.value })} className={inputCls} /></Field>
          <Field label="Rendimiento ideal (km/gal)"><input type="number" step="0.01" value={f.rendimientoIdeal} onChange={(e) => setF({ ...f, rendimientoIdeal: e.target.value })} className={inputCls} /></Field>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} disabled={submitting} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear vehículo'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}
