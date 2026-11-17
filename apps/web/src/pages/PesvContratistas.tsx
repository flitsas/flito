import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import KpiCard from '../components/flit/KpiCard';
import { flitInp } from '../components/flit/flitPageKit';

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
const inputCls = flitInp;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];

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
        icono="flito-pesv"
        miga={MIGA}
        subtitle="Evaluación PESV de aliados estratégicos · Paso 18 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo contratista</GradientButton>}
      />

      {(vencidos > 0 || proximos > 0) && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {vencidos > 0 && <KpiCard label="Certificados vencidos" value={vencidos} pendiente />}
          {proximos > 0 && <KpiCard label="Vencen ≤60 días" value={proximos} pendiente />}
        </div>
      )}

      <section className="card p-0">
        <DataTable<Contrat>
          ariaLabel="Contratistas terceros"
          columnas={columnas(today)}
          filas={items}
          getKey={(c) => String(c.id)}
          emptyMessage="Sin contratistas registrados"
        />
      </section>

      {showCreate && (
        <FlitModal title="Vincular contratista" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Razón social" value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} className={inputCls} />
            <input placeholder="NIT" value={form.nit} onChange={(e) => setForm({ ...form, nit: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input placeholder="Contacto nombre" value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} className={inputCls} />
              <input placeholder="Contacto teléfono" value={form.contactoTelefono} onChange={(e) => setForm({ ...form, contactoTelefono: e.target.value })} className={inputCls} />
            </div>
            <input type="email" placeholder="Contacto email" value={form.contactoEmail} onChange={(e) => setForm({ ...form, contactoEmail: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
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

function columnas(today: string): ColumnaTabla<Contrat>[] {
  return [
    { key: 'razon', header: 'Razón social', render: (c) => <span className="text-sm font-medium text-[color:var(--color-text-primary)]">{c.razonSocial}</span> },
    { key: 'nit', header: 'NIT', render: (c) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{c.nit}</span> },
    { key: 'nivel', header: 'Nivel PESV', render: (c) => <span className="text-xs text-[color:var(--color-text-secondary)]">{c.pesvNivel ?? '—'}</span> },
    {
      key: 'venc', header: 'Vencimiento', render: (c) => {
        const v = c.pesvVencimiento;
        if (!v) return <span className="text-xs">—</span>;
        const venc = v < today;
        const prox = v >= today && v <= addDays(today, 60);
        const color = venc ? 'text-[color:var(--kit-rojo-texto)] font-semibold' : prox ? 'text-[color:var(--kit-naranja-texto)] font-semibold' : 'text-[color:var(--color-text-secondary)]';
        return <span className={`font-mono text-xs ${color}`}>{v}</span>;
      },
    },
    { key: 'eval', header: 'Evaluación', render: (c) => <EvalPill v={c.evaluacion} /> },
    { key: 'estado', header: 'Estado', render: (c) => <EstadoPill v={c.estado} /> },
  ];
}

function EvalPill({ v }: { v: Eval }) {
  const tone: Record<Eval, ChipTone> = { apto: 'success', apto_condicional: 'warning', no_apto: 'danger' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
function EstadoPill({ v }: { v: Estado }) {
  const tone: Record<Estado, ChipTone> = { vinculado: 'active', suspendido: 'warning', desvinculado: 'neutral' };
  return <StatusChip tone={tone[v]}>{v}</StatusChip>;
}
