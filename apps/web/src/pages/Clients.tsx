import { useEffect, useState, FormEvent } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import {
  flitInp, FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import { useAuth } from '../lib/auth';
import { puedeOperar } from '../lib/permissions';

// Un cliente ES una compañía FLITO (misma tabla). Por eso la autogestión de SOAT/Impuestos/Logística
// se administra aquí, en línea, junto a la información de la empresa (§correcciones-UX).
interface Client {
  id: number; name: string; document: string | null; documentType: string | null;
  phone: string | null; email: string | null; address: string | null;
  city: string | null; notes: string | null; active: boolean;
  soatAutogestionable: boolean; impuestosAutogestionable: boolean; logisticaAutogestionable: boolean;
}

type FlagCampo = 'soatAutogestionable' | 'impuestosAutogestionable' | 'logisticaAutogestionable';

export default function Clients() {
  const { user } = useAuth();
  const editable = puedeOperar(user?.role);
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
      toast.error(err instanceof Error ? err.message : 'Error');
    }
  };

  // Toggle de autogestión: PATCH del flag suelto (endpoint FLITO, permitido a operaciones/admin).
  // Optimista con reversión si falla.
  const toggleFlag = async (c: Client, campo: FlagCampo) => {
    const valor = !c[campo];
    setClients((prev) => prev.map((x) => (x.id === c.id ? { ...x, [campo]: valor } : x)));
    try {
      await api.patch(`/flito/parametrizacion/companias/${c.id}`, { [campo]: valor });
    } catch (err) {
      setClients((prev) => prev.map((x) => (x.id === c.id ? { ...x, [campo]: !valor } : x)));
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    }
  };

  const CeldaFlag = ({ c, campo, label }: { c: Client; campo: FlagCampo; label: string }) => (
    <td className="px-3 py-2 text-center">
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer align-middle disabled:cursor-not-allowed"
        checked={c[campo]}
        disabled={!editable}
        aria-label={`Autogestión ${label} de ${c.name}`}
        onChange={() => toggleFlag(c, campo)}
      />
    </td>
  );

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Cartera de clientes"
        subtitle={`${clients.length} registros · autogestión SOAT · Impuestos · Logística por compañía`}
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

      <FlitCard>
        {clients.length === 0 ? <FlitEmpty>No hay clientes.</FlitEmpty> : (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Empresa</FlitTh>
                <FlitTh>Documento</FlitTh>
                <FlitTh>Ciudad</FlitTh>
                <FlitTh>Teléfono</FlitTh>
                <FlitTh>Email</FlitTh>
                <FlitTh center>SOAT</FlitTh>
                <FlitTh center>Impuestos</FlitTh>
                <FlitTh center>Logística</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <FlitTr key={c.id}>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{c.name}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.documentType ?? 'NIT'} {c.document || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.city || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.phone || '—'}</td>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.email || '—'}</td>
                  <CeldaFlag c={c} campo="soatAutogestionable" label="SOAT" />
                  <CeldaFlag c={c} campo="impuestosAutogestionable" label="Impuestos" />
                  <CeldaFlag c={c} campo="logisticaAutogestionable" label="Logística" />
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
        {editable && (
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Marca «Autogestiona» cuando la compañía tramita SOAT, impuestos o logística por su cuenta (FLITO no la gestiona).
          </p>
        )}
      </FlitCard>
    </div>
  );
}
