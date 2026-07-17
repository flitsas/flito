import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';

interface Catalogo<T> { data: T[]; }
interface Municipio { codigoDane: string; nombre: string; departamentoNombre: string; }
interface Producto { codigo: string; nombre: string; }
interface Empaque { codigo: string; nombre: string; }
interface Unidad { codigo: string; nombre: string; }
interface Cliente { id: number; name: string; document: string | null; }
interface PropDest { id: number; nombre: string; documento: string; }

interface FormState {
  clientId: number | null;
  propietarioCargaId: number | null;
  destinatarioCargaId: number | null;
  municipioOrigenDane: string;
  municipioDestinoDane: string;
  direccionCargue: string;
  direccionDescargue: string;
  productoCodigo: string;
  naturaleza: string;
  empaqueCodigo: string;
  unidadMedidaCodigo: string;
  cantidadCargada: number;
  pesoKg: number;
  fechaCargue: string;
  horaCargue: string;
  valorFlete: number;
  valorAnticipo: number;
  observaciones: string;
}

const NATURALEZAS: Array<[string, string]> = [
  ['carga_normal', 'Carga normal'],
  ['carga_peligrosa', 'Carga peligrosa'],
  ['carga_refrigerada', 'Carga refrigerada'],
  ['carga_extradimensionada', 'Extradimensionada'],
  ['carga_extrapesada', 'Extrapesada'],
];

const initialForm = (): FormState => ({
  clientId: null, propietarioCargaId: null, destinatarioCargaId: null,
  municipioOrigenDane: '', municipioDestinoDane: '',
  direccionCargue: '', direccionDescargue: '',
  productoCodigo: '', naturaleza: 'carga_normal',
  empaqueCodigo: '', unidadMedidaCodigo: 'KG',
  cantidadCargada: 0, pesoKg: 0,
  fechaCargue: new Date().toISOString().slice(0, 10),
  horaCargue: '08:00',
  valorFlete: 0, valorAnticipo: 0,
  observaciones: '',
});

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcRemesaForm() {
  const { id } = useParams();
  const isEdit = !!id && id !== 'nueva';
  const nav = useNavigate();
  const [form, setForm] = useState<FormState>(initialForm());
  const [submitting, setSubmitting] = useState(false);

  const [municipios, setMunicipios] = useState<Municipio[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [empaques, setEmpaques] = useState<Empaque[]>([]);
  const [unidades, setUnidades] = useState<Unidad[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [propietarios, setPropietarios] = useState<PropDest[]>([]);
  const [destinatarios, setDestinatarios] = useState<PropDest[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [m, p, e, u, prop, dest] = await Promise.all([
          api.get<Catalogo<Municipio>>('/rndc/catalogos/municipios'),
          api.get<Catalogo<Producto>>('/rndc/catalogos/productos'),
          api.get<Catalogo<Empaque>>('/rndc/catalogos/empaques'),
          api.get<Catalogo<Unidad>>('/rndc/catalogos/unidades'),
          api.get<Catalogo<PropDest>>('/rndc/propietarios-carga'),
          api.get<Catalogo<PropDest>>('/rndc/destinatarios-carga'),
        ]);
        setMunicipios(m.data); setProductos(p.data); setEmpaques(e.data); setUnidades(u.data);
        setPropietarios(prop.data); setDestinatarios(dest.data);

        const cli = await api.get<Cliente[]>('/clients');
        setClientes(Array.isArray(cli) ? cli : []);

        if (isEdit) {
          const r = await api.get<{ data: Record<string, unknown> }>(`/rndc/remesas/${id}`);
          const d = r.data as Record<string, string | number | null>;
          setForm({
            clientId: d.clientId as number | null,
            propietarioCargaId: d.propietarioCargaId as number | null,
            destinatarioCargaId: d.destinatarioCargaId as number | null,
            municipioOrigenDane: String(d.municipioOrigenDane ?? ''),
            municipioDestinoDane: String(d.municipioDestinoDane ?? ''),
            direccionCargue: String(d.direccionCargue ?? ''),
            direccionDescargue: String(d.direccionDescargue ?? ''),
            productoCodigo: String(d.productoCodigo ?? ''),
            naturaleza: String(d.naturaleza ?? 'carga_normal'),
            empaqueCodigo: String(d.empaqueCodigo ?? ''),
            unidadMedidaCodigo: String(d.unidadMedidaCodigo ?? 'KG'),
            cantidadCargada: Number(d.cantidadCargada),
            pesoKg: Number(d.pesoKg) || 0,
            fechaCargue: String(d.fechaCargue ?? ''),
            horaCargue: String(d.horaCargue ?? ''),
            valorFlete: Number(d.valorFlete),
            valorAnticipo: Number(d.valorAnticipo),
            observaciones: String(d.observaciones ?? ''),
          });
        }
      } catch (err) { toast.error(errorMessage(err)); }
    })();
  }, [id, isEdit]);

  const submit = async () => {
    if (!form.municipioOrigenDane || !form.municipioDestinoDane) { toast.error('Origen y destino son requeridos'); return; }
    if (form.cantidadCargada <= 0) { toast.error('La cantidad cargada debe ser > 0'); return; }
    if (form.valorAnticipo > form.valorFlete) { toast.error('El anticipo no puede superar el flete'); return; }

    setSubmitting(true);
    try {
      const payload = {
        ...form,
        productoCodigo: form.productoCodigo || null,
        empaqueCodigo: form.empaqueCodigo || null,
        unidadMedidaCodigo: form.unidadMedidaCodigo || null,
        direccionCargue: form.direccionCargue || null,
        direccionDescargue: form.direccionDescargue || null,
        observaciones: form.observaciones || null,
        horaCargue: form.horaCargue || null,
        pesoKg: form.pesoKg > 0 ? form.pesoKg : null,
      };
      if (isEdit) {
        await api.put(`/rndc/remesas/${id}`, payload);
        toast.success('Remesa actualizada');
      } else {
        const r = await api.post<{ data: { id: number; numero: string } }>('/rndc/remesas', payload);
        toast.success(`Remesa ${r.data.numero} creada`);
        nav(`/rndc/remesas/${r.data.id}`);
        return;
      }
      nav('/rndc/remesas');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeaderCard
        title={isEdit ? 'Editar remesa' : 'Nueva remesa'}
        subtitle="RNDC · Documento de despacho — se asocia luego a un manifiesto electrónico"
      />

      <div className="space-y-6 bg-white p-6" style={CARD}>
        <Section title="Partes">
          <Field label="Cliente"><Select value={form.clientId} onChange={(v) => setForm({ ...form, clientId: v as number | null })} options={clientes.map((c) => [c.id, c.name])} placeholder="(Sin cliente)" /></Field>
          <Field label="Propietario de carga"><Select value={form.propietarioCargaId} onChange={(v) => setForm({ ...form, propietarioCargaId: v as number | null })} options={propietarios.map((p) => [p.id, `${p.nombre} (${p.documento})`])} placeholder="(Sin propietario)" /></Field>
          <Field label="Destinatario"><Select value={form.destinatarioCargaId} onChange={(v) => setForm({ ...form, destinatarioCargaId: v as number | null })} options={destinatarios.map((d) => [d.id, `${d.nombre} (${d.documento})`])} placeholder="(Sin destinatario)" /></Field>
        </Section>

        <Section title="Origen / Destino">
          <Field label="Municipio origen"><MunicipioSelect value={form.municipioOrigenDane} onChange={(v) => setForm({ ...form, municipioOrigenDane: v })} options={municipios} /></Field>
          <Field label="Dirección de cargue"><Input value={form.direccionCargue} onChange={(v) => setForm({ ...form, direccionCargue: v })} /></Field>
          <Field label="Municipio destino"><MunicipioSelect value={form.municipioDestinoDane} onChange={(v) => setForm({ ...form, municipioDestinoDane: v })} options={municipios} /></Field>
          <Field label="Dirección de descargue"><Input value={form.direccionDescargue} onChange={(v) => setForm({ ...form, direccionDescargue: v })} /></Field>
        </Section>

        <Section title="Carga">
          <Field label="Producto"><Select value={form.productoCodigo} onChange={(v) => setForm({ ...form, productoCodigo: String(v ?? '') })} options={productos.map((p) => [p.codigo, p.nombre])} placeholder="(Sin producto)" /></Field>
          <Field label="Naturaleza">
            <select value={form.naturaleza} onChange={(e) => setForm({ ...form, naturaleza: e.target.value })} className={inputCls}>
              {NATURALEZAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Empaque"><Select value={form.empaqueCodigo} onChange={(v) => setForm({ ...form, empaqueCodigo: String(v ?? '') })} options={empaques.map((e) => [e.codigo, e.nombre])} placeholder="(Sin empaque)" /></Field>
          <Field label="Unidad de medida"><Select value={form.unidadMedidaCodigo} onChange={(v) => setForm({ ...form, unidadMedidaCodigo: String(v ?? '') })} options={unidades.map((u) => [u.codigo, u.nombre])} /></Field>
          <Field label="Cantidad cargada"><Input type="number" value={form.cantidadCargada} onChange={(v) => setForm({ ...form, cantidadCargada: Number(v) })} /></Field>
          <Field label="Peso (kg)"><Input type="number" value={form.pesoKg} onChange={(v) => setForm({ ...form, pesoKg: Number(v) })} /></Field>
        </Section>

        <Section title="Fechas y valor">
          <Field label="Fecha de cargue"><Input type="date" value={form.fechaCargue} onChange={(v) => setForm({ ...form, fechaCargue: v })} /></Field>
          <Field label="Hora cargue"><Input type="time" value={form.horaCargue} onChange={(v) => setForm({ ...form, horaCargue: v })} /></Field>
          <Field label="Valor flete (COP)"><Input type="number" value={form.valorFlete} onChange={(v) => setForm({ ...form, valorFlete: Number(v) })} /></Field>
          <Field label="Anticipo (COP)"><Input type="number" value={form.valorAnticipo} onChange={(v) => setForm({ ...form, valorAnticipo: Number(v) })} /></Field>
        </Section>

        <Field label="Observaciones">
          <textarea value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value })} rows={3} className={inputCls} />
        </Field>

        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button onClick={() => nav('/rndc/remesas')} className="flit-focus inline-flex h-11 items-center gap-2 rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Cancelar</button>
          <GradientButton type="button" onClick={submit} disabled={submitting}>{submitting ? 'Guardando...' : (isEdit ? 'Actualizar' : 'Crear remesa')}</GradientButton>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{title}</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{label}</label>
      {children}
    </div>
  );
}

function Input({ type = 'text', value, onChange }: { type?: string; value: string | number; onChange: (v: string) => void }) {
  return (
    <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={inputCls} />
  );
}

type SelectVal = string | number | null;
function Select({ value, onChange, options, placeholder }: { value: SelectVal; onChange: (v: SelectVal) => void; options: Array<[string | number, string]>; placeholder?: string }) {
  const firstIsNumber = typeof options[0]?.[0] === 'number';
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : (firstIsNumber ? Number(e.target.value) : e.target.value))} className={inputCls}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(([v, l]) => <option key={String(v)} value={v}>{l}</option>)}
    </select>
  );
}

function MunicipioSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Municipio[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">Selecciona municipio...</option>
      {options.map((m) => (
        <option key={m.codigoDane} value={m.codigoDane}>{m.nombre} ({m.departamentoNombre})</option>
      ))}
    </select>
  );
}
