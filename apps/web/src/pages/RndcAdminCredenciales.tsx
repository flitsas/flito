import { useEffect, useState, FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';

interface Credencial {
  id: number;
  empresaNit: string;
  habilitadorNit: string;
  numNit: string;
  ambiente: string;
  activo: boolean;
  notas: string | null;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

const initialForm = {
  empresaNit: '',
  habilitadorNit: '',
  numNit: '',
  claveQR: '',
  ambiente: 'sandbox' as 'sandbox' | 'produccion',
  notas: '',
};

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 font-mono text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcAdminCredenciales() {
  const [items, setItems] = useState<Credencial[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: Credencial[] }>('/rndc/credenciales');
      setItems(r.data ?? []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.empresaNit || !form.habilitadorNit || !form.numNit || !form.claveQR) {
      toast.error('Complete todos los campos obligatorios');
      return;
    }
    setSaving(true);
    try {
      await api.post('/rndc/credenciales', form);
      toast.success('Credencial guardada y cifrada');
      setShowForm(false);
      setForm(initialForm);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const desactivar = async (id: number) => {
    if (!confirm('¿Desactivar esta credencial? Los envíos a RNDC con este ambiente quedarán bloqueados.')) return;
    try {
      await api.delete(`/rndc/credenciales/${id}`);
      toast.success('Credencial desactivada');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Credenciales RNDC"
        subtitle="Usuario WS habilitado por Mintransporte. La clave se cifra con AES-256-GCM antes de persistir."
        actions={<GradientButton type="button" onClick={() => setShowForm((s) => !s)}>Nueva credencial</GradientButton>}
      />

      {showForm && (
        <form onSubmit={submit} className="grid grid-cols-2 gap-4 bg-white p-6" style={CARD}>
          <Field label="NIT empresa" value={form.empresaNit} onChange={(v) => setForm({ ...form, empresaNit: v })} placeholder="900000000" />
          <Field label="NIT habilitador" value={form.habilitadorNit} onChange={(v) => setForm({ ...form, habilitadorNit: v })} placeholder="900000000" />
          <Field label="numNit (usuario WS)" value={form.numNit} onChange={(v) => setForm({ ...form, numNit: v })} placeholder="usuario" />
          <Field label="claveQR" value={form.claveQR} onChange={(v) => setForm({ ...form, claveQR: v })} placeholder="contraseña RNDC" type="password" />
          <div>
            <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Ambiente</label>
            <select
              value={form.ambiente}
              onChange={(e) => setForm({ ...form, ambiente: e.target.value as 'sandbox' | 'produccion' })}
              className={inputCls}
            >
              <option value="sandbox">Sandbox (pruebas)</option>
              <option value="produccion">Producción</option>
            </select>
          </div>
          <Field label="Notas" value={form.notas} onChange={(v) => setForm({ ...form, notas: v })} placeholder="opcional" />
          <div className="col-span-2 mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => { setShowForm(false); setForm(initialForm); }}
              className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
              Cancelar
            </button>
            <GradientButton type="submit" disabled={saving}>{saving ? 'Guardando...' : 'Guardar y cifrar'}</GradientButton>
          </div>
        </form>
      )}

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>NIT empresa</Th><Th>numNit</Th><Th>Ambiente</Th><Th>Estado</Th><Th>Versión clave</Th><Th>Actualizada</Th><Th className="text-right">Acciones</Th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-4 py-6 text-center" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center" style={{ color: 'var(--flit-text-muted)' }}>Sin credenciales configuradas</td></tr>
              )}
              {items.map((c) => (
                <tr key={c.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono" style={{ color: 'var(--flit-text-primary)' }}>{c.empresaNit}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-primary)' }}>{c.numNit}</td>
                  <td className="px-4 py-3 capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{c.ambiente}</td>
                  <td className="px-4 py-3"><StatusChip tone={c.activo ? 'success' : 'neutral'}>{c.activo ? 'Activa' : 'Inactiva'}</StatusChip></td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>v{c.keyVersion}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-muted)' }}>{new Date(c.updatedAt).toLocaleString('es-CO')}</td>
                  <td className="px-4 py-3 text-right">
                    {c.activo && (
                      <button onClick={() => desactivar(c.id)} className="text-xs hover:underline" style={{ color: 'var(--flit-danger)' }}>
                        Desactivar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide ${className}`} style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>{label}</label>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
        autoComplete="off"
      />
    </div>
  );
}
