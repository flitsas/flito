import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitWizardSidebar from '../components/flit/FlitWizardSidebar';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { PildoraTramite } from '../components/flit/Bloques';

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

const inputCls = 'control w-full';
const PASOS = ['Vehículo y conductor', 'Origen y destino', 'Remesas', 'Pago y revisión'];

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
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }, { etiqueta: 'Manifiestos', to: '/rndc/manifiestos' }]}
      />

      <FlitWizardSidebar steps={PASOS} current={step} />

      <div className="card p-6">
        {step === 1 && <Step1 form={form} setForm={setForm} vehicles={vehicles} conductores={conductores} tenedores={tenedores} />}
        {step === 2 && <Step2 form={form} setForm={setForm} municipios={municipios} />}
        {step === 3 && <Step3 form={form} setForm={setForm} remesas={remesasActivas} fleteTotal={fleteTotal} />}
        {step === 4 && <Step4 form={form} setForm={setForm} fleteTotal={fleteTotal} />}

        <div className="mt-5 flex flex-wrap justify-between gap-2 border-t border-[color:var(--color-border)] pt-5">
          {step > 1 ? (
            <GradientButton type="button" variant="secondary" onClick={() => setStep(step - 1)}>← Anterior</GradientButton>
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      <p className="mb-3 text-xs text-[color:var(--color-text-tertiary)]">Remesas activas sin manifiesto. Selecciona las que viajan en este despacho.</p>
      <DataTable
        ariaLabel="Remesas activas sin manifiesto"
        columnas={columnasRemesas(form.remesaIds, toggle)}
        filas={remesas}
        getKey={(r) => String(r.id)}
        emptyMessage="No hay remesas activas sin asignar"
      />
      <p className="barra-accion mt-3 justify-end text-xs font-semibold">
        <span className="text-[color:var(--color-action)]">Flete total seleccionado:</span>
        <span className="text-[color:var(--color-action)]">$ {fleteTotal.toLocaleString('es-CO')}</span>
      </p>
    </div>
  );
}

function columnasRemesas(sel: number[], toggle: (id: number) => void): ColumnaTabla<RemesaActiva>[] {
  return [
    { key: 'sel', header: '', render: (r) => (
      <input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} aria-label={r.numero} className="h-4 w-4 accent-[var(--kit-azul)]" />
    ) },
    { key: 'remesa', header: 'Remesa', render: (r) => <span className="text-xs font-semibold text-[color:var(--color-text-primary)]">{r.numero}</span> },
    { key: 'ruta', header: 'Ruta', render: (r) => <span className="text-xs text-[color:var(--color-text-secondary)]">{r.municipioOrigenDane} → {r.municipioDestinoDane}</span> },
    { key: 'cantidad', header: 'Cantidad', align: 'right', render: (r) => <span className="text-xs text-[color:var(--color-text-secondary)]">{Number(r.cantidadCargada).toLocaleString('es-CO')}</span> },
    { key: 'flete', header: 'Flete', align: 'right', render: (r) => <span className="text-xs font-medium text-[color:var(--color-text-primary)]">$ {Number(r.valorFlete).toLocaleString('es-CO')}</span> },
  ];
}

interface Step4Props { form: Form; setForm: (f: Form) => void; fleteTotal: number; }
function Step4({ form, setForm, fleteTotal }: Step4Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold text-[color:var(--color-action)]">Resumen</p>
        <PildoraTramite datos={[{ etiqueta: 'Flete total:', valor: `$ ${fleteTotal.toLocaleString('es-CO')}` }]} estado={`${form.remesaIds.length} remesas asignadas`} />
      </div>

      <Field label="Titular de pago — tipo">
        <select value={form.titularPagoTipo} onChange={(e) => setForm({ ...form, titularPagoTipo: e.target.value as Form['titularPagoTipo'] })} className={inputCls}>
          <option value="conductor">Conductor</option>
          <option value="propietario">Propietario del vehículo</option>
          <option value="empresa">Empresa</option>
          <option value="tercero">Tercero</option>
        </select>
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Documento titular"><input value={form.titularPagoDoc} onChange={(e) => setForm({ ...form, titularPagoDoc: e.target.value })} className={inputCls} /></Field>
        <Field label="Nombre titular"><input value={form.titularPagoNombre} onChange={(e) => setForm({ ...form, titularPagoNombre: e.target.value })} className={inputCls} /></Field>
        <Field label="Cuenta bancaria"><input value={form.titularPagoCuenta} onChange={(e) => setForm({ ...form, titularPagoCuenta: e.target.value })} className={inputCls} /></Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
  return <label className="campo"><span className="etiqueta">{label}</span>{children}</label>;
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
