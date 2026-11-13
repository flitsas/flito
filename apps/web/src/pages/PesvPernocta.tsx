import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { FlitCard, flitInp } from '../components/flit/flitPageKit';
import { EstadoVista } from '../components/flit/Cargador';

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
const inputCls = flitInp;

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
        icono="flito-pesv"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }]}
        title="Zonas de pernocta"
        subtitle="PESV · Paso 4 · Zonas certificadas con contacto y protocolos de emergencia"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva zona</GradientButton>}
      />

      <EstadoVista status={items.length === 0 ? 'empty' : 'ready'} emptyMessage="Sin zonas registradas">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {items.map((p) => (
          <FlitCard key={p.id} className="!mt-0">
            <div className="mb-2 flex items-start justify-between gap-2">
              <h3 className="font-semibold text-[color:var(--color-text-primary)]">{p.nombre}</h3>
              <GradientButton type="button" variant="alerta" size="sm" onClick={() => archivar(p.id)}>Archivar</GradientButton>
            </div>
            {(p.lat && p.lng) && <p className="font-mono text-[11px] text-[color:var(--color-text-tertiary)]">{p.lat}, {p.lng}</p>}
            {p.capacidad && <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">Capacidad: <strong className="text-[color:var(--color-text-primary)]">{p.capacidad}</strong> vehículos</p>}
            {p.contacto && <p className="text-xs text-[color:var(--color-text-secondary)]">Contacto: {p.contacto} {p.telefono && `· ${p.telefono}`}</p>}
            {p.servicios.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {p.servicios.map((s) => <StatusChip key={s} tone="success">{s}</StatusChip>)}
              </div>
            )}
          </FlitCard>
        ))}
      </div>
      </EstadoVista>

      {showCreate && (
        <FlitModal title="Nueva zona de pernocta" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Nombre (Estación La Línea)" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input placeholder="Latitud" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} className={inputCls} />
              <input placeholder="Longitud" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} className={inputCls} />
            </div>
            <input placeholder="Capacidad" value={form.capacidad} onChange={(e) => setForm({ ...form, capacidad: e.target.value.replace(/\D/g, '') })} className={inputCls} />
            <input placeholder="Contacto" value={form.contacto} onChange={(e) => setForm({ ...form, contacto: e.target.value })} className={inputCls} />
            <input placeholder="Teléfono" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} className={inputCls} />
            <div>
              <p className="mb-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">Servicios</p>
              <div className="flex flex-wrap gap-1">
                {SERVICIOS.map((s) => {
                  const on = form.servicios.includes(s);
                  return (
                    <button key={s} type="button" onClick={() => toggleServ(s)} aria-pressed={on} aria-label={`Servicio ${s}`}
                      className={`flit-focus inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition-colors ${on
                        ? 'border-[color:var(--kit-verde)] bg-[var(--kit-verde)] text-[color:var(--kit-tinta-fija)]'
                        : 'border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--kit-azul)] hover:text-[color:var(--color-action)]'}`}>{s}</button>
                  );
                })}
              </div>
            </div>
            <textarea placeholder="Protocolo (markdown)" value={form.protocoloMd} onChange={(e) => setForm({ ...form, protocoloMd: e.target.value })} rows={3} className={inputCls + ' font-mono text-xs'} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
