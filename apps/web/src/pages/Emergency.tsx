import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import Pestanas from '../components/flit/Pestanas';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';
import { FlitCard, FlitField, flitInp } from '../components/flit/flitPageKit';

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

type Tab = 'contactos' | 'protocolos' | 'simulacros';

const PESTANAS: { id: Tab; etiqueta: string }[] = [
  { id: 'contactos', etiqueta: 'Contactos' },
  { id: 'protocolos', etiqueta: 'Protocolos' },
  { id: 'simulacros', etiqueta: 'Simulacros' },
];

const TXT2 = 'text-[color:var(--color-text-secondary)]';

export default function Emergency() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.emergencias.administrar');
  const [tab, setTab] = useState<Tab>('contactos');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Plan de emergencias"
        subtitle="Contactos, protocolos y simulacros (Res. 40595/2022 — mínimo 1 simulacro anual)"
        icono="flito-emergencias"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
      />

      <Pestanas etiqueta="Plan de emergencias" pestanas={PESTANAS} activa={tab} onElegir={(id) => setTab(id as Tab)} />

      {tab === 'contactos' && <ContactsPanel canEdit={isAdmin} />}
      {tab === 'protocolos' && <ProtocolsPanel canEdit={isAdmin} />}
      {tab === 'simulacros' && <DrillsPanel canEdit={isAdmin} />}
    </div>
  );
}

function ModalFooter({ onClose, submitting, label }: { onClose: () => void; submitting: boolean; label: string }) {
  return (
    <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
      <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : label}</GradientButton>
    </div>
  );
}

const COLUMNAS_CONTACTOS: ColumnaTabla<Contact>[] = [
  { key: 'zona', header: 'Zona', etiqueta: 'Zona', render: (c) => <span className={`text-xs ${TXT2}`}>{c.zona}</span> },
  { key: 'tipo', header: 'Tipo', etiqueta: 'Tipo', render: (c) => <span className={`text-xs capitalize ${TXT2}`}>{c.tipo.replace('_', ' ')}</span> },
  { key: 'nombre', header: 'Nombre', etiqueta: 'Nombre', render: (c) => <span className="font-medium text-[color:var(--color-text-primary)]">{c.nombre}</span> },
  {
    key: 'telefono', header: 'Teléfono', etiqueta: 'Teléfono',
    render: (c) => <a href={`tel:${c.telefono}`} className="flit-focus mono text-xs text-[color:var(--color-action)] transition-colors hover:underline">{c.telefono}</a>,
  },
  { key: 'email', header: 'Email', etiqueta: 'Email', render: (c) => <span className={`text-xs ${TXT2}`}>{c.email || '—'}</span> },
];

function ContactsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Contact[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  // Solo presentación: 4 estados del kit.
  const [status, setStatus] = useState<EstadoUi>('loading');
  const load = useCallback(async () => {
    try {
      const data = (await api.get<{ data: Contact[] }>('/drivers/emergency/contacts')).data;
      setItems(data); setStatus(data.length ? 'ready' : 'empty');
    } catch (err) { toast.error(errorMessage(err)); setStatus('error'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {canEdit && <div className="flex justify-end"><GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo contacto</GradientButton></div>}
      <FlitCard className="min-w-0">
        <DataTable ariaLabel="Contactos de emergencia" columnas={COLUMNAS_CONTACTOS} filas={items} getKey={(c) => String(c.id)}
          status={status} onRetry={load} emptyMessage="Sin contactos" />
      </FlitCard>
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
    <FlitModal title="Nuevo contacto" onClose={onClose} icono="celular">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Tipo"><select value={tipo} onChange={(e) => setTipo(e.target.value)} className={flitInp}>{TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}</select></FlitField>
        <FlitField label="Zona"><input value={zona} onChange={(e) => setZona(e.target.value)} maxLength={100} className={flitInp} /></FlitField>
        <FlitField label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <FlitField label="Teléfono *"><input value={telefono} onChange={(e) => setTelefono(e.target.value)} maxLength={40} className={flitInp} /></FlitField>
        <ModalFooter onClose={onClose} submitting={submitting} label="Crear" />
      </form>
    </FlitModal>
  );
}

function ProtocolsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Protocol[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  // Solo presentación: 4 estados del kit.
  const [status, setStatus] = useState<EstadoUi>('loading');
  const load = useCallback(async () => {
    try {
      const data = (await api.get<{ data: Protocol[] }>('/drivers/emergency/protocols')).data;
      setItems(data); setStatus(data.length ? 'ready' : 'empty');
    } catch (err) { toast.error(errorMessage(err)); setStatus('error'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {canEdit && <div className="flex justify-end"><GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo protocolo</GradientButton></div>}
      <EstadoVista status={status} onRetry={load} emptyMessage="Sin protocolos definidos">
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((p) => (
            <li key={p.id} className="card min-w-0">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <h3 className="font-semibold text-[color:var(--color-text-primary)]">{p.titulo}</h3>
                <StatusChip tone="active">{p.categoria}</StatusChip>
              </div>
              <p className={`whitespace-pre-wrap break-words text-xs ${TXT2}`}>{p.descripcionMd.slice(0, 400)}{p.descripcionMd.length > 400 ? '…' : ''}</p>
              <p className="mt-2 text-[10px] text-[color:var(--color-text-tertiary)]">v{p.version}</p>
            </li>
          ))}
        </ul>
      </EstadoVista>
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
    <FlitModal title="Nuevo protocolo" onClose={onClose} icono="documento">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Título *"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={200} className={flitInp} /></FlitField>
        <FlitField label="Categoría"><select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={flitInp}>{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select></FlitField>
        <FlitField label="Descripción (Markdown soportado) *"><textarea value={descripcionMd} onChange={(e) => setDescripcionMd(e.target.value)} maxLength={50000} rows={10} className={`${flitInp} mono text-xs`} /></FlitField>
        <ModalFooter onClose={onClose} submitting={submitting} label="Crear" />
      </form>
    </FlitModal>
  );
}

const COLUMNAS_SIMULACROS: ColumnaTabla<Drill>[] = [
  { key: 'fecha', header: 'Fecha', etiqueta: 'Fecha', render: (d) => <span className={`tabular-nums ${TXT2}`}>{d.fecha}</span> },
  { key: 'escenario', header: 'Escenario', etiqueta: 'Escenario', render: (d) => <span className="font-medium text-[color:var(--color-text-primary)]">{d.escenario}</span> },
  { key: 'participantes', header: 'Participantes', etiqueta: 'Participantes', render: (d) => <span className={`tabular-nums ${TXT2}`}>{d.participantes.length}</span> },
  { key: 'observaciones', header: 'Observaciones', etiqueta: 'Observaciones', render: (d) => <span className={`text-xs ${TXT2}`}>{(d.observaciones ?? '').slice(0, 100)}</span> },
];

function DrillsPanel({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Drill[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  // Solo presentación: 4 estados del kit.
  const [status, setStatus] = useState<EstadoUi>('loading');
  const load = useCallback(async () => {
    try {
      const data = (await api.get<{ data: Drill[] }>('/drivers/emergency/drills')).data;
      setItems(data); setStatus(data.length ? 'ready' : 'empty');
    } catch (err) { toast.error(errorMessage(err)); setStatus('error'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const yearActual = new Date().getFullYear();
  const enYear = items.filter((d) => Number(d.fecha.slice(0, 4)) === yearActual).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs ${TXT2}`}>
          Simulacros en {yearActual}: <span className={`font-bold tabular-nums ${enYear >= 1 ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>{enYear}</span> / 1 (meta anual PESV)
        </p>
        {canEdit && <GradientButton type="button" onClick={() => setShowCreate(true)}>Registrar simulacro</GradientButton>}
      </div>
      <FlitCard className="min-w-0">
        <DataTable ariaLabel="Simulacros" columnas={COLUMNAS_SIMULACROS} filas={items} getKey={(d) => String(d.id)}
          status={status} onRetry={load} emptyMessage="Sin simulacros" />
      </FlitCard>
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
    <FlitModal title="Registrar simulacro" onClose={onClose} icono="megafono">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Fecha *"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={flitInp} /></FlitField>
        <FlitField label="Escenario *"><input value={escenario} onChange={(e) => setEscenario(e.target.value)} maxLength={200} className={flitInp} /></FlitField>
        <FlitField label="Observaciones"><textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} rows={3} className={flitInp} /></FlitField>
        <FlitField label="Plan de mejora"><textarea value={planMejora} onChange={(e) => setPlanMejora(e.target.value)} maxLength={2000} rows={2} className={flitInp} /></FlitField>
        <ModalFooter onClose={onClose} submitting={submitting} label="Registrar" />
      </form>
    </FlitModal>
  );
}
