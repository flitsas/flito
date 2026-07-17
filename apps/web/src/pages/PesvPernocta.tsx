import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface Pernocta {
  id: number;
  nombre: string;
  routeId: number | null;
  lat: string | null;
  lng: string | null;
  capacidad: number | null;
  contacto: string | null;
  telefono: string | null;
  servicios: string[];
  vigente: boolean;
}

interface PernoctaBody {
  nombre: string; servicios: string[];
  lat?: string; lng?: string; capacidad?: number;
  contacto?: string; telefono?: string; protocoloMd?: string;
}

const SERVICIOS = ['baño', 'duchas', 'cafetería', 'vigilancia', 'wifi', 'parqueadero techado', 'comida'];
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvPernocta() {
  const [items, setItems] = useState<Pernocta[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ nombre: string; lat: string; lng: string; capacidad: string; contacto: string; telefono: string; servicios: string[]; protocoloMd: string }>({
    nombre: '', lat: '', lng: '', capacidad: '', contacto: '', telefono: '', servicios: [], protocoloMd: '',
  });

  const load = async () => {
    try {
      const r = await api.get<{ data: Pernocta[] }>('/rutas/pernocta');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.nombre.length < 3) { toast.error('Nombre ≥3 chars'); return; }
    try {
      const body: PernoctaBody = { nombre: form.nombre, servicios: form.servicios };
      if (form.lat) body.lat = form.lat;
      if (form.lng) body.lng = form.lng;
      if (form.capacidad) body.capacidad = parseInt(form.capacidad, 10);
      if (form.contacto) body.contacto = form.contacto;
      if (form.telefono) body.telefono = form.telefono;
      if (form.protocoloMd) body.protocoloMd = form.protocoloMd;
      await api.post('/rutas/pernocta', body);
      toast.success('Zona registrada');
      setShowCreate(false);
      setForm({ nombre: '', lat: '', lng: '', capacidad: '', contacto: '', telefono: '', servicios: [], protocoloMd: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const archivar = async (id: number) => {
    if (!confirm('¿Archivar zona? Se marca como no vigente (preservación histórica).')) return;
    try {
      await api.delete(`/rutas/pernocta/${id}`);
      toast.success('Zona archivada');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const toggleServ = (s: string) => {
    setForm((f) => ({ ...f, servicios: f.servicios.includes(s) ? f.servicios.filter((x) => x !== s) : [...f.servicios, s] }));
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Zonas de pernocta"
        subtitle="PESV · Paso 4 · Zonas certificadas con contacto y protocolos de emergencia"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva zona</GradientButton>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {items.length === 0 && <div className="bg-white p-8 text-center text-sm lg:col-span-2" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Sin zonas registradas</div>}
        {items.map((p) => (
          <div key={p.id} className="bg-white p-6" style={CARD}>
            <div className="mb-2 flex items-start justify-between">
              <h3 className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.nombre}</h3>
              <button onClick={() => archivar(p.id)} className="flit-focus text-[10px] transition-opacity hover:opacity-80" style={{ color: 'var(--flit-danger)' }}>Archivar</button>
            </div>
            {(p.lat && p.lng) && <p className="font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{p.lat}, {p.lng}</p>}
            {p.capacidad && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Capacidad: <strong style={{ color: 'var(--flit-text-primary)' }}>{p.capacidad}</strong> vehículos</p>}
            {p.contacto && <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Contacto: {p.contacto} {p.telefono && `· ${p.telefono}`}</p>}
            {p.servicios.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {p.servicios.map((s) => <StatusChip key={s} tone="success">{s}</StatusChip>)}
              </div>
            )}
          </div>
        ))}
      </div>

      {showCreate && (
        <FlitModal title="Nueva zona de pernocta" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Nombre (Estación La Línea)" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Latitud" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} className={inputCls} />
              <input placeholder="Longitud" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} className={inputCls} />
            </div>
            <input placeholder="Capacidad" value={form.capacidad} onChange={(e) => setForm({ ...form, capacidad: e.target.value.replace(/\D/g, '') })} className={inputCls} />
            <input placeholder="Contacto" value={form.contacto} onChange={(e) => setForm({ ...form, contacto: e.target.value })} className={inputCls} />
            <input placeholder="Teléfono" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} className={inputCls} />
            <div>
              <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Servicios</p>
              <div className="flex flex-wrap gap-1">
                {SERVICIOS.map((s) => {
                  const on = form.servicios.includes(s);
                  return (
                    <button key={s} type="button" onClick={() => toggleServ(s)} aria-pressed={on} aria-label={`Servicio ${s}`}
                      className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold transition-colors"
                      style={on
                        ? { background: 'var(--flit-success)', color: '#fff' }
                        : { background: '#fff', border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>{s}</button>
                  );
                })}
              </div>
            </div>
            <textarea placeholder="Protocolo (markdown)" value={form.protocoloMd} onChange={(e) => setForm({ ...form, protocoloMd: e.target.value })} rows={3} className={inputCls + ' font-mono text-xs'} />
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
