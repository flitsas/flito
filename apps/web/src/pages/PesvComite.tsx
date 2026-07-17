import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface Comite { id: number; nombre: string; periodicidad: string; activo: boolean; createdAt: string; }
interface Acta { id: number; numero: number; fecha: string; lugar: string | null; estado: 'borrador' | 'cerrada'; agendaMd: string | null; decisionesMd: string | null; }

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const cancelBtn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium';

export default function PesvComite() {
  const [items, setItems] = useState<Comite[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [nombre, setNombre] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ data: Comite[] }>('/pesv/comite');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (nombre.length < 3) { toast.error('Nombre ≥ 3 chars'); return; }
    try {
      await api.post('/pesv/comite', { nombre, periodicidad: 'trimestral' });
      toast.success('Comité creado');
      setShowCreate(false); setNombre('');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Comité de Seguridad Vial"
        subtitle="Composición y actas con numeración correlativa · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo comité</GradientButton>}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.length === 0 && <div className="bg-white p-8 text-center text-sm md:col-span-2 xl:col-span-3" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Sin comités registrados</div>}
        {items.map((c) => (
          <button key={c.id} onClick={() => setSelected(c.id)} className="flit-focus bg-white p-5 text-left transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
            style={selected === c.id ? { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-blue)', background: 'rgba(79,116,201,0.08)', boxShadow: 'var(--flit-shadow-card)' } : CARD}>
            <div className="mb-2 flex items-start justify-between">
              <h3 className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.nombre}</h3>
              {c.activo && <StatusChip tone="success">Activo</StatusChip>}
            </div>
            <p className="text-[11px] capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{c.periodicidad}</p>
          </button>
        ))}
      </div>

      {selected && <ActasPanel comiteId={selected} />}

      {showCreate && (
        <FlitModal title="Nuevo comité" onClose={() => setShowCreate(false)}>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Comité de Seguridad Vial" className={inputCls} />
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function ActasPanel({ comiteId }: { comiteId: number }) {
  const [actas, setActas] = useState<Acta[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ fecha: '', lugar: '', agendaMd: '', decisionesMd: '' });

  const load = async () => {
    try {
      const r = await api.get<{ data: Acta[] }>(`/pesv/comite/${comiteId}/actas`);
      setActas(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, [comiteId]);

  const create = async () => {
    if (!form.fecha) { toast.error('Fecha requerida'); return; }
    try {
      await api.post(`/pesv/comite/${comiteId}/actas`, form);
      toast.success('Acta creada');
      setShowNew(false); setForm({ fecha: '', lugar: '', agendaMd: '', decisionesMd: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const cerrar = async (actaId: number) => {
    if (!confirm('¿Cerrar acta? Se vuelve WORM (no admite ediciones posteriores).')) return;
    try {
      await api.post(`/pesv/comite/${comiteId}/actas/${actaId}/cerrar`);
      toast.success('Acta cerrada');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <section className="bg-white p-6" style={CARD}>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Actas del comité</h2>
        <button onClick={() => setShowNew(true)} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Nueva acta</button>
      </div>
      {actas.length === 0 && <p className="py-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin actas</p>}
      <div className="space-y-2">
        {actas.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-[10px] p-3" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
            <div>
              <span className="font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>#{a.numero}</span>
              <span className="ml-2 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{a.fecha}</span>
              {a.lugar && <span className="ml-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>· {a.lugar}</span>}
            </div>
            <div className="flex items-center gap-2">
              <StatusChip tone={a.estado === 'cerrada' ? 'neutral' : 'warning'}>{a.estado}</StatusChip>
              {a.estado === 'borrador' && (
                <button onClick={() => cerrar(a.id)} className="flit-focus inline-flex h-7 items-center rounded-[999px] px-2 text-[11px] font-semibold text-white" style={{ background: 'var(--flit-gradient-success)' }}>Cerrar</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <FlitModal title="Levantar acta" onClose={() => setShowNew(false)}>
          <div className="space-y-3">
            <input type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} className={inputCls} />
            <input value={form.lugar} onChange={(e) => setForm({ ...form, lugar: e.target.value })} placeholder="Lugar" className={inputCls} />
            <textarea value={form.agendaMd} onChange={(e) => setForm({ ...form, agendaMd: e.target.value })} rows={3} placeholder="Agenda (markdown)" className={`${inputCls} font-mono text-xs`} />
            <textarea value={form.decisionesMd} onChange={(e) => setForm({ ...form, decisionesMd: e.target.value })} rows={4} placeholder="Decisiones (markdown)" className={`${inputCls} font-mono text-xs`} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowNew(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </section>
  );
}
