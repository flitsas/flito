import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import LiquidacionPanel from '../components/maintenance/LiquidacionPanel';
import { flitInp, FlitCard, FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

interface Wo {
  id: number; numero: string; vehicleId: number;
  tipoTrabajo: string; estado: 'abierta' | 'cerrada_tecnica' | 'cerrada_final' | 'anulada';
  fechaIngresoTaller: string; fechaCierreTecnica: string | null; fechaCierreFinal: string | null;
  costoTotalCalculado: string | null; falla: string | null; observaciones: string | null;
  medicionIngreso: number | null;
}
interface WoJob { id: number; jobId: number; jobCodigo: string | null; jobNombre: string | null; tiempoRealHoras: string | null; costoManoObra: string; }
interface WoPart { id: number; partId: number; partCodigo: string | null; partNombre: string | null; cantidad: string; valorUnit: string | null; descuento: string; aplicadoStock: boolean; }
interface OtroGasto { id: number; concepto: string; monto: string; }
interface Seguimiento { id: number; texto: string | null; createdAt: string; }
interface Detail { data: Wo; jobs: WoJob[]; parts: WoPart[]; otrosGastos: OtroGasto[]; seguimientos: Seguimiento[]; }

interface Job { id: number; codigo: string; nombre: string; }
interface Part { id: number; codigo: string; nombre: string; }
interface Loc { id: number; codigo: string; nombre: string; }

const fmtCurrency = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });

export default function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [d, setD] = useState<Detail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [locs, setLocs] = useState<Loc[]>([]);
  const [showAddJob, setShowAddJob] = useState(false);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showAddGasto, setShowAddGasto] = useState(false);
  const [showSeguimiento, setShowSeguimiento] = useState(false);
  const [closing, setClosing] = useState<'tecnica' | 'final' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [det, j, p, l] = await Promise.all([
        api.get<Detail>(`/maintenance/work-orders/${id}`),
        api.get<{ data: Job[] }>('/maintenance/jobs'),
        api.get<{ data: Part[] }>('/parts'),
        api.get<{ data: Loc[] }>('/parts/locations'),
      ]);
      setD(det); setJobs(j.data); setParts(p.data); setLocs(l.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <div className="p-6 text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</div>;
  const wo = d.data;
  const editable = wo.estado === 'abierta' || wo.estado === 'cerrada_tecnica';
  const cerrable = (wo.estado === 'abierta' || wo.estado === 'cerrada_tecnica') && isAdmin;

  const subTotalJobs = d.jobs.reduce((acc, j) => acc + Number(j.costoManoObra ?? 0), 0);
  const subTotalParts = d.parts.reduce((acc, p) => acc + (Number(p.cantidad) * Number(p.valorUnit ?? 0) - Number(p.descuento ?? 0)), 0);
  const subTotalGastos = d.otrosGastos.reduce((acc, g) => acc + Number(g.monto ?? 0), 0);
  const total = subTotalJobs + subTotalParts + subTotalGastos;

  const closeTecnica = async () => {
    if (closing) return;
    if (!confirm('¿Cerrar técnicamente la OT?')) return;
    setClosing('tecnica');
    try { await api.post(`/maintenance/work-orders/${id}/close-tecnica`); toast.success('Cerrada técnicamente'); load(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setClosing(null); }
  };

  const closeFinal = async () => {
    if (closing) return;
    if (!confirm('¿CERRAR DEFINITIVAMENTE? Esto descontará el inventario y no se puede deshacer fácilmente.')) return;
    setClosing('final');
    try {
      const r = await api.post<{ data: Wo; idempotente?: boolean }>(`/maintenance/work-orders/${id}/close-final`);
      if (r.idempotente) toast(`OT ya estaba cerrada (costo ${fmtCurrency(Number(r.data.costoTotalCalculado))})`);
      else toast.success(`OT cerrada — costo total ${fmtCurrency(Number(r.data.costoTotalCalculado))}`);
      load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setClosing(null); }
  };

  const estadoTone: Record<string, ChipTone> = { abierta: 'warning', cerrada_tecnica: 'active', cerrada_final: 'success', anulada: 'neutral' };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <Link to="/maintenance/work-orders" className="text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>← Órdenes de trabajo</Link>
      <PageHeaderCard
        title={wo.numero}
        subtitle={`${wo.tipoTrabajo} · vehículo #${wo.vehicleId}${wo.falla ? ` · Falla: ${wo.falla}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={estadoTone[wo.estado] ?? 'neutral'}>{wo.estado.replace('_', ' ')}</StatusChip>
            {cerrable && wo.estado === 'abierta' && (
              <button type="button" onClick={closeTecnica} disabled={closing !== null} className="flit-focus rounded-[999px] border bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue)' }}>
                {closing === 'tecnica' ? 'Cerrando…' : 'Cerrar técnica'}
              </button>
            )}
            {cerrable && (
              <GradientButton type="button" onClick={closeFinal} disabled={closing !== null}>{closing === 'final' ? 'Cerrando…' : 'Cerrar final'}</GradientButton>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 @md:grid-cols-3 gap-3 mb-5">
        <Stat label="Mano de obra" value={fmtCurrency(subTotalJobs)} />
        <Stat label="Repuestos" value={fmtCurrency(subTotalParts)} />
        <Stat label="Otros gastos" value={fmtCurrency(subTotalGastos)} />
      </div>
      <div className="mb-2 flex items-center justify-between bg-white p-5" style={{ borderRadius: 'var(--flit-radius-card)', border: '2px solid var(--flit-blue)', boxShadow: 'var(--flit-shadow-card)' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Total estimado</span>
        <span className="text-2xl font-bold tabular-nums" style={{ color: 'var(--flit-blue)' }}>{fmtCurrency(total)}</span>
      </div>

      <Section title={`Trabajos (${d.jobs.length})`} action={editable && isAdmin && <SmallBtn onClick={() => setShowAddJob(true)}>Agregar</SmallBtn>}>
        <Table headers={['Job', 'Mecánico', 'Horas', 'Costo']}>
          {d.jobs.length === 0 && <Empty cols={4} />}
          {d.jobs.map((j) => (
            <tr key={j.id} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{j.jobCodigo} <span style={{ color: 'var(--flit-text-muted)' }}>— {j.jobNombre}</span></td>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{j.id}</td>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{j.tiempoRealHoras ?? '—'}</td>
              <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{fmtCurrency(Number(j.costoManoObra ?? 0))}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Repuestos (${d.parts.length})`} action={editable && isAdmin && <SmallBtn onClick={() => setShowAddPart(true)}>Agregar</SmallBtn>}>
        <Table headers={['Repuesto', 'Cantidad', 'Valor unit', 'Subtotal', 'Stock']}>
          {d.parts.length === 0 && <Empty cols={5} />}
          {d.parts.map((p) => (
            <tr key={p.id} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{p.partCodigo} <span style={{ color: 'var(--flit-text-muted)' }}>— {p.partNombre}</span></td>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{Number(p.cantidad)}</td>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.valorUnit ? fmtCurrency(Number(p.valorUnit)) : 'auto'}</td>
              <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{fmtCurrency(Number(p.cantidad) * Number(p.valorUnit ?? 0) - Number(p.descuento ?? 0))}</td>
              <td className="px-3 py-2 text-xs">
                {p.aplicadoStock
                  ? <span className="text-success font-semibold">aplicado</span>
                  : <span className="text-warning">pendiente</span>}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Otros gastos (${d.otrosGastos.length})`} action={editable && isAdmin && <SmallBtn onClick={() => setShowAddGasto(true)}>Agregar</SmallBtn>}>
        <Table headers={['Concepto', 'Monto']}>
          {d.otrosGastos.length === 0 && <Empty cols={2} />}
          {d.otrosGastos.map((g) => (
            <tr key={g.id} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{g.concepto}</td>
              <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{fmtCurrency(Number(g.monto ?? 0))}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Seguimientos (${d.seguimientos.length})`} action={editable && isAdmin && <SmallBtn onClick={() => setShowSeguimiento(true)}>Agregar nota</SmallBtn>}>
        {d.seguimientos.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin notas</p>}
        <ul className="space-y-2">
          {d.seguimientos.map((s) => (
            <li key={s.id} className="bg-white p-4" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)' }}>
              <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{(s.createdAt as string)?.slice(0, 16).replace('T', ' ')}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm" style={{ color: 'var(--flit-text-primary)' }}>{s.texto}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* TRAM-INNOV-B5-MVP: liquidación + pago manual de la OT. */}
      <LiquidacionPanel woId={Number(id)} isAdmin={isAdmin} />

      {showAddJob && <AddJobForm woId={Number(id)} jobs={jobs} onClose={() => setShowAddJob(false)} onSaved={() => { setShowAddJob(false); load(); }} />}
      {showAddPart && <AddPartForm woId={Number(id)} parts={parts} locs={locs} onClose={() => setShowAddPart(false)} onSaved={() => { setShowAddPart(false); load(); }} />}
      {showAddGasto && <AddGastoForm woId={Number(id)} onClose={() => setShowAddGasto(false)} onSaved={() => { setShowAddGasto(false); load(); }} />}
      {showSeguimiento && <AddSeguimientoForm woId={Number(id)} onClose={() => setShowSeguimiento(false)} onSaved={() => { setShowSeguimiento(false); load(); }} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <FlitCard>
      <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-1 text-base font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{value}</p>
    </FlitCard>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <table className="w-full">
        <thead><tr>
          {headers.map((h) => (
            <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold uppercase" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Empty({ cols }: { cols: number }) {
  return <tr><td colSpan={cols} className="px-3 py-4 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registros</td></tr>;
}

function SmallBtn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-medium" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-blue)' }}>
      {children}
    </button>
  );
}

function AddJobForm({ woId, jobs, onClose, onSaved }: { woId: number; jobs: Job[]; onClose: () => void; onSaved: () => void }) {
  const [jobId, setJobId] = useState('');
  const [tiempo, setTiempo] = useState('');
  const [costo, setCosto] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!jobId) { toast.error('Seleccione un trabajo'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { jobId: parseInt(jobId, 10), costoManoObra: parseFloat(costo) || 0 };
      if (tiempo) body.tiempoRealHoras = parseFloat(tiempo);
      await api.post(`/maintenance/work-orders/${woId}/jobs`, body);
      toast.success('Trabajo agregado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return <FormShell title="Agregar trabajo" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
    <FlitField label="Trabajo *">
      <select value={jobId} onChange={(e) => setJobId(e.target.value)} className={flitInp}>
        <option value="">— seleccione —</option>
        {jobs.map((j) => <option key={j.id} value={j.id}>{j.codigo} — {j.nombre}</option>)}
      </select>
    </FlitField>
    <FlitField label="Tiempo (horas)"><input type="number" step="0.1" value={tiempo} onChange={(e) => setTiempo(e.target.value)} className={flitInp} /></FlitField>
    <FlitField label="Costo mano de obra"><input type="number" min="0" step="100" value={costo} onChange={(e) => setCosto(e.target.value)} className={flitInp} /></FlitField>
  </FormShell>;
}

function AddPartForm({ woId, parts, locs, onClose, onSaved }: { woId: number; parts: Part[]; locs: Loc[]; onClose: () => void; onSaved: () => void }) {
  const [partId, setPartId] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [valorUnit, setValorUnit] = useState('');
  const [ubic, setUbic] = useState(locs[0]?.id ? String(locs[0].id) : '');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!partId || !cantidad || !ubic) { toast.error('Repuesto, cantidad y ubicación requeridos'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        partId: parseInt(partId, 10),
        cantidad: parseFloat(cantidad),
        ubicacionId: parseInt(ubic, 10),
      };
      if (valorUnit) body.valorUnit = parseFloat(valorUnit);
      await api.post(`/maintenance/work-orders/${woId}/parts`, body);
      toast.success('Repuesto agregado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return <FormShell title="Agregar repuesto" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
    <FlitField label="Repuesto *">
      <select value={partId} onChange={(e) => setPartId(e.target.value)} className={flitInp}>
        <option value="">— seleccione —</option>
        {parts.map((p) => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
      </select>
    </FlitField>
    <div className="grid grid-cols-2 gap-3">
      <FlitField label="Cantidad *"><input type="number" min="0.001" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={flitInp} /></FlitField>
      <FlitField label="Valor unit (auto si vacío)"><input type="number" min="0" step="100" value={valorUnit} onChange={(e) => setValorUnit(e.target.value)} className={flitInp} /></FlitField>
    </div>
    <FlitField label="Ubicación origen *">
      <select value={ubic} onChange={(e) => setUbic(e.target.value)} className={flitInp}>
        {locs.map((l) => <option key={l.id} value={l.id}>{l.codigo} — {l.nombre}</option>)}
      </select>
    </FlitField>
    <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>El stock se descuenta solo al cerrar finalmente la OT.</p>
  </FormShell>;
}

function AddGastoForm({ woId, onClose, onSaved }: { woId: number; onClose: () => void; onSaved: () => void }) {
  const [concepto, setConcepto] = useState('');
  const [monto, setMonto] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!concepto.trim() || !monto) { toast.error('Concepto y monto requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post(`/maintenance/work-orders/${woId}/otros-gastos`, { concepto: concepto.trim(), monto: parseFloat(monto) });
      toast.success('Gasto registrado'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return <FormShell title="Agregar otro gasto" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
    <FlitField label="Concepto *"><input value={concepto} onChange={(e) => setConcepto(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
    <FlitField label="Monto *"><input type="number" min="0" step="100" value={monto} onChange={(e) => setMonto(e.target.value)} className={flitInp} /></FlitField>
  </FormShell>;
}

function AddSeguimientoForm({ woId, onClose, onSaved }: { woId: number; onClose: () => void; onSaved: () => void }) {
  const [texto, setTexto] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!texto.trim()) { toast.error('Escriba una nota'); return; }
    setSubmitting(true);
    try {
      await api.post(`/maintenance/work-orders/${woId}/seguimiento`, { texto: texto.trim() });
      toast.success('Nota agregada'); onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };
  return <FormShell title="Agregar seguimiento" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Guardar">
    <FlitField label="Nota *"><textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} maxLength={2000} className={flitInp} /></FlitField>
  </FormShell>;
}

function FormShell({ title, onClose, onSubmit, submitting, submitLabel, children }: { title: string; onClose: () => void; onSubmit: (e: FormEvent) => void; submitting: boolean; submitLabel: string; children: ReactNode }) {
  return (
    <FlitModal title={title} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-3 px-6 pb-6">
        {children}
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>{submitting ? 'Guardando…' : submitLabel}</button>
        </div>
      </form>
    </FlitModal>
  );
}
