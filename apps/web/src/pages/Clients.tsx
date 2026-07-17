import { useEffect, useState, FormEvent } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { flitInp, FlitCard, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

interface Client {
  id: number; name: string; document: string | null; documentType: string | null;
  phone: string | null; email: string | null; address: string | null;
  city: string | null; notes: string | null; active: boolean;
}

export default function Clients() {
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', document: '', documentType: 'NIT', phone: '', email: '', address: '', city: '', notes: '' });

  const load = () => { api.get<Client[]>('/clients').then(setClients); };
  useEffect(() => { load(); }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body: Record<string, string> = { ...form };
      Object.keys(body).forEach((k) => { if (!body[k]) delete body[k]; });
      await api.post('/clients', body);
      toast.success('Cliente creado');
      setShowForm(false);
      setForm({ name: '', document: '', documentType: 'NIT', phone: '', email: '', address: '', city: '', notes: '' });
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      toast.error(msg);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Cartera de clientes"
        subtitle={`${clients.length} registros`}
        actions={<GradientButton type="button" onClick={() => setShowForm(!showForm)}>Nuevo cliente</GradientButton>}
      />

      {showForm && (
        <FlitCard>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Nuevo cliente</h3>
          <form onSubmit={handleCreate}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre o razón social *" className={flitInp} />
              <input value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} placeholder="NIT / Cédula" className={flitInp} />
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Teléfono" className={flitInp} />
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={flitInp} />
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Ciudad" className={flitInp} />
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Dirección" className={`${flitInp} col-span-2`} />
            </div>
            <div className="mt-4 flex gap-2">
              <GradientButton type="submit">Guardar</GradientButton>
              <button type="button" onClick={() => setShowForm(false)} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
            </div>
          </form>
        </FlitCard>
      )}

      <div className="space-y-2">
        {clients.map((c) => (
          <FlitCard key={c.id} className="!py-4">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px]" style={{ background: 'var(--flit-bg-app)' }}>
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6} style={{ color: 'var(--flit-blue)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
                </svg>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 lg:grid-cols-5">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Nombre</p>
                  <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Documento</p>
                  <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.documentType} {c.document || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Teléfono</p>
                  <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.phone || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Email</p>
                  <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.email || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Ciudad</p>
                  <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.city || '—'}</p>
                </div>
              </div>
            </div>
          </FlitCard>
        ))}
      </div>
    </div>
  );
}
