import { useEffect, useState, useRef } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import toast from 'react-hot-toast';
import BatchValidator from '../components/BatchValidator';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface SoatRequest {
  id: number; vehicleId: number; vin: string; plate: string | null;
  ownerName: string | null; ownerDocument: string | null; brand: string | null;
  model: string | null; status: string; policyNumber: string | null;
  insurer: string | null; purchaseDate: string | null; expiryDate: string | null;
  runtVerified: boolean; soatHolder: string | null;
  assignedToName: string | null; notes: string | null; createdAt: string;
}

// Normaliza nombres para comparar titular SOAT vs dueño del vehículo (ignora tildes, S.A.S., espacios extras, mayúsculas)
const normalizeName = (s: string | null | undefined): string =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\bS\.?\s*A\.?\s*S\.?\b/g, '').replace(/\bLTDA\.?\b/g, '').replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ').trim();
interface Vehicle { id: number; vin: string; plate: string | null; ownerName: string | null; }
interface UserOption { id: number; name: string; role: string; }

interface RuntSoatRecord {
  numSoat?: string;
  noPoliza?: string;
  razonSocialAsegur?: string;
  aseguradora?: string;
  fechaInicioPoliza?: string;
  fechaVencimSoat?: string;
}
interface RuntVehiculoRecord {
  placa?: string;
  marca?: string;
  linea?: string;
  modelo?: string;
  [k: string]: unknown;
}
interface RuntConsultaVehiculoResponse {
  ok?: boolean;
  message?: string;
  data?: {
    vehiculo?: RuntVehiculoRecord;
    soat?: RuntSoatRecord | RuntSoatRecord[];
  };
}
interface RuntResult {
  veh?: RuntVehiculoRecord;
  soat?: RuntSoatRecord;
}
interface SoatCreateBody {
  vehicleIds: number[];
  assignedTo?: number;
}
interface VehicleCreateResponse {
  id?: number;
}
interface VehicleSearchResult {
  id: number;
  vin: string;
}

const POLICY_PLACEHOLDERS = ['Pendiente', 'Pendiente verificación RUNT', 'Pendiente verificacion RUNT'];
const isPolicyPlaceholder = (p: string | null) => !p || POLICY_PLACEHOLDERS.includes(p);

// Tono semántico FLIT por estado SOAT.
const STATUS_TONE: Record<string, ChipTone> = {
  pendiente: 'warning', enviado: 'active', comprado: 'active', verificado: 'success', rechazado: 'danger',
};
const STATUS_COLOR: Record<string, string> = {
  pendiente: 'var(--flit-warning)', enviado: 'var(--flit-blue)', comprado: 'var(--flit-blue)',
  verificado: 'var(--flit-success)', rechazado: 'var(--flit-danger)',
};

const ESTADO_LABEL: Record<string, { label: string; desc: string }> = {
  pendiente: { label: 'Pendiente', desc: 'Sin SOAT registrado' },
  enviado: { label: 'Enviado', desc: 'Enviado a proveedor' },
  comprado: { label: 'Comprado', desc: 'Pendiente verificación RUNT' },
  verificado: { label: 'Verificado', desc: 'Confirmado en RUNT' },
  rechazado: { label: 'Rechazado', desc: '' },
};

// Input FLIT (blanco, borde, foco azul bajo .flit-app).
const inp = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export default function Soat() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<SoatRequest[]>([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [providers, setProviders] = useState<UserOption[]>([]);
  const [selectedVehicles, setSelectedVehicles] = useState<number[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [purchaseModal, setPurchaseModal] = useState<SoatRequest | null>(null);
  const [purchaseForm, setPurchaseForm] = useState({ policyNumber: '', insurer: '', purchaseDate: '', expiryDate: '' });
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    api.get<SoatRequest[]>(`/soat${filterStatus ? `?status=${filterStatus}` : ''}`)
      .then(setRequests)
      .catch(() => toast.error('No se pudieron cargar las solicitudes'));
  };
  useEffect(() => { load(); }, [filterStatus]);

  const openCreate = async () => {
    const [v, u] = await Promise.all([api.get<Vehicle[]>('/vehicles'), user?.role === 'admin' ? api.get<UserOption[]>('/users') : Promise.resolve([])]);
    setVehicles(v); setProviders((u as UserOption[]).filter((u) => u.role === 'proveedor')); setSelectedVehicles([]); setShowCreate(true);
  };

  const handleCreate = async () => {
    if (selectedVehicles.length === 0) { toast.error('Selecciona al menos un vehículo'); return; }
    try {
      const body: SoatCreateBody = { vehicleIds: selectedVehicles }; if (selectedProvider) body.assignedTo = parseInt(selectedProvider);
      await api.post('/soat', body); toast.success(`${selectedVehicles.length} solicitudes creadas`); setShowCreate(false); load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const [verifying, setVerifying] = useState(false);
  const [runtResult, setRuntResult] = useState<RuntResult | null>(null);

  const handleVerifyAndPurchase = async () => {
    if (!purchaseModal) return;
    setVerifying(true);
    setRuntResult(null);
    try {
      const res = await api.post<RuntConsultaVehiculoResponse>('/runt/consulta-vehiculo', { vin: purchaseModal.vin });
      if (res.ok && res.data) {
        const soat = Array.isArray(res.data.soat) ? res.data.soat[0] : res.data.soat;
        setRuntResult({ veh: res.data.vehiculo, soat });
        if (soat) {
          await api.patch(`/soat/${purchaseModal.id}/purchase`, {
            policyNumber: soat.numSoat || soat.noPoliza || '',
            insurer: soat.razonSocialAsegur || soat.aseguradora || '',
            purchaseDate: soat.fechaInicioPoliza ? soat.fechaInicioPoliza.split('T')[0] : '',
            expiryDate: soat.fechaVencimSoat ? soat.fechaVencimSoat.split('T')[0] : '',
          });
          toast.success('SOAT verificado y registrado desde RUNT');
          setPurchaseModal(null); setRuntResult(null); load();
        } else {
          toast.error('El RUNT aún no indexa este SOAT (tarda 24-72h hábiles). Reintenta más tarde.');
        }
      } else {
        toast.error(res.message || 'No se pudo consultar RUNT');
      }
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setVerifying(false); }
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]; if (!file) return;
    try { const res = await api.upload<{ total: number; updated: number; notFound: number }>('/soat/upload-purchases', file); toast.success(`${res.updated} actualizados, ${res.notFound} no encontrados`); load(); }
    catch (err) { toast.error(errorMessage(err)); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const exportProveedor = async () => {
    try {
      const pendientes = requests.filter((r) => r.status === 'pendiente').map((r) => ({
        vin: r.vin, plate: r.plate, linea: r.model, ownerName: r.ownerName,
        docType: '', docNumber: r.ownerDocument, phone: '', email: '', city: '',
      }));
      const res = await fetch('/api/soat/export-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ items: pendientes }),
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `SOAT_${new Date().toLocaleDateString('es-CO').replace(/\//g, '_')}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch { toast.error('No se pudo generar el Excel'); }
  };

  const [soatTab, setSoatTab] = useState<'validate' | 'manage'>('validate');
  const toggleVehicle = (id: number) => setSelectedVehicles((p) => p.includes(id) ? p.filter((v) => v !== id) : [...p, id]);

  const filters = [
    { key: '', label: 'Todos' },
    { key: 'pendiente', label: 'Pendientes' },
    { key: 'enviado', label: 'Enviados' },
    { key: 'comprado', label: 'Comprados' },
    { key: 'verificado', label: 'Verificados' },
    { key: 'rechazado', label: 'Rechazados' },
  ];

  const pendientesCount = requests.filter((r) => r.status === 'pendiente').length;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Gestión SOAT"
        subtitle={`${requests.length} solicitudes`}
        actions={
          <>
            {user?.role === 'admin' && (
              <GradientButton type="button" onClick={openCreate}>Nueva solicitud</GradientButton>
            )}
            <label className="flit-focus inline-flex cursor-pointer items-center gap-2 rounded-[999px] border bg-white px-4 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              <svg className="h-4 w-4" style={{ color: 'var(--flit-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
              Registrar compras
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            </label>
            {user?.role === 'admin' && (
              <button onClick={() => api.download(`/soat/export${filterStatus ? `?status=${filterStatus}` : ''}`, 'soat.xlsx')} className="flit-focus inline-flex items-center gap-2 rounded-[999px] border bg-white px-4 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
                <svg className="h-4 w-4" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                Exportar
              </button>
            )}
          </>
        }
      />

      {/* Tabs */}
      <PillGroup>
        {[
          { key: 'validate' as const, label: 'Consultar RUNT' },
          { key: 'manage' as const, label: 'Gestión de compras' },
        ].map((tab) => (
          <PillButton key={tab.key} active={soatTab === tab.key} onClick={() => setSoatTab(tab.key)}>
            {tab.label}
          </PillButton>
        ))}
      </PillGroup>

      {soatTab === 'validate' && <BatchValidator onSendToRequests={async (items) => {
        // C5: Crear vehiculos y recoger IDs inmediatamente para evitar race condition
        const createdIds: number[] = [];
        for (const item of items) {
          try {
            const veh = await api.post<VehicleCreateResponse>('/vehicles', {
              vin: item.vin, plate: item.plate || undefined,
              ownerName: item.ownerName || undefined, ownerDocument: item.docNumber || undefined,
              brand: item.brand || undefined, model: item.linea || undefined,
              vehicleClass: item.claseVehiculo || undefined,
            });
            if (veh?.id) createdIds.push(veh.id);
          } catch {
            // Duplicado — buscar el ID existente
            const vehs = await api.get<VehicleSearchResult[]>(`/vehicles?search=${encodeURIComponent(item.vin)}`);
            const existing = vehs.find((v) => v.vin === item.vin);
            if (existing) createdIds.push(existing.id);
          }
        }
        if (createdIds.length > 0) {
          await api.post('/soat', { vehicleIds: createdIds });
        }
        toast.success(`${createdIds.length} solicitudes creadas`);
        setSoatTab('manage');
        load();
      }} />}

      {soatTab === 'manage' && (<>
      {/* Banner informativo sobre lag RUNT */}
      {requests.some((r) => r.status === 'comprado') && (
        <div className="flex items-start gap-3 rounded-[12px] px-4 py-3" style={{ background: 'rgba(79,116,201,0.08)', border: '1px solid rgba(79,116,201,0.20)' }}>
          <svg className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div className="text-xs leading-relaxed" style={{ color: 'var(--flit-blue)' }}>
            <span className="font-semibold">Los SOAT recién comprados tardan 24-72 horas hábiles en aparecer en RUNT.</span>
            {' '}Si el vehículo tuvo un traspaso reciente, la consulta por documento del propietario actual puede fallar hasta que sincronice. El sistema reintenta automáticamente por VIN.
          </div>
        </div>
      )}

      {/* Filters */}
      <PillGroup>
        {filters.map((f) => (
          <PillButton key={f.key} active={filterStatus === f.key} onClick={() => setFilterStatus(f.key)}>
            {f.key && <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[f.key] }} />}
            {f.label}
          </PillButton>
        ))}
      </PillGroup>

      {/* Download for provider */}
      {pendientesCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[12px] p-4" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.20)' }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning)' }}>{pendientesCount} pendientes de compra</p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-warning)' }}>Descarga el Excel y envíalo al proveedor</p>
          </div>
          <button onClick={exportProveedor} className={`flit-focus inline-flex shrink-0 items-center gap-2 rounded-[999px] px-5 py-2.5 text-sm font-semibold text-white`} style={{ background: 'var(--flit-gradient-danger)' }}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Descargar Excel para proveedor
          </button>
        </div>
      )}

      {/* Cards */}
      {requests.length === 0 ? (
        <div className="p-12 text-center" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)' }}>
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No hay solicitudes SOAT</p>
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => {
            const estadoInfo = ESTADO_LABEL[r.status];
            return (
              <div key={r.id} className="bg-white p-4 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
                <div className="flex items-center gap-4">
                  <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-1 lg:grid-cols-6">
                    <Field label="Placa" value={r.plate || '—'} bold />
                    <Field label="Propietario" value={r.ownerName || '—'} />
                    <Field label="Póliza" value={r.policyNumber || '—'} />
                    <Field label="Aseguradora" value={r.insurer || '—'} />
                    <Field label="Fecha compra" value={r.purchaseDate || '—'} />
                    <div>
                      <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Estado</p>
                      <div className="mt-0.5"><StatusChip tone={STATUS_TONE[r.status] ?? 'warning'}>{estadoInfo?.label || r.status}</StatusChip></div>
                      {estadoInfo?.desc && <p className="mt-0.5 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{estadoInfo.desc}</p>}
                      {r.soatHolder && normalizeName(r.soatHolder) && normalizeName(r.soatHolder) !== normalizeName(r.ownerName) && (
                        <p className="mt-0.5 text-[10px]" style={{ color: 'var(--flit-blue)' }} title={`Titular RUNT: ${r.soatHolder}`}>
                          SOAT a nombre de otro titular
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {r.status === 'pendiente' && (
                      <button
                        onClick={() => { setPurchaseForm({ policyNumber: '', insurer: '', purchaseDate: '', expiryDate: '' }); setEvidenceFile(null); setPurchaseModal(r); }}
                        className="flit-focus rounded-[999px] px-4 py-2 text-xs font-semibold text-white"
                        style={{ background: 'var(--flit-gradient-success)' }}
                      >
                        Registrar compra
                      </button>
                    )}
                    {r.status === 'comprado' && user?.role === 'admin' && isPolicyPlaceholder(r.policyNumber) && (
                      <button onClick={async () => {
                        const t = toast.loading('Consultando RUNT...');
                        try {
                          const res = await fetch(`/api/soat/${r.id}/refresh-runt`, { method: 'PATCH', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
                          const d = await res.json();
                          toast.dismiss(t);
                          if (!res.ok) { toast.error(d.error || 'No se pudo actualizar'); return; }
                          toast.success(`Póliza ${d.policyNumber} · ${d.insurer || 'sin aseguradora'}`);
                          load();
                        } catch { toast.dismiss(t); toast.error('Error de red'); }
                      }} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-bold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>
                        Actualizar desde RUNT
                      </button>
                    )}
                    {r.status === 'comprado' && user?.role === 'admin' && !isPolicyPlaceholder(r.policyNumber) && (
                      <button onClick={async () => {
                        try {
                          const res = await fetch(`/api/soat/${r.id}/verify`, { method: 'PATCH', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
                          const d = await res.json();
                          if (!res.ok) { toast.error(d.error); return; }
                          toast.success('SOAT verificado en RUNT');
                          load();
                        } catch { toast.error('Error de red'); }
                      }} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-bold text-white" style={{ background: 'var(--flit-gradient-success)' }}>
                        Verificar RUNT
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      </>)}

      {/* Create modal */}
      {showCreate && (
        <FlitModal title="Nueva solicitud SOAT" onClose={() => setShowCreate(false)}>
          <p className="mb-5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Selecciona los vehículos para generar solicitudes</p>
          {providers.length > 0 && (
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Asignar a proveedor</label>
              <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)} className={inp}>
                <option value="">Sin asignar</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <p className="mb-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{selectedVehicles.length} seleccionados</p>
          <div className="max-h-60 overflow-auto rounded-[10px] bg-white" style={{ border: '1px solid var(--flit-border-soft)' }}>
            {vehicles.map((v) => (
              <label key={v.id} className="flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 last:border-0 hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <input type="checkbox" checked={selectedVehicles.includes(v.id)} onChange={() => toggleVehicle(v.id)} className="rounded" style={{ accentColor: 'var(--flit-blue)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{v.plate || '—'}</span>
                <span className="font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{v.vin}</span>
                <span className="ml-auto text-sm" style={{ color: 'var(--flit-text-muted)' }}>{v.ownerName || ''}</span>
              </label>
            ))}
          </div>
          <div className="mt-5 flex gap-2">
            <GradientButton type="button" onClick={handleCreate}>Crear solicitudes</GradientButton>
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          </div>
        </FlitModal>
      )}

      {/* Purchase modal */}
      {purchaseModal && (
        <FlitModal title="Registrar compra SOAT" onClose={() => { setPurchaseModal(null); setEvidenceFile(null); }}>
          <p className="mb-4 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{purchaseModal.plate || '—'}</span> &middot; {purchaseModal.ownerName || '—'}
          </p>
          <div className="mb-5">
            <label className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Adjuntar SOAT (obligatorio)</label>
            <label className="flit-focus flex cursor-pointer items-center gap-3 rounded-[12px] px-4 py-4" style={{ border: `2px dashed ${evidenceFile ? 'var(--flit-success)' : 'var(--flit-blue)'}`, background: evidenceFile ? 'rgba(112,207,58,0.08)' : '#fff' }}>
              <svg className="h-6 w-6" style={{ color: evidenceFile ? 'var(--flit-success)' : 'var(--flit-blue)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={evidenceFile ? 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z' : 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5'} />
              </svg>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{evidenceFile ? evidenceFile.name : 'Seleccionar archivo'}</p>
                <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{evidenceFile ? `${(evidenceFile.size / 1024).toFixed(0)} KB` : 'PDF, PNG o JPG — máx. 10 MB'}</p>
              </div>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && f.size > 10 * 1024 * 1024) { toast.error('Archivo supera 10MB'); return; }
                setEvidenceFile(f || null);
              }} />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              disabled={!evidenceFile}
              onClick={async () => {
                if (!evidenceFile) { toast.error('Debes adjuntar el SOAT'); return; }
                try {
                  // F2: Enviar evidencia como FormData al servidor
                  const form = new FormData();
                  form.append('evidence', evidenceFile);
                  form.append('policyNumber', 'Pendiente verificacion RUNT');
                  form.append('insurer', 'Pendiente');
                  form.append('purchaseDate', new Date().toISOString().split('T')[0]);
                  const token = localStorage.getItem('token');
                  const res = await fetch(`/api/soat/${purchaseModal.id}/purchase`, {
                    method: 'PATCH',
                    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                    body: form,
                  });
                  if (!res.ok) { const d = await res.json().catch(() => ({} as { error?: string })); throw new Error(d.error || 'Error'); }
                  toast.success('SOAT registrado como comprado');
                  setPurchaseModal(null); setEvidenceFile(null); load();
                } catch (err) { toast.error(errorMessage(err)); }
              }}
              className="flit-focus flex-1 rounded-[999px] py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'var(--flit-gradient-success)' }}
            >
              Guardar compra
            </button>
            <button
              onClick={() => { setPurchaseModal(null); setEvidenceFile(null); }}
              className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            >
              Cancelar
            </button>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

// ---------- Subcomponentes FLIT ----------
function PillGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex w-fit flex-wrap gap-1 rounded-[999px] p-1" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
      {children}
    </div>
  );
}

function PillButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
      style={active
        ? { background: '#fff', color: 'var(--flit-blue)', boxShadow: 'var(--flit-shadow-card)' }
        : { color: 'var(--flit-text-muted)' }}
    >
      {children}
    </button>
  );
}

function Field({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className={`truncate text-sm ${bold ? 'font-bold' : ''}`} style={{ color: bold ? 'var(--flit-text-primary)' : 'var(--flit-text-secondary)' }}>{value}</p>
    </div>
  );
}
