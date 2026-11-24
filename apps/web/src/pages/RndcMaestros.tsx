import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import Pestanas from '../components/flit/Pestanas';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';

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

const inputCls = 'control w-full';
const TXT2 = 'text-xs text-[color:var(--color-text-secondary)]';

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

  const columnas: ColumnaTabla<Maestro>[] = [
    { key: 'documento', header: 'Documento', render: (m) => <span className={TXT2}>{m.tipoDoc} {m.documento}</span> },
    { key: 'nombre', header: 'Nombre', render: (m) => <span className="text-xs font-semibold text-[color:var(--color-text-primary)]">{m.nombre}</span> },
    ...(tab === 'tenedores' ? [{ key: 'tipo', header: 'Tipo', render: (m: Maestro) => <span className={`${TXT2} capitalize`}>{m.tipo}</span> }] : []),
    { key: 'contacto', header: 'Contacto', render: (m) => <span className={TXT2}>{m.telefono ?? ''}{m.telefono && m.email ? ' · ' : ''}{m.email ?? ''}</span> },
    { key: 'acciones', header: '', acciones: true, align: 'right', render: (m) => (
      <span className="inline-flex flex-wrap justify-end gap-2">
        <GradientButton type="button" size="sm" variant="ghost" onClick={() => startEdit(m)}>Editar</GradientButton>
        <GradientButton type="button" size="sm" variant="alerta" onClick={() => remove(m)}>Eliminar</GradientButton>
      </span>
    ) },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Maestros RNDC"
        subtitle="Catálogos propios de partes para manifiestos electrónicos"
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }]}
        actions={<GradientButton type="button" onClick={startNew}>Nuevo</GradientButton>}
      />

      <div className="flex min-w-0 flex-col gap-2">
        <Pestanas
          etiqueta="Maestros RNDC"
          pestanas={TABS.map((t) => ({ id: t.key, etiqueta: t.label }))}
          activa={tab}
          onElegir={(k) => setTab(k as Tab)}
        />
        <p className="text-xs text-[color:var(--color-text-tertiary)]">{tabInfo.subtitle}</p>
      </div>

      <DataTable
        ariaLabel={tabInfo.label}
        columnas={columnas}
        filas={items}
        getKey={(m) => String(m.id)}
        emptyMessage="Sin registros"
      />

      {showForm && editing && (
        <FlitModal title={`${editing.id === 0 ? 'Nuevo' : 'Editar'} ${tabInfo.label.slice(0, -1).toLowerCase()}`} onClose={() => { setShowForm(false); setEditing(null); }} icono="empresas">
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Teléfono"><input value={editing.telefono ?? ''} onChange={(e) => setEditing({ ...editing, telefono: e.target.value })} className={inputCls} /></Field>
              <Field label="Email"><input type="email" value={editing.email ?? ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className={inputCls} /></Field>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="alerta" onClick={() => { setShowForm(false); setEditing(null); }}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={save}>Guardar</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`campo${wide ? ' sm:col-span-2' : ''}`}><span className="etiqueta">{label}</span>{children}</label>;
}
