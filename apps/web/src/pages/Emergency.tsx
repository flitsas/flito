import { useEffect, useState, useCallback, FormEvent, ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface Contact {
  id: number; tipo: string; zona: string; nombre: string;
  telefono: string; telefonoAlternativo: string | null;
  email: string | null; prioridad: number; activo: boolean;
}
interface Protocol {
  id: number; titulo: string; categoria: string;
  descripcionMd: string; vigente: boolean; version: number;
}
interface Drill {
  id: number; fecha: string; escenario: string;
  participantes: number[]; observaciones: string | null;
}

const TIPOS = ['arl', 'ambulancia', 'bombero', 'policia', 'taller_grua', 'aseguradora', 'interno'];
const CATS = ['accidente', 'averia', 'medico', 'seguridad'];

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

type Tab = 'contactos' | 'protocolos' | 'simulacros';

export default function Emergency() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('contactos');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Plan de emergencias"
        subtitle="Contactos, protocolos y simulacros (Res. 40595/2022 — mínimo 1 simulacro anual)"
      />

      <div style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
        <nav className="-mb-px flex gap-6 flex-wrap">
          <TabBtn active={tab === 'contactos'} onClick={() => setTab('contactos')}>Contactos</TabBtn>
          <TabBtn active={tab === 'protocolos'} onClick={() => setTab('protocolos')}>Protocolos</TabBtn>
          <TabBtn active={tab === 'simulacros'} onClick={() => setTab('simulacros')}>Simulacros</TabBtn>
        </nav>
      </div>

      {tab === 'contactos' && <ContactsPanel canEdit={isAdmin} />}
      {tab === 'protocolos' && <ProtocolsPanel canEdit={isAdmin} />}
      {tab === 'simulacros' && <DrillsPanel canEdit={isAdmin} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flit-focus pb-2 text-sm font-semibold transition-colors"
      style={{
        borderBottom: `2px solid ${active ? 'var(--flit-blue)' : 'transparent'}`,
        color: active ? 'var(--flit-blue)' : 'var(--flit-text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
}

function ModalFooter({ onClose, submitting, label }: { onClose: () => void; submitting: boolean; label: string }) {
  return (
    <div className="mt-2 flex justify-end gap-2">
      <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
      <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : label}</GradientButton>
    </div>
  );
}

function ContactsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Contact[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(async () => {
    try { setItems((await api.get<{ data: Contact[] }>('/drivers/emergency/contacts')).data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {canEdit && <div className="flex justify-end"><GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo contacto</GradientButton></div>}
      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Zona</Th><Th>Tipo</Th><Th>Nombre</Th><Th>Teléfono</Th><Th>Email</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin contactos</td></tr>}
              {items.map((c) => (
                <tr key={c.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{c.zona}</td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{c.tipo.replace('_', ' ')}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{c.nombre}</td>
                  <td className="px-4 py-3"><a href={`tel:${c.telefono}`} className="font-mono text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>{c.telefono}</a></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{c.email || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {showCreate && <ContactForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function ContactForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState('arl');
  const [zona, setZona] = useState('bogota');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nombre.trim() || !telefono.trim()) { toast.error('Nombre y teléfono requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/drivers/emergency/contacts', { tipo, zona: zona.trim(), nombre: nombre.trim(), telefono: telefono.trim(), prioridad: 100 });
      toast.success('Contacto creado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return (
    <FlitModal title="Nuevo contacto" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Tipo"><select value={tipo} onChange={(e) => setTipo(e.target.value)} className={inputCls}>{TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
        <Field label="Zona"><input value={zona} onChange={(e) => setZona(e.target.value)} maxLength={100} className={inputCls} /></Field>
        <Field label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={inputCls} /></Field>
        <Field label="Teléfono *"><input value={telefono} onChange={(e) => setTelefono(e.target.value)} maxLength={40} className={inputCls} /></Field>
        <ModalFooter onClose={onClose} submitting={submitting} label="Crear" />
      </form>
    </FlitModal>
  );
}

function ProtocolsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Protocol[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(async () => {
    try { setItems((await api.get<{ data: Protocol[] }>('/drivers/emergency/protocols')).data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {canEdit && <div className="flex justify-end"><GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo protocolo</GradientButton></div>}
      {items.length === 0 ? (
        <div className="bg-white p-8 text-center text-sm" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Sin protocolos definidos</div>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id} className="bg-white p-5" style={CARD}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.titulo}</h3>
                <StatusChip tone="active">{p.categoria}</StatusChip>
              </div>
              <p className="whitespace-pre-wrap text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.descripcionMd.slice(0, 400)}{p.descripcionMd.length > 400 ? '…' : ''}</p>
              <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>v{p.version}</p>
            </li>
          ))}
        </ul>
      )}
      {showCreate && <ProtocolForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function ProtocolForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [titulo, setTitulo] = useState('');
  const [categoria, setCategoria] = useState('accidente');
  const [descripcionMd, setDescripcionMd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!titulo.trim() || !descripcionMd.trim()) { toast.error('Título y descripción requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/drivers/emergency/protocols', { titulo: titulo.trim(), categoria, descripcionMd: descripcionMd.trim() });
      toast.success('Protocolo creado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return (
    <FlitModal title="Nuevo protocolo" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Título *"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={200} className={inputCls} /></Field>
        <Field label="Categoría"><select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={inputCls}>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
        <Field label="Descripción (Markdown soportado) *"><textarea value={descripcionMd} onChange={(e) => setDescripcionMd(e.target.value)} maxLength={50000} rows={10} className={inputCls + ' font-mono text-xs'} /></Field>
        <ModalFooter onClose={onClose} submitting={submitting} label="Crear" />
      </form>
    </FlitModal>
  );
}

function DrillsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Drill[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const load = useCallback(async () => {
    try { setItems((await api.get<{ data: Drill[] }>('/drivers/emergency/drills')).data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const yearActual = new Date().getFullYear();
  const enYear = items.filter((d) => Number(d.fecha.slice(0, 4)) === yearActual).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Simulacros en {yearActual}: <span className="font-bold tabular-nums" style={{ color: enYear >= 1 ? 'var(--flit-success)' : 'var(--flit-danger)' }}>{enYear}</span> / 1 (meta anual PESV)
        </p>
        {canEdit && <GradientButton type="button" onClick={() => setShowCreate(true)}>Registrar simulacro</GradientButton>}
      </div>
      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha</Th><Th>Escenario</Th><Th>Participantes</Th><Th>Observaciones</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin simulacros</td></tr>}
              {items.map((d) => (
                <tr key={d.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{d.fecha}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{d.escenario}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{d.participantes.length}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{(d.observaciones ?? '').slice(0, 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {showCreate && <DrillForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function DrillForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [escenario, setEscenario] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [planMejora, setPlanMejora] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!fecha || !escenario.trim()) { toast.error('Fecha y escenario requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/drivers/emergency/drills', {
        fecha, escenario: escenario.trim(),
        observaciones: observaciones.trim() || null,
        planMejora: planMejora.trim() || null,
      });
      toast.success('Simulacro registrado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return (
    <FlitModal title="Registrar simulacro" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Fecha *"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={inputCls} /></Field>
        <Field label="Escenario *"><input value={escenario} onChange={(e) => setEscenario(e.target.value)} maxLength={200} className={inputCls} /></Field>
        <Field label="Observaciones"><textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} rows={3} className={inputCls} /></Field>
        <Field label="Plan de mejora"><textarea value={planMejora} onChange={(e) => setPlanMejora(e.target.value)} maxLength={2000} rows={2} className={inputCls} /></Field>
        <ModalFooter onClose={onClose} submitting={submitting} label="Registrar" />
      </form>
    </FlitModal>
  );
}
