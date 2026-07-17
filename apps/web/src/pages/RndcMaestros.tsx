import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';

type Tab = 'tenedores' | 'propietarios-carga' | 'destinatarios-carga';

interface Maestro {
  id: number;
  tipo?: string;
  tipoDoc: string;
  documento: string;
  nombre: string;
  direccion: string | null;
  ciudadDane: string | null;
  telefono: string | null;
  email: string | null;
  activo: boolean;
}

const TABS: { key: Tab; label: string; subtitle: string }[] = [
  { key: 'tenedores', label: 'Tenedores', subtitle: 'Quién tiene el vehículo (propietario/poseedor/tenedor)' },
  { key: 'propietarios-carga', label: 'Propietarios de carga', subtitle: 'Quién despacha la mercancía' },
  { key: 'destinatarios-carga', label: 'Destinatarios', subtitle: 'A quién va dirigida la carga' },
];

const TIPO_DOC = ['CC', 'CE', 'NIT', 'PAS', 'TI', 'RC'];

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcMaestros() {
  const [tab, setTab] = useState<Tab>('tenedores');
  const [items, setItems] = useState<Maestro[]>([]);
  const [editing, setEditing] = useState<Maestro | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ data: Maestro[] }>(`/rndc/${tab}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  const startNew = () => { setEditing({ id: 0, tipoDoc: 'CC', documento: '', nombre: '', direccion: null, ciudadDane: null, telefono: null, email: null, activo: true, tipo: tab === 'tenedores' ? 'tenedor' : undefined }); setShowForm(true); };
  const startEdit = (m: Maestro) => { setEditing(m); setShowForm(true); };

  const save = async () => {
    if (!editing) return;
    try {
      const payload: Record<string, unknown> = {
        tipoDoc: editing.tipoDoc, documento: editing.documento, nombre: editing.nombre,
        direccion: editing.direccion || null, ciudadDane: editing.ciudadDane || null,
        telefono: editing.telefono || null, email: editing.email || null,
      };
      if (tab === 'tenedores') payload.tipo = editing.tipo ?? 'tenedor';
      if (editing.id === 0) {
        await api.post(`/rndc/${tab}`, payload);
        toast.success('Creado');
      } else {
        await api.put(`/rndc/${tab}/${editing.id}`, payload);
        toast.success('Actualizado');
      }
      setShowForm(false); setEditing(null); load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const remove = async (m: Maestro) => {
    if (!confirm(`¿Desactivar "${m.nombre}"?`)) return;
    try {
      await api.delete(`/rndc/${tab}/${m.id}`);
      toast.success('Desactivado');
      load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const tabInfo = TABS.find((t) => t.key === tab)!;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Maestros RNDC"
        subtitle="Catálogos propios de partes para manifiestos electrónicos"
        actions={<GradientButton type="button" onClick={startNew}>Nuevo</GradientButton>}
      />

      <div className="flex flex-col gap-2">
        <div className="flex w-fit flex-wrap gap-2">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className="flit-focus rounded-[999px] px-4 py-2 text-sm font-semibold transition-colors"
                style={active
                  ? { background: 'var(--flit-blue)', color: '#fff' }
                  : { background: '#fff', border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-muted)' }}>
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{tabInfo.subtitle}</p>
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Documento</Th><Th>Nombre</Th>{tab === 'tenedores' && <Th>Tipo</Th>}<Th>Contacto</Th><Th></Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={tab === 'tenedores' ? 5 : 4} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin registros</td></tr>}
              {items.map((m) => (
                <tr key={m.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{m.tipoDoc} {m.documento}</td>
                  <td className="px-4 py-3 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{m.nombre}</td>
                  {tab === 'tenedores' && <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{m.tipo}</td>}
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{m.telefono ?? ''}{m.telefono && m.email ? ' · ' : ''}{m.email ?? ''}</td>
                  <td className="px-4 py-3 text-right text-xs">
                    <button onClick={() => startEdit(m)} className="mr-3 hover:underline" style={{ color: 'var(--flit-blue)' }}>Editar</button>
                    <button onClick={() => remove(m)} className="hover:underline" style={{ color: 'var(--flit-danger)' }}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && editing && (
        <FlitModal title={`${editing.id === 0 ? 'Nuevo' : 'Editar'} ${tabInfo.label.slice(0, -1).toLowerCase()}`} onClose={() => { setShowForm(false); setEditing(null); }}>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Tipo doc">
                <select value={editing.tipoDoc} onChange={(e) => setEditing({ ...editing, tipoDoc: e.target.value })} className={inputCls}>
                  {TIPO_DOC.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Documento" wide><input value={editing.documento} onChange={(e) => setEditing({ ...editing, documento: e.target.value })} className={inputCls} /></Field>
            </div>
            {tab === 'tenedores' && (
              <Field label="Tipo de tenedor">
                <select value={editing.tipo} onChange={(e) => setEditing({ ...editing, tipo: e.target.value })} className={inputCls}>
                  <option value="tenedor">Tenedor</option>
                  <option value="propietario">Propietario</option>
                  <option value="poseedor">Poseedor</option>
                </select>
              </Field>
            )}
            <Field label="Nombre o razón social"><input value={editing.nombre} onChange={(e) => setEditing({ ...editing, nombre: e.target.value })} className={inputCls} /></Field>
            <Field label="Dirección"><input value={editing.direccion ?? ''} onChange={(e) => setEditing({ ...editing, direccion: e.target.value })} className={inputCls} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Teléfono"><input value={editing.telefono ?? ''} onChange={(e) => setEditing({ ...editing, telefono: e.target.value })} className={inputCls} /></Field>
              <Field label="Email"><input type="email" value={editing.email ?? ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className={inputCls} /></Field>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => { setShowForm(false); setEditing(null); }} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={save}>Guardar</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'col-span-2' : ''}><label className="mb-1.5 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{label}</label>{children}</div>;
}
