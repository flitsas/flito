import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { FlitCard, flitInp } from '../components/flit/flitPageKit';
import { EstadoVista } from '../components/flit/Cargador';

interface PlanRow { id: number; anio: number; objetivoGeneral: string; presupuestoCop: string; estado: 'borrador' | 'aprobado' | 'cerrado'; aprobadoAt: string | null; optimisticV: number; }

const inputCls = flitInp;

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
        icono="flito-pesv"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }]}
        title="Plan anual PESV"
        subtitle="Objetivos SMART, metas, acciones, presupuesto · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo plan</GradientButton>}
      />

      <EstadoVista status={items.length === 0 ? 'empty' : 'ready'} emptyMessage="Sin planes registrados">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {items.map((p) => (
          <FlitCard key={p.id} className="!mt-0">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">Plan {p.anio}</span>
                <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">{p.objetivoGeneral}</p>
              </div>
              <EstadoPill estado={p.estado} />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--color-border)] pt-3">
              <span className="text-xs text-[color:var(--color-text-secondary)]">Presupuesto: <strong className="text-[color:var(--color-text-primary)]">$ {Number(p.presupuestoCop).toLocaleString('es-CO')}</strong></span>
              {p.estado === 'borrador' && (
                <GradientButton type="button" variant="success" size="sm" onClick={() => aprobar(p.id)}>Aprobar</GradientButton>
              )}
            </div>
          </FlitCard>
        ))}
      </div>
      </EstadoVista>

      {showCreate && (
        <FlitModal title="Nuevo plan anual PESV" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div>
              <label htmlFor="plan-anio" className="mb-1 block text-xs font-semibold text-[color:var(--color-text-primary)]">Año</label>
              <input id="plan-anio" type="number" value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label htmlFor="plan-objetivo" className="mb-1 block text-xs font-semibold text-[color:var(--color-text-primary)]">Objetivo general (≥ 20 chars)</label>
              <textarea id="plan-objetivo" value={form.objetivoGeneral} onChange={(e) => setForm({ ...form, objetivoGeneral: e.target.value })} rows={3} className={inputCls} placeholder="Reducir índice de accidentalidad anual en 20% mediante capacitación y monitoreo" />
            </div>
            <div>
              <label htmlFor="plan-presupuesto" className="mb-1 block text-xs font-semibold text-[color:var(--color-text-primary)]">Presupuesto COP</label>
              <input id="plan-presupuesto" type="number" value={form.presupuestoCop} onChange={(e) => setForm({ ...form, presupuestoCop: e.target.value })} className={inputCls} />
            </div>
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

function EstadoPill({ estado }: { estado: string }) {
  const tone: Record<string, ChipTone> = { borrador: 'warning', aprobado: 'success', cerrado: 'neutral' };
  return <StatusChip tone={tone[estado] ?? 'neutral'}>{estado}</StatusChip>;
}
