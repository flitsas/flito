import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface PlanRow { id: number; anio: number; objetivoGeneral: string; presupuestoCop: string; estado: 'borrador' | 'aprobado' | 'cerrado'; aprobadoAt: string | null; optimisticV: number; }

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvPlan() {
  const [items, setItems] = useState<PlanRow[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ anio: new Date().getFullYear(), objetivoGeneral: '', presupuestoCop: '0' });

  const load = async () => {
    try {
      const r = await api.get<{ data: PlanRow[] }>('/pesv/plan');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.objetivoGeneral.length < 20) { toast.error('Objetivo general ≥ 20 chars'); return; }
    try {
      await api.post('/pesv/plan', form);
      toast.success('Plan creado en borrador');
      setShowCreate(false);
      setForm({ anio: new Date().getFullYear(), objetivoGeneral: '', presupuestoCop: '0' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const aprobar = async (id: number) => {
    if (!confirm('¿Aprobar plan? El plan podrá ejecutarse pero ya no se puede editar la cabecera.')) return;
    try {
      await api.post(`/pesv/plan/${id}/aprobar`);
      toast.success('Plan aprobado');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Plan anual PESV"
        subtitle="Objetivos SMART, metas, acciones, presupuesto · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo plan</GradientButton>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {items.length === 0 && <div className="bg-white p-8 text-center text-sm lg:col-span-2" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Sin planes registrados</div>}
        {items.map((p) => (
          <div key={p.id} className="bg-white p-6" style={CARD}>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Plan {p.anio}</span>
                <p className="mt-1 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{p.objetivoGeneral}</p>
              </div>
              <EstadoPill estado={p.estado} />
            </div>
            <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Presupuesto: <strong style={{ color: 'var(--flit-text-primary)' }}>$ {Number(p.presupuestoCop).toLocaleString('es-CO')}</strong></span>
              {p.estado === 'borrador' && (
                <button onClick={() => aprobar(p.id)} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Aprobar</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <FlitModal title="Nuevo plan anual PESV" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Año</label>
              <input type="number" value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Objetivo general (≥ 20 chars)</label>
              <textarea value={form.objetivoGeneral} onChange={(e) => setForm({ ...form, objetivoGeneral: e.target.value })} rows={3} className={inputCls} placeholder="Reducir índice de accidentalidad anual en 20% mediante capacitación y monitoreo" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Presupuesto COP</label>
              <input type="number" value={form.presupuestoCop} onChange={(e) => setForm({ ...form, presupuestoCop: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function EstadoPill({ estado }: { estado: string }) {
  const tone: Record<string, ChipTone> = { borrador: 'warning', aprobado: 'success', cerrado: 'neutral' };
  return <StatusChip tone={tone[estado] ?? 'neutral'}>{estado}</StatusChip>;
}
