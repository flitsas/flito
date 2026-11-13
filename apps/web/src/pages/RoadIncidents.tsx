import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import ModalPortal from '../components/flit/ModalPortal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import InlineAlert from '../components/flit/InlineAlert';
import { FlitPillButton, FlitPillGroup } from '../components/flit/flitPageKit';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { Icono } from '../components/flit/kit/Icono';
import { claveEstadoIncidente, claveGravedadIncidente } from '../components/fleet/estados-incidentes';

interface Incident {
  id: number; tipo: string; fecha: string; gravedad: string; estado: string;
  plate: string | null; vehicleId: number | null;
  conductorId: number | null; conductorName: string | null;
  descripcion: string | null; victimasCount: number; diasPerdidos: number;
}
interface CausaRaizJsonb {
  porques?: string[];
  categorias?: {
    humano?: string[];
    vehiculo?: string[];
    via?: string[];
    entorno?: string[];
  };
  arbol?: string;
  descripcion?: string;
}
interface IncidentDetail {
  data: Incident & {
    causaRaizMetodo?: 'cinco_porques' | '5_porques' | 'ishikawa' | 'arbol_causas' | 'otro' | null;
    causaRaizJsonb?: CausaRaizJsonb;
    investigacionResponsableId?: number | null;
    investigacionCerradaAt?: string | null;
  };
  actions: Array<{ id: number; descripcion: string; estado: string; fechaLimite: string | null }>;
}

interface Vehicle { id: number; plate: string | null; alias: string | null; }
interface Driver { id: number; name: string; }

const inputCls = 'control';

export default function RoadIncidents() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.incidentes_registro.administrar');
  const [items, setItems] = useState<Incident[]>([]);
  const [tipoFilter, setTipoFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (tipoFilter) params.set('tipo', tipoFilter);
      const r = await api.get<{ data: Incident[] }>(`/drivers/incidents${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [tipoFilter]);
  useEffect(() => { load(); }, [load]);

  // Segmentado del kit (`.chip` con aria-pressed: activo borde y texto azul). Filtra por tipo; no son pestañas.
  const filterBtn = (key: string, label: string) => {
    const active = tipoFilter === key;
    return (
      <button
        type="button"
        onClick={() => setTipoFilter(key)}
        aria-pressed={active}
        aria-label={`Filtrar por ${label}`}
        className="chip flit-focus shrink-0 text-sm font-semibold transition-colors"
      >
        <span>{label}</span>
      </button>
    );
  };

  const columnas: ColumnaTabla<Incident>[] = [
    { key: 'fecha', header: 'Fecha', render: (i) => <span className="text-xs text-[color:var(--color-text-secondary)]">{i.fecha}</span> },
    { key: 'tipo', header: 'Tipo', render: (i) => <span className="text-xs capitalize text-[color:var(--color-text-secondary)]">{i.tipo.replace('_', ' ')}</span> },
    { key: 'gravedad', header: 'Gravedad', render: (i) => <GravedadPill g={i.gravedad} /> },
    { key: 'vehiculo', header: 'Vehículo', render: (i) => (i.plate ? <Link to={`/fleet/${i.vehicleId}`} className="flit-focus text-xs font-semibold text-[color:var(--color-action)] transition-colors hover:underline">{i.plate}</Link> : '—') },
    { key: 'conductor', header: 'Conductor', render: (i) => (i.conductorId ? <Link to={`/pesv/conductores/${i.conductorId}`} className="flit-focus text-xs font-semibold text-[color:var(--color-action)] transition-colors hover:underline">{i.conductorName}</Link> : '—') },
    { key: 'victimas', header: 'Víctimas', align: 'right', render: (i) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{i.victimasCount}</span> },
    { key: 'dias', header: 'Días perdidos', align: 'right', render: (i) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{i.diasPerdidos}</span> },
    { key: 'estado', header: 'Estado', render: (i) => <span className="capitalize"><EtiquetaEstado estado={claveEstadoIncidente(i.estado)}>{i.estado}</EtiquetaEstado></span> },
    {
      key: 'accion', header: 'Acción', etiqueta: 'Acción', acciones: true,
      render: (i) => <GradientButton type="button" size="sm" onClick={() => setSelectedId(i.id)} aria-label={`Investigar incidente ${i.id}`}>Investigar</GradientButton>,
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Incidentes viales"
        subtitle="Accidentes, casi-accidentes y comparendos para indicadores PESV"
        icono="flito-incidentes"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
        actions={isAdmin ? (
          <GradientButton type="button" onClick={() => setShowCreate(true)} aria-label="Reportar nuevo incidente vial">
            <Icono nombre="mas" size={20} />
            Reportar incidente
          </GradientButton>
        ) : undefined}
      />

      <div className="flex flex-wrap gap-2">
        {filterBtn('', 'Todos')}
        {filterBtn('accidente', 'Accidentes')}
        {filterBtn('casi_accidente', 'Casi-accidentes')}
        {filterBtn('comparendo', 'Comparendos')}
      </div>

      <DataTable
        ariaLabel="Incidentes viales"
        columnas={columnas}
        filas={items}
        getKey={(i) => String(i.id)}
        emptyMessage="Sin incidentes"
      />

      {showCreate && <CreateIncidentModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {selectedId && <CausaRaizDrawer incidentId={selectedId} onClose={() => setSelectedId(null)} onSaved={() => { setSelectedId(null); load(); }} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="campo"><span className="etiqueta">{label}</span>{children}</label>;
}

function GravedadPill({ g }: { g: string }) {
  return <span className="capitalize"><EtiquetaEstado estado={claveGravedadIncidente(g)}>{g}</EtiquetaEstado></span>;
}

function CreateIncidentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [tipo, setTipo] = useState<'accidente' | 'casi_accidente' | 'comparendo'>('accidente');
  const [vehicleId, setVehicleId] = useState('');
  const [conductorId, setConductorId] = useState('');
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [hora, setHora] = useState('');
  const [lugar, setLugar] = useState('');
  const [gravedad, setGravedad] = useState<'sin' | 'leve' | 'grave' | 'fatal'>('sin');
  const [descripcion, setDescripcion] = useState('');
  const [costos, setCostos] = useState('');
  const [victimas, setVictimas] = useState('0');
  const [diasPerdidos, setDiasPerdidos] = useState('0');
  const [comparendoNumero, setComparendoNumero] = useState('');
  const [valorMulta, setValorMulta] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  useEffect(() => {
    api.get<{ data: Vehicle[] }>('/fleet/vehicles?limit=500')
      .then((v) => setVehicles(v.data))
      .catch((err) => toast.error(errorMessage(err)));
    // HU 13421: la lista de conductores cuelga del ítem «Conductores». Sin él, `/drivers` responde
    // 403 y el selector degrada a «sin conductor» con un aviso, sin tumbar el resto del formulario.
    api.get<{ data: Driver[] }>('/drivers')
      .then((d) => setDrivers(d.data))
      .catch((err) => setDriversError(err instanceof ApiError && err.status === 403
        ? 'No tienes acceso a la lista de conductores; registra el incidente sin conductor o pide el permiso de Conductores.'
        : 'No se pudo cargar la lista de conductores.'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!fecha) { toast.error('Fecha requerida'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        tipo, fecha, gravedad,
        descripcion: descripcion.trim() || null,
        costos: parseFloat(costos) || 0,
        victimasCount: parseInt(victimas, 10) || 0,
        diasPerdidos: parseInt(diasPerdidos, 10) || 0,
      };
      if (vehicleId) body.vehicleId = parseInt(vehicleId, 10);
      if (conductorId) body.conductorId = parseInt(conductorId, 10);
      if (hora) body.hora = hora;
      if (lugar.trim()) body.lugarTexto = lugar.trim();
      if (tipo === 'comparendo' && comparendoNumero.trim()) body.comparendoNumero = comparendoNumero.trim();
      if (tipo === 'comparendo' && valorMulta) body.valorMulta = parseFloat(valorMulta);
      await api.post('/drivers/incidents', body);
      toast.success('Incidente registrado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Reportar incidente vial" onClose={onClose} icono="alerta" wide>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Tipo *">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as 'accidente' | 'casi_accidente' | 'comparendo')} className={inputCls}>
              <option value="accidente">Accidente</option>
              <option value="casi_accidente">Casi-accidente</option>
              <option value="comparendo">Comparendo</option>
            </select>
          </Field>
          <Field label="Gravedad">
            <select value={gravedad} onChange={(e) => setGravedad(e.target.value as 'sin' | 'leve' | 'grave' | 'fatal')} className={inputCls}>
              <option value="sin">Sin lesionados</option>
              <option value="leve">Leve</option>
              <option value="grave">Grave</option>
              <option value="fatal">Fatal</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Fecha *"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={inputCls} /></Field>
          <Field label="Hora"><input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className={inputCls} /></Field>
        </div>
        <Field label="Vehículo">
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputCls}>
            <option value="">— sin vehículo —</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate || `#${v.id}`}</option>)}
          </select>
        </Field>
        <Field label="Conductor">
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className={inputCls} disabled={driversError !== null} aria-describedby={driversError ? 'incidente-conductores-aviso' : undefined}>
            <option value="">— sin conductor —</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {driversError && <p id="incidente-conductores-aviso" role="status" className="text-xs text-[color:var(--color-text-tertiary)]">{driversError}</p>}
        </Field>
        <Field label="Lugar"><input value={lugar} onChange={(e) => setLugar(e.target.value)} maxLength={300} className={inputCls} /></Field>
        <Field label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={2000} rows={3} className={inputCls} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Víctimas"><input type="number" min="0" value={victimas} onChange={(e) => setVictimas(e.target.value)} className={inputCls} /></Field>
          <Field label="Días perdidos"><input type="number" min="0" value={diasPerdidos} onChange={(e) => setDiasPerdidos(e.target.value)} className={inputCls} /></Field>
          <Field label="Costos"><input type="number" min="0" step="1000" value={costos} onChange={(e) => setCostos(e.target.value)} className={inputCls} /></Field>
        </div>
        {tipo === 'comparendo' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Número comparendo"><input value={comparendoNumero} onChange={(e) => setComparendoNumero(e.target.value)} maxLength={40} className={inputCls} /></Field>
            <Field label="Valor multa"><input type="number" min="0" value={valorMulta} onChange={(e) => setValorMulta(e.target.value)} className={inputCls} /></Field>
          </div>
        )}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Registrando…' : 'Registrar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

// ============ CAUSA RAÍZ DRAWER (Paso 13 PESV — investigación incidente) ============
type Metodo = '5_porques' | 'ishikawa' | 'arbol_causas' | 'otro';

function CausaRaizDrawer({ incidentId, onClose, onSaved }: { incidentId: number; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [metodo, setMetodo] = useState<Metodo>('5_porques');
  const [porques, setPorques] = useState<string[]>(['', '', '', '', '']);
  const [ishikawa, setIshikawa] = useState<{ humano: string[]; vehiculo: string[]; via: string[]; entorno: string[] }>({
    humano: [''], vehiculo: [''], via: [''], entorno: [''],
  });
  const [arbol, setArbol] = useState<string>('');
  const [otro, setOtro] = useState<string>('');
  const [cerrar, setCerrar] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<IncidentDetail>(`/drivers/incidents/${incidentId}`).then((r) => {
      setDetail(r);
      const m = r.data.causaRaizMetodo;
      if (m === '5_porques' || m === 'cinco_porques') {
        setMetodo('5_porques');
        const arr = (r.data.causaRaizJsonb?.porques ?? ['', '', '', '', '']) as string[];
        setPorques([...arr, '', '', '', '', ''].slice(0, 5));
      } else if (m === 'ishikawa') {
        setMetodo('ishikawa');
        const cats = r.data.causaRaizJsonb?.categorias ?? {};
        setIshikawa({
          humano: cats.humano?.length ? cats.humano : [''],
          vehiculo: cats.vehiculo?.length ? cats.vehiculo : [''],
          via: cats.via?.length ? cats.via : [''],
          entorno: cats.entorno?.length ? cats.entorno : [''],
        });
      } else if (m === 'arbol_causas') {
        setMetodo('arbol_causas');
        setArbol(r.data.causaRaizJsonb?.arbol ?? '');
      } else if (m === 'otro') {
        setMetodo('otro');
        setOtro(r.data.causaRaizJsonb?.descripcion ?? '');
      }
    }).catch((e) => toast.error(errorMessage(e)));
  }, [incidentId]);

  const submit = async () => {
    let jsonb: CausaRaizJsonb = {};
    if (metodo === '5_porques') {
      const filled = porques.filter((p) => p.trim().length > 0);
      if (filled.length < 3) { toast.error('Mínimo 3 "porqués" para metodología válida'); return; }
      jsonb = { porques: filled };
    } else if (metodo === 'ishikawa') {
      const categorias = {
        humano: ishikawa.humano.filter((s) => s.trim()),
        vehiculo: ishikawa.vehiculo.filter((s) => s.trim()),
        via: ishikawa.via.filter((s) => s.trim()),
        entorno: ishikawa.entorno.filter((s) => s.trim()),
      };
      jsonb = { categorias };
      const totalCausas = Object.values(categorias).reduce((acc: number, arr: string[]) => acc + arr.length, 0);
      if (totalCausas < 2) { toast.error('Mínimo 2 causas en total para Ishikawa'); return; }
    } else if (metodo === 'arbol_causas') {
      if (arbol.trim().length < 20) { toast.error('Descripción del árbol ≥20 chars'); return; }
      jsonb = { arbol };
    } else {
      if (otro.trim().length < 20) { toast.error('Descripción ≥20 chars'); return; }
      jsonb = { descripcion: otro };
    }
    setSaving(true);
    try {
      await api.patch(`/pesv/incidents/${incidentId}/causa-raiz`, { metodo, jsonb, cerrarInvestigacion: cerrar });
      toast.success(cerrar ? 'Investigación cerrada' : 'Causa raíz guardada');
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  if (!detail) return null;
  const ya = !!detail.data.investigacionCerradaAt;

  return (
    <ModalPortal>
    <div className="flit-modal kit-velo items-stretch justify-end" onClick={onClose}>
      <div className="kit-modal kit-modal--lateral flex w-full max-w-2xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="kit-modal__cabeza">
          <Icono nombre="consulta" disco size={52} />
          <div className="min-w-0">
            <h2 className="kit-modal__titulo">Investigación incidente #{incidentId}</h2>
            <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Paso 13 PESV · Res. 40595/2022 · {detail.data.tipo} {detail.data.fecha}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar drawer" className="kit-modal__cerrar"><Icono nombre="cerrar" size={20} /></button>
        </div>

        <div className="kit-modal__cuerpo min-h-0 flex-1 space-y-4 overflow-y-auto">
          {ya && (
            <InlineAlert tono="ok">
              Investigación cerrada el {detail.data.investigacionCerradaAt?.slice(0, 10)}. Puedes editar la metodología pero el cierre se mantiene.
            </InlineAlert>
          )}

          <div className="grid grid-cols-1 gap-2 text-xs text-[color:var(--color-text-secondary)] sm:grid-cols-2">
            <div><span className="text-[color:var(--color-text-tertiary)]">Gravedad:</span> {detail.data.gravedad}</div>
            <div><span className="text-[color:var(--color-text-tertiary)]">Víctimas:</span> {detail.data.victimasCount}</div>
            <div><span className="text-[color:var(--color-text-tertiary)]">Conductor:</span> {detail.data.conductorName ?? '—'}</div>
            <div><span className="text-[color:var(--color-text-tertiary)]">Vehículo:</span> {detail.data.plate ?? '—'}</div>
          </div>

          {detail.data.descripcion && (
            <div className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--kit-hover)] p-3 text-xs text-[color:var(--color-text-primary)]">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">Descripción</span>
              <p className="mt-1 whitespace-pre-wrap">{detail.data.descripcion}</p>
            </div>
          )}

          <div>
            <label className="mb-2 block text-xs font-semibold text-[color:var(--color-text-primary)]">Metodología de análisis</label>
            <FlitPillGroup>
              {(['5_porques', 'ishikawa', 'arbol_causas', 'otro'] as Metodo[]).map((m) => (
                <FlitPillButton key={m} active={metodo === m} onClick={() => setMetodo(m)}>
                  {m.replace(/_/g, ' ')}
                </FlitPillButton>
              ))}
            </FlitPillGroup>
          </div>

          {metodo === '5_porques' && (
            <div className="space-y-2">
              <p className="text-xs text-[color:var(--color-text-secondary)]">Pregunta "¿por qué?" 5 veces, cada respuesta es la base del siguiente porqué. Mínimo 3.</p>
              {porques.map((p, idx) => (
                <input key={idx} value={p} onChange={(e) => {
                  const next = [...porques]; next[idx] = e.target.value; setPorques(next);
                }} placeholder={`¿Por qué? #${idx + 1}`} className={inputCls} />
              ))}
            </div>
          )}

          {metodo === 'ishikawa' && (
            <div className="space-y-3">
              <p className="text-xs text-[color:var(--color-text-secondary)]">Diagrama Ishikawa por 4 categorías estándar (humano, vehículo, vía, entorno).</p>
              {(['humano', 'vehiculo', 'via', 'entorno'] as const).map((cat) => (
                <div key={cat}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-tertiary)]">{cat}</p>
                  {ishikawa[cat].map((c, idx) => (
                    <div key={idx} className="mb-1 flex gap-1">
                      <input value={c} onChange={(e) => {
                        const next = { ...ishikawa };
                        next[cat] = [...next[cat]]; next[cat][idx] = e.target.value;
                        setIshikawa(next);
                      }} placeholder={`Causa ${cat}`} className={inputCls + ' flex-1'} />
                      {idx === ishikawa[cat].length - 1 && (
                        <GradientButton
                          type="button"
                          variant="secondary"
                          onClick={() => setIshikawa({ ...ishikawa, [cat]: [...ishikawa[cat], ''] })}
                          className="shrink-0"
                        >
                          +
                        </GradientButton>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {metodo === 'arbol_causas' && (
            <textarea value={arbol} onChange={(e) => setArbol(e.target.value)} rows={6}
              className={inputCls + ' mono text-xs'}
              placeholder="Estructura del árbol de causas (ASCII art o texto): &#10;Evento principal&#10;├── Causa inmediata 1&#10;│   └── Causa básica 1.1&#10;└── Causa inmediata 2" />
          )}

          {metodo === 'otro' && (
            <textarea value={otro} onChange={(e) => setOtro(e.target.value)} rows={5}
              className={inputCls} placeholder="Describir metodología y hallazgos (≥20 chars)" />
          )}

          <label className="flex cursor-pointer items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <input type="checkbox" checked={cerrar} onChange={(e) => setCerrar(e.target.checked)} className="h-4 w-4 accent-[var(--kit-azul)]" />
            Cerrar investigación al guardar (registra fecha de cierre)
          </label>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] px-6 py-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cerrar</GradientButton>
          <GradientButton type="button" onClick={submit} disabled={saving}>{saving ? 'Guardando…' : 'Guardar análisis'}</GradientButton>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
