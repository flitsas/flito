import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

type Tipo = 'politica' | 'lecciones_aprendidas' | 'capacitacion' | 'recordatorio' | 'otro';
interface Com { id: number; tipo: Tipo; asunto: string; cuerpoMd: string; destinatariosRoles: string[]; publicadoAt: string | null; vencimientoAcuse: string | null; acusesCount: number; createdAt: string; }
interface ComBody { tipo: Tipo; asunto: string; cuerpoMd: string; destinatariosRoles: string[]; vencimientoAcuse?: string; }

const TIPOS: Tipo[] = ['politica', 'lecciones_aprendidas', 'capacitacion', 'recordatorio', 'otro'];
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const cancelBtn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium';
const ghostBtn = 'flit-focus inline-flex h-8 items-center rounded-[999px] border bg-white px-2 text-xs font-medium';

export default function PesvComunicaciones() {
  const [items, setItems] = useState<Com[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ tipo: 'politica' as Tipo, asunto: '', cuerpoMd: '', destinatariosRoles: [] as string[], vencimientoAcuse: '' });
  const [selected, setSelected] = useState<Com | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ data: Com[] }>('/pesv/comunicaciones');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.asunto.length < 3 || form.cuerpoMd.length < 20) { toast.error('Asunto ≥3 y cuerpo ≥20 chars'); return; }
    try {
      const body: ComBody = { tipo: form.tipo, asunto: form.asunto, cuerpoMd: form.cuerpoMd, destinatariosRoles: form.destinatariosRoles };
      if (form.vencimientoAcuse) body.vencimientoAcuse = form.vencimientoAcuse;
      await api.post('/pesv/comunicaciones', body);
      toast.success('Comunicación creada');
      setShowCreate(false);
      setForm({ tipo: 'politica', asunto: '', cuerpoMd: '', destinatariosRoles: [], vencimientoAcuse: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const publicar = async (id: number) => {
    if (!confirm('¿Publicar comunicación? Los destinatarios podrán acusar recibo.')) return;
    try {
      await api.post(`/pesv/comunicaciones/${id}/publicar`);
      toast.success('Publicada');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const acusar = async (id: number) => {
    try {
      const r = await api.post<{ ok: boolean; alreadyAcknowledged?: boolean }>(`/pesv/comunicaciones/${id}/acusar`);
      if (r.alreadyAcknowledged) toast('Ya habías acusado recibo previamente');
      else toast.success('Acuse de recibo registrado');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const toggleRol = (rol: string) => {
    setForm((f) => ({ ...f, destinatariosRoles: f.destinatariosRoles.includes(rol) ? f.destinatariosRoles.filter((r) => r !== rol) : [...f.destinatariosRoles, rol] }));
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Comunicaciones internas"
        subtitle="Publicación con acuse de recibo · Pasos 1.8 + 24"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva comunicación</GradientButton>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {items.length === 0 && <div className="bg-white p-8 text-center text-sm lg:col-span-2" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Sin comunicaciones</div>}
        {items.map((c) => (
          <div key={c.id} className="bg-white p-6" style={CARD}>
            <div className="mb-2 flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{c.tipo.replace(/_/g, ' ')}</span>
                <h3 className="mt-1 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.asunto}</h3>
              </div>
              <StatusChip tone={c.publicadoAt ? 'success' : 'neutral'}>{c.publicadoAt ? 'Publicada' : 'Borrador'}</StatusChip>
            </div>
            {c.destinatariosRoles.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {c.destinatariosRoles.map((r) => <span key={r} className="inline-flex items-center rounded-[999px] px-2 py-0.5 text-[10px] font-medium" style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>{r}</span>)}
              </div>
            )}
            <div className="mt-4 flex items-center justify-between border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{c.acusesCount} acuses{c.vencimientoAcuse ? ` · vence ${c.vencimientoAcuse}` : ''}</span>
              <div className="flex gap-1">
                <button onClick={() => setSelected(c)} className={ghostBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Ver</button>
                {!c.publicadoAt && <button onClick={() => publicar(c.id)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-2 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Publicar</button>}
                {c.publicadoAt && <button onClick={() => acusar(c.id)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-2 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-success)' }}>Acusar</button>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <FlitModal title={selected.asunto} onClose={() => setSelected(null)}>
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{selected.tipo.replace(/_/g, ' ')}</span>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] p-4 text-xs" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}>{selected.cuerpoMd}</pre>
          <p className="mt-3 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Creada {selected.createdAt.slice(0, 10)}{selected.publicadoAt ? ` · publicada ${selected.publicadoAt.slice(0, 10)}` : ''}</p>
        </FlitModal>
      )}

      {showCreate && (
        <FlitModal title="Nueva comunicación" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as Tipo })} className={inputCls}>
              {TIPOS.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <input placeholder="Asunto (≥3 chars)" value={form.asunto} onChange={(e) => setForm({ ...form, asunto: e.target.value })} className={inputCls} />
            <textarea placeholder="Cuerpo en markdown (≥20 chars)" value={form.cuerpoMd} onChange={(e) => setForm({ ...form, cuerpoMd: e.target.value })} rows={6} className={`${inputCls} font-mono text-xs`} />
            <div>
              <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Roles destinatarios (vacío = todos)</p>
              <div className="flex flex-wrap gap-1">
                {['conductor', 'supervisor_flota', 'lider_pesv', 'admin'].map((r) => (
                  <button key={r} type="button" onClick={() => toggleRol(r)}
                    className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-medium"
                    style={form.destinatariosRoles.includes(r) ? { background: 'var(--flit-gradient-primary)', color: '#fff' } : { border: '1px solid var(--flit-border-input)', background: '#fff', color: 'var(--flit-text-secondary)' }}>{r.replace(/_/g, ' ')}</button>
                ))}
              </div>
            </div>
            <input type="date" placeholder="Vencimiento acuse (opt)" value={form.vencimientoAcuse} onChange={(e) => setForm({ ...form, vencimientoAcuse: e.target.value })} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
