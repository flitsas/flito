import { useEffect, useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';

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

const inputCls = 'control mono w-full';

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

  const columnas: ColumnaTabla<Credencial>[] = [
    { key: 'empresa', header: 'NIT empresa', render: (c) => <span className="mono text-[color:var(--color-text-primary)]">{c.empresaNit}</span> },
    { key: 'numnit', header: 'numNit', render: (c) => <span className="text-[color:var(--color-text-primary)]">{c.numNit}</span> },
    { key: 'ambiente', header: 'Ambiente', render: (c) => <span className="capitalize text-[color:var(--color-text-secondary)]">{c.ambiente}</span> },
    { key: 'estado', header: 'Estado', render: (c) => <StatusChip tone={c.activo ? 'success' : 'neutral'}>{c.activo ? 'Activa' : 'Inactiva'}</StatusChip> },
    { key: 'version', header: 'Versión clave', render: (c) => <span className="text-[color:var(--color-text-secondary)]">v{c.keyVersion}</span> },
    { key: 'actualizada', header: 'Actualizada', render: (c) => <span className="text-[color:var(--color-text-tertiary)]">{new Date(c.updatedAt).toLocaleString('es-CO')}</span> },
    { key: 'acciones', header: 'Acciones', acciones: true, align: 'right', render: (c) => (
      c.activo ? <GradientButton type="button" size="sm" variant="alerta" onClick={() => desactivar(c.id)}>Desactivar</GradientButton> : null
    ) },
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Credenciales RNDC"
        subtitle="Usuario WS habilitado por Mintransporte. La clave se cifra con AES-256-GCM antes de persistir."
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }]}
        actions={<GradientButton type="button" onClick={() => setShowForm((s) => !s)}>Nueva credencial</GradientButton>}
      />

      {showForm && (
        <form onSubmit={submit} className="card grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
          <Field label="NIT empresa" value={form.empresaNit} onChange={(v) => setForm({ ...form, empresaNit: v })} placeholder="900000000" />
          <Field label="NIT habilitador" value={form.habilitadorNit} onChange={(v) => setForm({ ...form, habilitadorNit: v })} placeholder="900000000" />
          <Field label="numNit (usuario WS)" value={form.numNit} onChange={(v) => setForm({ ...form, numNit: v })} placeholder="usuario" />
          <Field label="claveQR" value={form.claveQR} onChange={(v) => setForm({ ...form, claveQR: v })} placeholder="contraseña RNDC" type="password" />
          <label className="campo">
            <span className="etiqueta">Ambiente</span>
            <select
              value={form.ambiente}
              onChange={(e) => setForm({ ...form, ambiente: e.target.value as 'sandbox' | 'produccion' })}
              className={inputCls}
            >
              <option value="sandbox">Sandbox (pruebas)</option>
              <option value="produccion">Producción</option>
            </select>
          </label>
          <Field label="Notas" value={form.notas} onChange={(v) => setForm({ ...form, notas: v })} placeholder="opcional" />
          <div className="mt-2 flex flex-wrap justify-end gap-2 sm:col-span-2">
            <GradientButton type="button" variant="alerta" onClick={() => { setShowForm(false); setForm(initialForm); }}>
              Cancelar
            </GradientButton>
            <GradientButton type="submit" disabled={saving}>{saving ? 'Guardando...' : 'Guardar y cifrar'}</GradientButton>
          </div>
        </form>
      )}

      <DataTable
        ariaLabel="Credenciales RNDC"
        columnas={columnas}
        filas={items}
        getKey={(c) => String(c.id)}
        status={loading ? 'loading' : undefined}
        emptyMessage="Sin credenciales configuradas"
      />
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="campo">
      <span className="etiqueta">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
        autoComplete="off"
      />
    </label>
  );
}
