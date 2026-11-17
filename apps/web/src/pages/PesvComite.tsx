import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { FlitCard, flitInp } from '../components/flit/flitPageKit';
import { EstadoVista } from '../components/flit/Cargador';
import { ListaFila } from '../components/flit/Bloques';

interface Comite { id: number; nombre: string; periodicidad: string; activo: boolean; createdAt: string; }
interface Acta { id: number; numero: number; fecha: string; lugar: string | null; estado: 'borrador' | 'cerrada'; agendaMd: string | null; decisionesMd: string | null; }

const inputCls = flitInp;

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
        icono="flito-pesv"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }]}
        title="Comité de Seguridad Vial"
        subtitle="Composición y actas con numeración correlativa · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo comité</GradientButton>}
      />

      <EstadoVista status={items.length === 0 ? 'empty' : 'ready'} emptyMessage="Sin comités registrados">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)}
              className={`flit-focus rounded-[9px] border p-5 text-left transition-colors hover:border-[color:var(--kit-azul)] ${selected === c.id ? 'border-[color:var(--kit-azul)] bg-[var(--kit-hover)]' : 'border-[color:var(--color-border)] bg-[var(--color-surface-elevated)]'}`}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="font-semibold text-[color:var(--color-text-primary)]">{c.nombre}</h3>
                {c.activo && <StatusChip tone="success">Activo</StatusChip>}
              </div>
              <p className="text-[11px] capitalize text-[color:var(--color-text-secondary)]">{c.periodicidad}</p>
            </button>
          ))}
        </div>
      </EstadoVista>

      {selected && <ActasPanel comiteId={selected} />}

      {showCreate && (
        <FlitModal title="Nuevo comité" onClose={() => setShowCreate(false)}>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Comité de Seguridad Vial" className={inputCls} />
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
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
    <FlitCard>
      <div className="card__cabeza">
        <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Actas del comité</h2>
        <GradientButton type="button" size="sm" onClick={() => setShowNew(true)}>Nueva acta</GradientButton>
      </div>
      {actas.length === 0 && <p className="py-6 text-center text-sm text-[color:var(--color-text-tertiary)]">Sin actas</p>}
      <ListaFila filas={actas.map((a) => ({
        id: String(a.id),
        titulo: <><span className="font-mono text-xs font-normal text-[color:var(--color-text-tertiary)]">#{a.numero}</span><span className="ml-2">{a.fecha}</span></>,
        detalle: a.lugar ? <>· {a.lugar}</> : undefined,
        extra: <StatusChip tone={a.estado === 'cerrada' ? 'neutral' : 'warning'}>{a.estado}</StatusChip>,
        accion: a.estado === 'borrador'
          ? <GradientButton type="button" variant="success" size="sm" onClick={() => cerrar(a.id)}>Cerrar</GradientButton>
          : undefined,
      }))} />

      {showNew && (
        <FlitModal title="Levantar acta" onClose={() => setShowNew(false)}>
          <div className="space-y-3">
            <input type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} className={inputCls} />
            <input value={form.lugar} onChange={(e) => setForm({ ...form, lugar: e.target.value })} placeholder="Lugar" className={inputCls} />
            <textarea value={form.agendaMd} onChange={(e) => setForm({ ...form, agendaMd: e.target.value })} rows={3} placeholder="Agenda (markdown)" className={`${inputCls} font-mono text-xs`} />
            <textarea value={form.decisionesMd} onChange={(e) => setForm({ ...form, decisionesMd: e.target.value })} rows={4} placeholder="Decisiones (markdown)" className={`${inputCls} font-mono text-xs`} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowNew(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </FlitCard>
  );
}
