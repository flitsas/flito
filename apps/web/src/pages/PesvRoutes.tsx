import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { IconClose } from '../components/flit/icons';

interface Route {
  id: number;
  codigo: string;
  nombre: string;
  origen: string;
  destino: string;
  distanciaKm: string | null;
  duracionEstimadaMin: number | null;
  criticidad: 'baja' | 'media' | 'alta' | 'critica';
  activo: boolean;
  optimisticV: number;
}
interface Waypoint {
  id: number;
  routeId: number;
  orden: number;
  tipo: 'origen' | 'destino' | 'parada_segura' | 'area_descanso' | 'punto_riesgo' | 'zona_peligrosa' | 'peaje' | 'pernocta' | 'cargue' | 'descargue';
  nombre: string;
  lat: string | null;
  lng: string | null;
  descripcion: string | null;
}
interface RouteDetail extends Route { waypoints: Waypoint[]; }
interface RiskAnalysis {
  id: number;
  routeId: number;
  trimestre: string;
  fecha: string;
  estado: 'borrador' | 'aprobado';
  resumen: string | null;
  optimisticV: number;
}

interface RouteBody {
  codigo: string; nombre: string; origen: string; destino: string;
  criticidad: string; distanciaKm?: string;
}

interface WpBody {
  orden: number; tipo: Waypoint['tipo']; nombre: string; descripcion: string | null;
  lat?: string; lng?: string;
}

const TIPOS: Waypoint['tipo'][] = ['origen', 'parada_segura', 'area_descanso', 'punto_riesgo', 'zona_peligrosa', 'peaje', 'pernocta', 'cargue', 'descargue', 'destino'];
const CRITICIDADES = ['baja', 'media', 'alta', 'critica'] as const;
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvRoutes() {
  const [items, setItems] = useState<Route[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ codigo: '', nombre: '', origen: '', destino: '', distanciaKm: '', criticidad: 'media' });
  const [selected, setSelected] = useState<RouteDetail | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ data: Route[] }>('/rutas');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.codigo.length < 2 || form.nombre.length < 3) { toast.error('Código ≥2 chars, nombre ≥3'); return; }
    try {
      const body: RouteBody = {
        codigo: form.codigo, nombre: form.nombre, origen: form.origen,
        destino: form.destino, criticidad: form.criticidad,
      };
      if (form.distanciaKm) body.distanciaKm = form.distanciaKm;
      await api.post('/rutas', body);
      toast.success('Ruta creada');
      setShowCreate(false);
      setForm({ codigo: '', nombre: '', origen: '', destino: '', distanciaKm: '', criticidad: 'media' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const openDetail = async (id: number) => {
    try {
      const r = await api.get<RouteDetail>(`/rutas/${id}`);
      setSelected(r);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Rutas operativas"
        subtitle="PESV · Paso 4 · Res. 40595 · Caracterización y análisis de riesgo trimestral"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva ruta</GradientButton>}
      />

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Código</Th><Th>Nombre</Th><Th>Origen → Destino</Th><Th>Km</Th><Th>Criticidad</Th><Th>Acción</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin rutas registradas</td></tr>}
              {items.map((r) => (
                <tr key={r.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.codigo}</td>
                  <td className="px-4 py-3 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{r.nombre}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.origen} → {r.destino}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.distanciaKm ?? '—'}</td>
                  <td className="px-4 py-3"><CritPill c={r.criticidad} /></td>
                  <td className="px-4 py-3"><button onClick={() => openDetail(r.id)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Ver</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <DetailPanel route={selected} onUpdate={() => openDetail(selected.id)} onClose={() => setSelected(null)} />}

      {showCreate && (
        <FlitModal title="Nueva ruta" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Código (R-001)" value={form.codigo} onChange={(e) => setForm({ ...form, codigo: e.target.value })} className={inputCls} />
            <input placeholder="Nombre (Bogotá-Cali)" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Origen" value={form.origen} onChange={(e) => setForm({ ...form, origen: e.target.value })} className={inputCls} />
              <input placeholder="Destino" value={form.destino} onChange={(e) => setForm({ ...form, destino: e.target.value })} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Distancia km" value={form.distanciaKm} onChange={(e) => setForm({ ...form, distanciaKm: e.target.value.replace(/[^0-9.]/g, '') })} className={inputCls} />
              <select value={form.criticidad} onChange={(e) => setForm({ ...form, criticidad: e.target.value })} className={inputCls}>
                {CRITICIDADES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function DetailPanel({ route, onUpdate, onClose }: { route: RouteDetail; onUpdate: () => void; onClose: () => void }) {
  const [showWp, setShowWp] = useState(false);
  const [wpForm, setWpForm] = useState<{ orden: number; tipo: Waypoint['tipo']; nombre: string; lat: string; lng: string; descripcion: string }>({
    orden: route.waypoints.length + 1, tipo: 'parada_segura', nombre: '', lat: '', lng: '', descripcion: '',
  });
  const [risks, setRisks] = useState<RiskAnalysis[]>([]);
  const [trimestre, setTrimestre] = useState<string>(`${new Date().getFullYear()}-Q${Math.ceil((new Date().getMonth() + 1) / 3)}`);

  useEffect(() => {
    api.get<{ data: RiskAnalysis[] }>(`/rutas/risk?routeId=${route.id}`).then((r) => setRisks(r.data)).catch(() => {});
  }, [route.id]);

  const addWp = async () => {
    if (!wpForm.nombre) { toast.error('Nombre requerido'); return; }
    try {
      const body: WpBody = { orden: wpForm.orden, tipo: wpForm.tipo, nombre: wpForm.nombre, descripcion: wpForm.descripcion || null };
      if (wpForm.lat) body.lat = wpForm.lat;
      if (wpForm.lng) body.lng = wpForm.lng;
      await api.post(`/rutas/${route.id}/waypoints`, body);
      toast.success('Waypoint agregado');
      setShowWp(false);
      setWpForm({ orden: route.waypoints.length + 2, tipo: 'parada_segura', nombre: '', lat: '', lng: '', descripcion: '' });
      onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const newRisk = async () => {
    const fecha = new Date().toISOString().slice(0, 10);
    try {
      await api.post('/rutas/risk', { routeId: route.id, trimestre, fecha });
      toast.success('Análisis trimestral creado');
      const r = await api.get<{ data: RiskAnalysis[] }>(`/rutas/risk?routeId=${route.id}`);
      setRisks(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const aprobarRisk = async (id: number) => {
    if (!confirm('¿Aprobar análisis? Se vuelve WORM.')) return;
    try {
      await api.post(`/rutas/risk/${id}/aprobar`);
      toast.success('Análisis aprobado');
      const r = await api.get<{ data: RiskAnalysis[] }>(`/rutas/risk?routeId=${route.id}`);
      setRisks(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <section className="bg-white p-6" style={CARD}>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>{route.codigo} · {route.nombre}</h2>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{route.origen} → {route.destino} · {route.distanciaKm ?? '?'} km · criticidad {route.criticidad}</p>
        </div>
        <button onClick={onClose} aria-label="Cerrar detalle" className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ color: 'var(--flit-text-muted)' }}><IconClose className="h-5 w-5" /></button>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Waypoints ({route.waypoints.length})</h3>
        <button onClick={() => setShowWp(true)} className="flit-focus ml-auto inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Agregar waypoint</button>
      </div>
      {route.waypoints.length === 0 && <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin waypoints</p>}
      {route.waypoints.map((w) => (
        <div key={w.id} className="flex items-center gap-2 border-b py-2 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <span className="w-6 font-mono" style={{ color: 'var(--flit-text-muted)' }}>#{w.orden}</span>
          <TipoBadge tipo={w.tipo} />
          <span className="flex-1" style={{ color: 'var(--flit-text-primary)' }}>{w.nombre}</span>
          {w.lat && <span className="font-mono" style={{ color: 'var(--flit-text-muted)' }}>{w.lat}, {w.lng}</span>}
        </div>
      ))}

      <h3 className="mb-3 mt-6 text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Análisis trimestral de riesgo ({risks.length})</h3>
      <div className="mb-3 flex gap-2">
        <input value={trimestre} onChange={(e) => setTrimestre(e.target.value)} placeholder="2026-Q2" className="flit-focus rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 font-mono text-xs text-[color:var(--flit-text-primary)] outline-none transition-shadow" />
        <button onClick={newRisk} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Nuevo</button>
      </div>
      {risks.map((a) => (
        <div key={a.id} className="mb-2 rounded-[12px] p-3" style={a.estado === 'aprobado'
          ? { border: '1px solid rgba(112,207,58,0.30)', background: 'rgba(112,207,58,0.10)' }
          : { border: '1px solid rgba(240,90,53,0.30)', background: 'rgba(240,90,53,0.10)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono" style={{ color: 'var(--flit-text-primary)' }}>{a.trimestre} · {a.fecha}</span>
            <div className="flex items-center gap-2">
              <StatusChip tone={a.estado === 'aprobado' ? 'success' : 'warning'}>{a.estado}</StatusChip>
              {a.estado === 'borrador' && <button onClick={() => aprobarRisk(a.id)} className="flit-focus inline-flex h-7 items-center rounded-[999px] px-3 text-[11px] font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-success)' }}>Aprobar</button>}
            </div>
          </div>
        </div>
      ))}

      {showWp && (
        <FlitModal title="Nuevo waypoint" onClose={() => setShowWp(false)}>
          <div className="space-y-3">
            <input type="number" placeholder="Orden" value={wpForm.orden} onChange={(e) => setWpForm({ ...wpForm, orden: parseInt(e.target.value) || 0 })} className={inputCls} />
            <select value={wpForm.tipo} onChange={(e) => setWpForm({ ...wpForm, tipo: e.target.value as Waypoint['tipo'] })} className={inputCls}>
              {TIPOS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
            <input placeholder="Nombre" value={wpForm.nombre} onChange={(e) => setWpForm({ ...wpForm, nombre: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Lat (opt)" value={wpForm.lat} onChange={(e) => setWpForm({ ...wpForm, lat: e.target.value })} className={inputCls} />
              <input placeholder="Lng (opt)" value={wpForm.lng} onChange={(e) => setWpForm({ ...wpForm, lng: e.target.value })} className={inputCls} />
            </div>
            <textarea placeholder="Descripción" value={wpForm.descripcion} onChange={(e) => setWpForm({ ...wpForm, descripcion: e.target.value })} rows={2} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowWp(false)} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={addWp}>Agregar</GradientButton>
          </div>
        </FlitModal>
      )}
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function CritPill({ c }: { c: string }) {
  const tone: Record<string, ChipTone> = { baja: 'success', media: 'warning', alta: 'warning', critica: 'danger' };
  return <StatusChip tone={tone[c] ?? 'neutral'}>{c}</StatusChip>;
}

function TipoBadge({ tipo }: { tipo: string }) {
  const tone: Record<string, ChipTone> = {
    origen: 'active', destino: 'active', pernocta: 'active', cargue: 'active', descargue: 'active',
    parada_segura: 'success', area_descanso: 'success',
    punto_riesgo: 'warning', zona_peligrosa: 'danger', peaje: 'neutral',
  };
  return <StatusChip tone={tone[tipo] ?? 'neutral'}>{tipo.replace('_', ' ')}</StatusChip>;
}
