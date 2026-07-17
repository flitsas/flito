import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

type Eval = 'apto' | 'apto_condicional' | 'no_apto';
type Estado = 'vinculado' | 'suspendido' | 'desvinculado';
interface Contrat {
  id: number; razonSocial: string; nit: string; contactoNombre: string | null; contactoEmail: string | null; contactoTelefono: string | null;
  pesvNivel: string | null; pesvVencimiento: string | null; evaluacion: Eval; proximaEvaluacion: string | null; estado: Estado; observaciones: string | null;
}

interface ContratBody {
  razonSocial: string; nit: string; evaluacion: Eval;
  contactoNombre?: string; contactoEmail?: string; contactoTelefono?: string;
  pesvNivel?: string; pesvVencimiento?: string; observaciones?: string;
}

const NIVELES = ['basico', 'estandar', 'avanzado', 'no_aplica'];
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvContratistas() {
  const [items, setItems] = useState<Contrat[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    razonSocial: '', nit: '', contactoNombre: '', contactoEmail: '', contactoTelefono: '',
    pesvNivel: '' as string, pesvVencimiento: '', evaluacion: 'apto_condicional' as Eval, observaciones: '',
  });

  const load = async () => {
    try {
      const r = await api.get<{ data: Contrat[] }>('/pesv/contratistas');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.razonSocial.length < 3 || form.nit.length < 5) { toast.error('Razón social ≥3 y NIT ≥5'); return; }
    try {
      const body: ContratBody = { razonSocial: form.razonSocial, nit: form.nit, evaluacion: form.evaluacion };
      if (form.contactoNombre) body.contactoNombre = form.contactoNombre;
      if (form.contactoEmail) body.contactoEmail = form.contactoEmail;
      if (form.contactoTelefono) body.contactoTelefono = form.contactoTelefono;
      if (form.pesvNivel) body.pesvNivel = form.pesvNivel;
      if (form.pesvVencimiento) body.pesvVencimiento = form.pesvVencimiento;
      if (form.observaciones) body.observaciones = form.observaciones;
      await api.post('/pesv/contratistas', body);
      toast.success('Contratista vinculado');
      setShowCreate(false);
      setForm({ razonSocial: '', nit: '', contactoNombre: '', contactoEmail: '', contactoTelefono: '', pesvNivel: '', pesvVencimiento: '', evaluacion: 'apto_condicional', observaciones: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const vencidos = items.filter((c) => c.pesvVencimiento && c.pesvVencimiento < today).length;
  const proximos = items.filter((c) => c.pesvVencimiento && c.pesvVencimiento >= today && c.pesvVencimiento <= addDays(today, 60)).length;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Contratistas terceros"
        subtitle="Evaluación PESV de aliados estratégicos · Paso 18 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo contratista</GradientButton>}
      />

      {(vencidos > 0 || proximos > 0) && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {vencidos > 0 && (
            <div className="rounded-[18px] p-5" style={{ background: 'rgba(228,61,48,0.10)', border: '1px solid rgba(228,61,48,0.20)' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-danger)' }}>Certificados vencidos</p>
              <div className="mt-1 text-3xl font-bold" style={{ color: 'var(--flit-danger)' }}>{vencidos}</div>
            </div>
          )}
          {proximos > 0 && (
            <div className="rounded-[18px] p-5" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.20)' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-warning)' }}>Vencen ≤60 días</p>
              <div className="mt-1 text-3xl font-bold" style={{ color: 'var(--flit-warning)' }}>{proximos}</div>
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Razón social</Th><Th>NIT</Th><Th>Nivel PESV</Th><Th>Vencimiento</Th><Th>Evaluación</Th><Th>Estado</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin contratistas registrados</td></tr>}
              {items.map((c) => {
                const v = c.pesvVencimiento;
                const venc = v && v < today;
                const prox = v && v >= today && v <= addDays(today, 60);
                return (
                  <tr key={c.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{c.razonSocial}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{c.nit}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{c.pesvNivel ?? '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      {v ? (
                        <span className="font-mono" style={{ color: venc ? 'var(--flit-danger)' : prox ? 'var(--flit-warning)' : 'var(--flit-text-secondary)', fontWeight: venc || prox ? 600 : 400 }}>{v}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3"><EvalPill v={c.evaluacion} /></td>
                    <td className="px-4 py-3"><EstadoPill v={c.estado} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <FlitModal title="Vincular contratista" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Razón social" value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} className={inputCls} />
            <input placeholder="NIT" value={form.nit} onChange={(e) => setForm({ ...form, nit: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Contacto nombre" value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} className={inputCls} />
              <input placeholder="Contacto teléfono" value={form.contactoTelefono} onChange={(e) => setForm({ ...form, contactoTelefono: e.target.value })} className={inputCls} />
            </div>
            <input type="email" placeholder="Contacto email" value={form.contactoEmail} onChange={(e) => setForm({ ...form, contactoEmail: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <select value={form.pesvNivel} onChange={(e) => setForm({ ...form, pesvNivel: e.target.value })} className={inputCls}>
                <option value="">— Nivel PESV —</option>
                {NIVELES.map((n) => <option key={n} value={n}>{n.replace('_', ' ')}</option>)}
              </select>
              <input type="date" placeholder="Vencimiento PESV" value={form.pesvVencimiento} onChange={(e) => setForm({ ...form, pesvVencimiento: e.target.value })} className={inputCls} />
            </div>
            <select value={form.evaluacion} onChange={(e) => setForm({ ...form, evaluacion: e.target.value as Eval })} className={inputCls}>
              <option value="apto">apto</option>
              <option value="apto_condicional">apto condicional</option>
              <option value="no_apto">no apto</option>
            </select>
            <textarea placeholder="Observaciones" value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value })} rows={3} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Vincular</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }

function EvalPill({ v }: { v: Eval }) {
  const tone: Record<Eval, ChipTone> = { apto: 'success', apto_condicional: 'warning', no_apto: 'danger' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
function EstadoPill({ v }: { v: Estado }) {
  const tone: Record<Estado, ChipTone> = { vinculado: 'active', suspendido: 'warning', desvinculado: 'neutral' };
  return <StatusChip tone={tone[v]}>{v}</StatusChip>;
}
