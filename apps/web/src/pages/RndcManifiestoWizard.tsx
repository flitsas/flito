import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';

interface Vehicle { id: number; plate: string | null; alias: string | null; tipoVehiculo: string | null; }
interface User { id: number; name: string; esConductor: boolean; }
interface Tenedor { id: number; nombre: string; documento: string; }
interface Municipio { codigoDane: string; nombre: string; departamentoNombre: string; }
interface RemesaActiva {
  id: number; numero: string; municipioOrigenDane: string; municipioDestinoDane: string;
  cantidadCargada: string; valorFlete: string; fechaCargue: string;
}

interface Form {
  vehiculoPrincipalId: number | null;
  vehiculoRemolqueId: number | null;
  conductorId: number | null;
  tenedorId: number | null;
  municipioOrigenDane: string;
  municipioDestinoDane: string;
  fechaExpedicion: string;
  fechaPactadaPago: string;
  valorAnticipo: number;
  retencionFuente: number;
  retencionIca: number;
  titularPagoTipo: 'propietario' | 'conductor' | 'empresa' | 'tercero';
  titularPagoDoc: string;
  titularPagoNombre: string;
  titularPagoCuenta: string;
  observaciones: string;
  remesaIds: number[];
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

const initial = (): Form => ({
  vehiculoPrincipalId: null, vehiculoRemolqueId: null, conductorId: null, tenedorId: null,
  municipioOrigenDane: '', municipioDestinoDane: '',
  fechaExpedicion: new Date().toISOString().slice(0, 10),
  fechaPactadaPago: '',
  valorAnticipo: 0, retencionFuente: 0, retencionIca: 0,
  titularPagoTipo: 'conductor',
  titularPagoDoc: '', titularPagoNombre: '', titularPagoCuenta: '',
  observaciones: '',
  remesaIds: [],
});

export default function RndcManifiestoWizard() {
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<Form>(initial());
  const [submitting, setSubmitting] = useState(false);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [conductores, setConductores] = useState<User[]>([]);
  const [tenedores, setTenedores] = useState<Tenedor[]>([]);
  const [municipios, setMunicipios] = useState<Municipio[]>([]);
  const [remesasActivas, setRemesasActivas] = useState<RemesaActiva[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [v, u, t, m, ra] = await Promise.all([
          api.get<{ data: Vehicle[] }>('/fleet/vehicles'),
          api.get<{ data: User[] }>('/drivers'),
          api.get<{ data: Tenedor[] }>('/rndc/tenedores'),
          api.get<{ data: Municipio[] }>('/rndc/catalogos/municipios'),
          api.get<{ data: RemesaActiva[] }>('/rndc/remesas?estado=activa&sinManifiesto=1'),
        ]);
        setVehicles(v.data);
        setConductores(u.data);
        setTenedores(t.data); setMunicipios(m.data); setRemesasActivas(ra.data);
      } catch (err) { toast.error(errorMessage(err)); }
    })();
  }, []);

  const fleteTotal = remesasActivas
    .filter((r) => form.remesaIds.includes(r.id))
    .reduce((s, r) => s + Number(r.valorFlete), 0);

  const next = () => {
    if (step === 1 && (!form.vehiculoPrincipalId || !form.conductorId)) { toast.error('Vehículo y conductor son requeridos'); return; }
    if (step === 2 && (!form.municipioOrigenDane || !form.municipioDestinoDane)) { toast.error('Origen y destino son requeridos'); return; }
    if (step === 3 && form.remesaIds.length === 0) { toast.error('Asocia al menos una remesa'); return; }
    setStep(step + 1);
  };

  const submit = async () => {
    if (form.valorAnticipo > fleteTotal) { toast.error('Anticipo no puede superar el flete total'); return; }
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        valorFleteTotal: fleteTotal,
        fechaPactadaPago: form.fechaPactadaPago || null,
        tenedorId: form.tenedorId || null,
        vehiculoRemolqueId: form.vehiculoRemolqueId || null,
        titularPagoDoc: form.titularPagoDoc || null,
        titularPagoNombre: form.titularPagoNombre || null,
        titularPagoCuenta: form.titularPagoCuenta || null,
        observaciones: form.observaciones || null,
      };
      const r = await api.post<{ data: { id: number; numero: string } }>('/rndc/manifiestos', payload);
      toast.success(`Manifiesto ${r.data.numero} creado`);
      nav(`/rndc/manifiestos/${r.data.id}`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeaderCard
        title="Nuevo manifiesto electrónico"
        subtitle="RNDC · Wizard 4 pasos · Borrador se guarda al finalizar"
      />

      <Steps current={step} />

      <div className="bg-white p-6" style={CARD}>
        {step === 1 && <Step1 form={form} setForm={setForm} vehicles={vehicles} conductores={conductores} tenedores={tenedores} />}
        {step === 2 && <Step2 form={form} setForm={setForm} municipios={municipios} />}
        {step === 3 && <Step3 form={form} setForm={setForm} remesas={remesasActivas} fleteTotal={fleteTotal} />}
        {step === 4 && <Step4 form={form} setForm={setForm} fleteTotal={fleteTotal} />}

        <div className="mt-5 flex justify-between gap-2 border-t pt-5" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {step > 1 ? (
            <button onClick={() => setStep(step - 1)} className="flit-focus inline-flex h-11 items-center gap-2 rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>← Anterior</button>
          ) : <span />}
          {step < 4 ? (
            <GradientButton type="button" onClick={next}>Siguiente →</GradientButton>
          ) : (
            <GradientButton type="button" variant="success" onClick={submit} disabled={submitting}>
              {submitting ? 'Creando...' : 'Crear manifiesto (borrador)'}
            </GradientButton>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const labels = ['Vehículo y conductor', 'Origen y destino', 'Remesas', 'Pago y revisión'];
  return (
    <div className="flex gap-2">
      {labels.map((l, i) => {
        const n = i + 1;
        const active = n === current; const done = n < current;
        const style = active
          ? { background: 'var(--flit-blue)', color: '#fff' }
          : done
            ? { background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success)' }
            : { background: 'var(--flit-bg-app)', color: 'var(--flit-text-muted)' };
        return (
          <div key={l} className="flex-1 rounded-[12px] px-3 py-2.5 text-xs" style={style}>
            <span className="font-semibold">{n}.</span> {l}
          </div>
        );
      })}
    </div>
  );
}

interface Step1Props { form: Form; setForm: (f: Form) => void; vehicles: Vehicle[]; conductores: User[]; tenedores: Tenedor[]; }
function Step1({ form, setForm, vehicles, conductores, tenedores }: Step1Props) {
  const cabezotes = vehicles.filter((v) => v.tipoVehiculo === 'tractomula' || v.tipoVehiculo === 'camion' || !v.tipoVehiculo);
  return (
    <div className="space-y-4">
      <Field label="Vehículo principal (cabezote)">
        <Select value={form.vehiculoPrincipalId} onChange={(v) => setForm({ ...form, vehiculoPrincipalId: v ? Number(v) : null })}
          options={cabezotes.map((v) => [v.id, v.alias ? `${v.plate} — ${v.alias}` : (v.plate ?? `#${v.id}`)])} placeholder="Selecciona cabezote..." />
      </Field>
      <Field label="Remolque (opcional)">
        <Select value={form.vehiculoRemolqueId} onChange={(v) => setForm({ ...form, vehiculoRemolqueId: v ? Number(v) : null })}
          options={vehicles.map((v) => [v.id, v.alias ? `${v.plate} — ${v.alias}` : (v.plate ?? `#${v.id}`)])} placeholder="(Sin remolque)" />
      </Field>
      <Field label="Conductor">
        <Select value={form.conductorId} onChange={(v) => setForm({ ...form, conductorId: v ? Number(v) : null })}
          options={conductores.map((u) => [u.id, u.name])} placeholder="Selecciona conductor..." />
      </Field>
      <Field label="Tenedor del vehículo">
        <Select value={form.tenedorId} onChange={(v) => setForm({ ...form, tenedorId: v ? Number(v) : null })}
          options={tenedores.map((t) => [t.id, `${t.nombre} (${t.documento})`])} placeholder="(Sin tenedor)" />
      </Field>
    </div>
  );
}

interface Step2Props { form: Form; setForm: (f: Form) => void; municipios: Municipio[]; }
function Step2({ form, setForm, municipios }: Step2Props) {
  return (
    <div className="space-y-4">
      <Field label="Municipio origen">
        <Select value={form.municipioOrigenDane} onChange={(v) => setForm({ ...form, municipioOrigenDane: v ? String(v) : '' })}
          options={municipios.map((m) => [m.codigoDane, `${m.nombre} (${m.departamentoNombre})`])} placeholder="Selecciona origen..." />
      </Field>
      <Field label="Municipio destino">
        <Select value={form.municipioDestinoDane} onChange={(v) => setForm({ ...form, municipioDestinoDane: v ? String(v) : '' })}
          options={municipios.map((m) => [m.codigoDane, `${m.nombre} (${m.departamentoNombre})`])} placeholder="Selecciona destino..." />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Fecha de expedición">
          <input type="date" value={form.fechaExpedicion} onChange={(e) => setForm({ ...form, fechaExpedicion: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Fecha pactada de pago">
          <input type="date" value={form.fechaPactadaPago} onChange={(e) => setForm({ ...form, fechaPactadaPago: e.target.value })} className={inputCls} />
        </Field>
      </div>
    </div>
  );
}

interface Step3Props { form: Form; setForm: (f: Form) => void; remesas: RemesaActiva[]; fleteTotal: number; }
function Step3({ form, setForm, remesas, fleteTotal }: Step3Props) {
  const toggle = (id: number) => {
    const set = new Set(form.remesaIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setForm({ ...form, remesaIds: Array.from(set) });
  };
  return (
    <div>
      <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Remesas activas sin manifiesto. Selecciona las que viajan en este despacho.</p>
      <div className="overflow-hidden rounded-[12px]" style={{ border: '1px solid var(--flit-border-soft)' }}>
        <table className="w-full text-sm">
          <thead><tr>
            <ThW10></ThW10>
            <Th>Remesa</Th><Th>Ruta</Th><Th className="text-right">Cantidad</Th><Th className="text-right">Flete</Th>
          </tr></thead>
          <tbody>
            {remesas.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>No hay remesas activas sin asignar</td></tr>}
            {remesas.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <td className="px-3 py-2.5"><input type="checkbox" checked={form.remesaIds.includes(r.id)} onChange={() => toggle(r.id)} style={{ accentColor: 'var(--flit-blue)' }} /></td>
                <td className="px-3 py-2.5 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{r.numero}</td>
                <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.municipioOrigenDane} → {r.municipioDestinoDane}</td>
                <td className="px-3 py-2.5 text-right text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{Number(r.cantidadCargada).toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>$ {Number(r.valorFlete).toLocaleString('es-CO')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot style={{ background: 'rgba(79,116,201,0.10)' }}>
            <tr>
              <td colSpan={4} className="px-3 py-2.5 text-right text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Flete total seleccionado:</td>
              <td className="px-3 py-2.5 text-right text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>$ {fleteTotal.toLocaleString('es-CO')}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface Step4Props { form: Form; setForm: (f: Form) => void; fleteTotal: number; }
function Step4({ form, setForm, fleteTotal }: Step4Props) {
  return (
    <div className="space-y-4">
      <div className="rounded-[12px] p-4" style={{ background: 'rgba(79,116,201,0.10)' }}>
        <p className="text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Resumen</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-blue)' }}>Flete total: <span className="font-semibold">$ {fleteTotal.toLocaleString('es-CO')}</span></p>
        <p className="mt-0.5 text-xs opacity-80" style={{ color: 'var(--flit-blue)' }}>{form.remesaIds.length} remesas asignadas</p>
      </div>

      <Field label="Titular de pago — tipo">
        <select value={form.titularPagoTipo} onChange={(e) => setForm({ ...form, titularPagoTipo: e.target.value as Form['titularPagoTipo'] })} className={inputCls}>
          <option value="conductor">Conductor</option>
          <option value="propietario">Propietario del vehículo</option>
          <option value="empresa">Empresa</option>
          <option value="tercero">Tercero</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Documento titular"><input value={form.titularPagoDoc} onChange={(e) => setForm({ ...form, titularPagoDoc: e.target.value })} className={inputCls} /></Field>
        <Field label="Nombre titular"><input value={form.titularPagoNombre} onChange={(e) => setForm({ ...form, titularPagoNombre: e.target.value })} className={inputCls} /></Field>
        <Field label="Cuenta bancaria"><input value={form.titularPagoCuenta} onChange={(e) => setForm({ ...form, titularPagoCuenta: e.target.value })} className={inputCls} /></Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Anticipo"><input type="number" value={form.valorAnticipo} onChange={(e) => setForm({ ...form, valorAnticipo: Number(e.target.value) })} className={inputCls} /></Field>
        <Field label="Retención fuente"><input type="number" value={form.retencionFuente} onChange={(e) => setForm({ ...form, retencionFuente: Number(e.target.value) })} className={inputCls} /></Field>
        <Field label="Retención ICA"><input type="number" value={form.retencionIca} onChange={(e) => setForm({ ...form, retencionIca: Number(e.target.value) })} className={inputCls} /></Field>
      </div>

      <Field label="Observaciones">
        <textarea value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value })} rows={3} className={inputCls} />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="mb-1.5 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{label}</label>{children}</div>;
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide ${className}`} style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
function ThW10({ children }: { children?: ReactNode }) {
  return <th className="w-10 px-3 py-3" style={{ background: 'var(--flit-bg-table-header)' }}>{children}</th>;
}

type SelectVal = string | number | null;
function Select({ value, onChange, options, placeholder }: { value: SelectVal; onChange: (v: SelectVal) => void; options: Array<[string | number, string]>; placeholder?: string }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} className={inputCls}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(([v, l]) => <option key={String(v)} value={v}>{l}</option>)}
    </select>
  );
}
