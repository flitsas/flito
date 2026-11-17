import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import KpiCard from '../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador, Vacio } from '../components/flit/Cargador';
import { ActividadLinea, EtiquetaEstado, LineaAvance, ListaFila } from '../components/flit/Bloques';
import type { NombreIcono } from '../components/flit/kit/Icono';
import LiquidacionPanel from '../components/maintenance/LiquidacionPanel';
import { ESTADO_OT, ESTADO_STOCK_APLICADO, ESTADO_STOCK_PENDIENTE } from '../components/maintenance/estados-mantenimiento';
import { flitInp, FlitCard, FlitField } from '../components/flit/flitPageKit';

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
const fecha = (iso: string | null) => (iso ? iso.slice(0, 10) : undefined);

/** Paso de la línea de avance por estado de la OT; `anulada` no tiene línea. Con 3 = los tres pasos hechos. */
const PASO_OT: Record<Wo['estado'], number | null> = { abierta: 0, cerrada_tecnica: 1, cerrada_final: 3, anulada: null };

const COLUMNAS_GASTOS: ColumnaTabla<OtroGasto>[] = [
  { key: 'concepto', header: 'Concepto', etiqueta: 'Concepto', render: (g) => <span className="text-[color:var(--color-text-primary)]">{g.concepto}</span> },
  { key: 'monto', header: 'Monto', etiqueta: 'Monto', align: 'right', render: (g) => <span className="mono tabular-nums text-[color:var(--color-text-secondary)]">{fmtCurrency(Number(g.monto ?? 0))}</span> },
];

export default function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('maintenance.ordenes.administrar');
  const [d, setD] = useState<Detail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [locs, setLocs] = useState<Loc[]>([]);
  const [showAddJob, setShowAddJob] = useState(false);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showAddGasto, setShowAddGasto] = useState(false);
  const [showSeguimiento, setShowSeguimiento] = useState(false);
  const [closing, setClosing] = useState<'tecnica' | 'final' | null>(null);
  // HU #13422: los catálogos (trabajos, repuestos, bodegas) son del ítem «Mantenimiento». Sin esa
  // página la orden se sigue viendo; solo los selectores de agregar quedan vacíos, con aviso.
  const [sinCatalogos, setSinCatalogos] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      let sinPermiso = false;
      const catalogo = <T,>(ruta: string) => api.get<{ data: T[] }>(ruta).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 403) { sinPermiso = true; return { data: [] as T[] }; }
        throw err;
      });
      const [det, j, p, l] = await Promise.all([
        api.get<Detail>(`/maintenance/work-orders/${id}`),
        catalogo<Job>('/maintenance/jobs'),
        catalogo<Part>('/parts'),
        catalogo<Loc>('/parts/locations'),
      ]);
      setD(det); setJobs(j.data); setParts(p.data); setLocs(l.data); setSinCatalogos(sinPermiso);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <Cargador texto="Cargando…" className="py-16" />;
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

  const paso = PASO_OT[wo.estado];
  const agregar = (onClick: () => void, texto = 'Agregar') => (editable && isAdmin
    ? <GradientButton type="button" variant="secondary" size="sm" onClick={onClick}>{texto}</GradientButton>
    : undefined);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      {sinCatalogos && (
        <p role="status" className="text-sm text-[color:var(--color-text-tertiary)]">
          No tienes acceso a «Mantenimiento»: los catálogos de trabajos y repuestos no se cargan para agregar a esta orden.
        </p>
      )}
      <PageHeaderCard
        title={wo.numero}
        subtitle={`${wo.tipoTrabajo} · vehículo #${wo.vehicleId}${wo.falla ? ` · Falla: ${wo.falla}` : ''}`}
        icono="flito-ordenes-trabajo"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }, { etiqueta: 'Órdenes de trabajo', to: '/maintenance/work-orders' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EtiquetaEstado estado={ESTADO_OT[wo.estado] ?? wo.estado}>{wo.estado.replace('_', ' ')}</EtiquetaEstado>
            {cerrable && wo.estado === 'abierta' && (
              <GradientButton type="button" variant="secondary" onClick={closeTecnica} disabled={closing !== null} ocupado={closing === 'tecnica'}>
                {closing === 'tecnica' ? 'Cerrando…' : 'Cerrar técnica'}
              </GradientButton>
            )}
            {cerrable && (
              <GradientButton type="button" variant="success" onClick={closeFinal} disabled={closing !== null} ocupado={closing === 'final'}>
                {closing === 'final' ? 'Cerrando…' : 'Cerrar final'}
              </GradientButton>
            )}
          </div>
        }
      />

      {paso !== null && (
        <FlitCard>
          <LineaAvance
            actual={paso}
            pasos={[
              { etiqueta: 'Abierta', detalle: fecha(wo.fechaIngresoTaller) },
              { etiqueta: 'Cerrada técnica', detalle: fecha(wo.fechaCierreTecnica) },
              { etiqueta: 'Cerrada final', detalle: fecha(wo.fechaCierreFinal) },
            ]}
          />
        </FlitCard>
      )}

      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Mano de obra" value={fmtCurrency(subTotalJobs)} />
        <KpiCard label="Repuestos" value={fmtCurrency(subTotalParts)} />
        <KpiCard label="Otros gastos" value={fmtCurrency(subTotalGastos)} />
        <KpiCard label="Total estimado" value={fmtCurrency(total)} icono="flito-ordenes-trabajo" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Section title={`Trabajos (${d.jobs.length})`} action={agregar(() => setShowAddJob(true))}>
          {d.jobs.length === 0 ? <Vacio texto="Sin registros" icono="lista" /> : (
            <ListaFila filas={d.jobs.map((j) => ({
              id: String(j.id),
              titulo: <>{j.jobCodigo} <span className="font-normal text-[color:var(--color-text-tertiary)]">— {j.jobNombre}</span></>,
              detalle: `Mecánico: ${j.id} · Horas: ${j.tiempoRealHoras ?? '—'}`,
              extra: <span className="mono shrink-0 tabular-nums text-sm text-[color:var(--color-text-primary)]">{fmtCurrency(Number(j.costoManoObra ?? 0))}</span>,
            }))} />
          )}
        </Section>

        <Section title={`Repuestos (${d.parts.length})`} action={agregar(() => setShowAddPart(true))}>
          {d.parts.length === 0 ? <Vacio texto="Sin registros" icono="procesos" /> : (
            <ListaFila filas={d.parts.map((p) => ({
              id: String(p.id),
              titulo: <>{p.partCodigo} <span className="font-normal text-[color:var(--color-text-tertiary)]">— {p.partNombre}</span></>,
              detalle: `Cantidad: ${Number(p.cantidad)} · Valor unit: ${p.valorUnit ? fmtCurrency(Number(p.valorUnit)) : 'auto'}`,
              extra: (
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="mono tabular-nums text-sm text-[color:var(--color-text-primary)]">{fmtCurrency(Number(p.cantidad) * Number(p.valorUnit ?? 0) - Number(p.descuento ?? 0))}</span>
                  {p.aplicadoStock
                    ? <EtiquetaEstado estado={ESTADO_STOCK_APLICADO}>aplicado</EtiquetaEstado>
                    : <EtiquetaEstado estado={ESTADO_STOCK_PENDIENTE}>pendiente</EtiquetaEstado>}
                </span>
              ),
            }))} />
          )}
        </Section>

        <Section title={`Otros gastos (${d.otrosGastos.length})`} action={agregar(() => setShowAddGasto(true))}>
          <DataTable ariaLabel="Otros gastos" columnas={COLUMNAS_GASTOS} filas={d.otrosGastos} getKey={(g) => String(g.id)} emptyMessage="Sin registros" />
        </Section>

        <Section title={`Seguimientos (${d.seguimientos.length})`} action={agregar(() => setShowSeguimiento(true), 'Agregar nota')}>
          {d.seguimientos.length === 0 ? <p className="text-xs text-[color:var(--color-text-tertiary)]">Sin notas</p> : (
            <ActividadLinea eventos={d.seguimientos.map((s) => ({
              id: String(s.id),
              cuando: (s.createdAt as string)?.slice(0, 16).replace('T', ' '),
              fechaIso: s.createdAt,
              texto: <span className="whitespace-pre-wrap">{s.texto}</span>,
            }))} />
          )}
        </Section>
      </div>

      {/* TRAM-INNOV-B5-MVP: liquidación + pago manual de la OT. */}
      <LiquidacionPanel woId={Number(id)} isAdmin={hasFuncion('liquidacion.pago_manual.administrar')} />

      {showAddJob && <AddJobForm woId={Number(id)} jobs={jobs} onClose={() => setShowAddJob(false)} onSaved={() => { setShowAddJob(false); load(); }} />}
      {showAddPart && <AddPartForm woId={Number(id)} parts={parts} locs={locs} onClose={() => setShowAddPart(false)} onSaved={() => { setShowAddPart(false); load(); }} />}
      {showAddGasto && <AddGastoForm woId={Number(id)} onClose={() => setShowAddGasto(false)} onSaved={() => { setShowAddGasto(false); load(); }} />}
      {showSeguimiento && <AddSeguimientoForm woId={Number(id)} onClose={() => setShowSeguimiento(false)} onSaved={() => { setShowSeguimiento(false); load(); }} />}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <FlitCard className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
        {action}
      </div>
      {children}
    </FlitCard>
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
  return <FormShell title="Agregar trabajo" icono="lista" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
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
  return <FormShell title="Agregar repuesto" icono="procesos" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
    <FlitField label="Repuesto *">
      <select value={partId} onChange={(e) => setPartId(e.target.value)} className={flitInp}>
        <option value="">— seleccione —</option>
        {parts.map((p) => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
      </select>
    </FlitField>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <FlitField label="Cantidad *"><input type="number" min="0.001" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={flitInp} /></FlitField>
      <FlitField label="Valor unit (auto si vacío)"><input type="number" min="0" step="100" value={valorUnit} onChange={(e) => setValorUnit(e.target.value)} className={flitInp} /></FlitField>
    </div>
    <FlitField label="Ubicación origen *">
      <select value={ubic} onChange={(e) => setUbic(e.target.value)} className={flitInp}>
        {locs.map((l) => <option key={l.id} value={l.id}>{l.codigo} — {l.nombre}</option>)}
      </select>
    </FlitField>
    <p className="text-xs text-[color:var(--color-text-tertiary)]">El stock se descuenta solo al cerrar finalmente la OT.</p>
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
  return <FormShell title="Agregar otro gasto" icono="pesos" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Agregar">
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
  return <FormShell title="Agregar seguimiento" icono="lapiz" onClose={onClose} onSubmit={submit} submitting={submitting} submitLabel="Guardar">
    <FlitField label="Nota *"><textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} maxLength={2000} className={flitInp} /></FlitField>
  </FormShell>;
}

function FormShell({ title, icono, onClose, onSubmit, submitting, submitLabel, children }: { title: string; icono: NombreIcono; onClose: () => void; onSubmit: (e: FormEvent) => void; submitting: boolean; submitLabel: string; children: ReactNode }) {
  return (
    <FlitModal title={title} icono={icono} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-3">
        {children}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting} ocupado={submitting}>{submitting ? 'Guardando…' : submitLabel}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
