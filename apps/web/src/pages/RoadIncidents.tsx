import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import { IconClose } from '../components/flit/icons';

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

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RoadIncidents() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  const filterBtn = (key: string, label: string, activeBg: string) => {
    const active = tipoFilter === key;
    return (
      <button
        onClick={() => setTipoFilter(key)}
        aria-pressed={active}
        aria-label={`Filtrar por ${label}`}
        className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
        style={active
          ? { background: activeBg, color: '#fff' }
          : { background: '#fff', border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-muted)' }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Incidentes viales"
        subtitle="Accidentes, casi-accidentes y comparendos para indicadores PESV"
        actions={isAdmin ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            aria-label="Reportar nuevo incidente vial"
            className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99]"
            style={{ height: '44px', background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            Reportar incidente
          </button>
        ) : undefined}
      />

      <div className="inline-flex w-fit flex-wrap gap-2">
        {filterBtn('', 'Todos', 'var(--flit-blue)')}
        {filterBtn('accidente', 'Accidentes', 'var(--flit-danger)')}
        {filterBtn('casi_accidente', 'Casi-accidentes', 'var(--flit-warning)')}
        {filterBtn('comparendo', 'Comparendos', 'var(--flit-info)')}
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha</Th><Th>Tipo</Th><Th>Gravedad</Th><Th>Vehículo</Th><Th>Conductor</Th><Th>Víctimas</Th><Th>Días perdidos</Th><Th>Estado</Th><Th>Acción</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={9} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin incidentes</td></tr>}
              {items.map((i) => (
                <tr key={i.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{i.fecha}</td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{i.tipo.replace('_', ' ')}</td>
                  <td className="px-4 py-3"><GravedadPill g={i.gravedad} /></td>
                  <td className="px-4 py-3">{i.plate ? <Link to={`/fleet/${i.vehicleId}`} className="text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>{i.plate}</Link> : '—'}</td>
                  <td className="px-4 py-3">{i.conductorId ? <Link to={`/pesv/conductores/${i.conductorId}`} className="text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>{i.conductorName}</Link> : '—'}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{i.victimasCount}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{i.diasPerdidos}</td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-muted)' }}>{i.estado}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setSelectedId(i.id)} aria-label={`Investigar incidente ${i.id}`} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Investigar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateIncidentModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {selectedId && <CausaRaizDrawer incidentId={selectedId} onClose={() => setSelectedId(null)} onSaved={() => { setSelectedId(null); load(); }} />}
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
}

function GravedadPill({ g }: { g: string }) {
  const tone: Record<string, ChipTone> = { sin: 'neutral', leve: 'warning', grave: 'warning', fatal: 'danger' };
  return <StatusChip tone={tone[g] ?? 'neutral'}>{g}</StatusChip>;
}

function CreateIncidentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
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
    Promise.all([
      api.get<{ data: Vehicle[] }>('/fleet/vehicles?limit=500'),
      api.get<{ data: Driver[] }>('/drivers'),
    ])
      .then(([v, d]) => { setVehicles(v.data); setDrivers(d.data); })
      .catch((err) => toast.error(errorMessage(err)));
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
    <FlitModal title="Reportar incidente vial" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
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
        <div className="grid grid-cols-2 gap-3">
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
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className={inputCls}>
            <option value="">— sin conductor —</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Lugar"><input value={lugar} onChange={(e) => setLugar(e.target.value)} maxLength={300} className={inputCls} /></Field>
        <Field label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={2000} rows={3} className={inputCls} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Víctimas"><input type="number" min="0" value={victimas} onChange={(e) => setVictimas(e.target.value)} className={inputCls} /></Field>
          <Field label="Días perdidos"><input type="number" min="0" value={diasPerdidos} onChange={(e) => setDiasPerdidos(e.target.value)} className={inputCls} /></Field>
          <Field label="Costos"><input type="number" min="0" step="1000" value={costos} onChange={(e) => setCostos(e.target.value)} className={inputCls} /></Field>
        </div>
        {tipo === 'comparendo' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Número comparendo"><input value={comparendoNumero} onChange={(e) => setComparendoNumero(e.target.value)} maxLength={40} className={inputCls} /></Field>
            <Field label="Valor multa"><input type="number" min="0" value={valorMulta} onChange={(e) => setValorMulta(e.target.value)} className={inputCls} /></Field>
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <button
            type="submit"
            disabled={submitting}
            className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-55"
            style={{ height: '44px', background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            {submitting ? 'Registrando…' : 'Registrar'}
          </button>
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
    <div className="fixed inset-0 z-40 flex items-stretch justify-end" style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }} onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto" style={{ background: 'var(--flit-bg-modal)', borderLeft: '1px solid var(--flit-border-soft)' }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4" style={{ background: 'var(--flit-bg-modal)', borderBottom: '1px solid var(--flit-border-soft)' }}>
          <div>
            <h2 className="text-lg font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>Investigación incidente #{incidentId}</h2>
            <p className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Paso 13 PESV · Res. 40595/2022 · {detail.data.tipo} {detail.data.fecha}</p>
          </div>
          <button onClick={onClose} aria-label="Cerrar drawer" className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-white" style={{ color: 'var(--flit-text-muted)' }}><IconClose className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 px-6 py-4">
          {ya && (
            <div className="rounded-[12px] p-3 text-xs" style={{ background: 'rgba(112,207,58,0.12)', border: '1px solid rgba(112,207,58,0.25)', color: 'var(--flit-success)' }}>
              Investigación cerrada el {detail.data.investigacionCerradaAt?.slice(0, 10)}. Puedes editar la metodología pero el cierre se mantiene.
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Gravedad:</span> {detail.data.gravedad}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Víctimas:</span> {detail.data.victimasCount}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Conductor:</span> {detail.data.conductorName ?? '—'}</div>
            <div><span style={{ color: 'var(--flit-text-muted)' }}>Vehículo:</span> {detail.data.plate ?? '—'}</div>
          </div>

          {detail.data.descripcion && (
            <div className="rounded-[12px] bg-white p-3 text-xs" style={{ border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-primary)' }}>
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>Descripción</span>
              <p className="mt-1 whitespace-pre-wrap">{detail.data.descripcion}</p>
            </div>
          )}

          <div>
            <label className="mb-2 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Metodología de análisis</label>
            <div className="grid grid-cols-4 gap-1">
              {(['5_porques', 'ishikawa', 'arbol_causas', 'otro'] as Metodo[]).map((m) => {
                const on = metodo === m;
                return (
                  <button
                    key={m}
                    onClick={() => setMetodo(m)}
                    className="flit-focus rounded-[10px] px-2 py-2 text-[11px] font-semibold transition-colors"
                    style={on
                      ? { background: 'var(--flit-blue)', color: '#fff' }
                      : { background: '#fff', border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
                  >
                    {m.replace(/_/g, ' ')}
                  </button>
                );
              })}
            </div>
          </div>

          {metodo === '5_porques' && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Pregunta "¿por qué?" 5 veces, cada respuesta es la base del siguiente porqué. Mínimo 3.</p>
              {porques.map((p, idx) => (
                <input key={idx} value={p} onChange={(e) => {
                  const next = [...porques]; next[idx] = e.target.value; setPorques(next);
                }} placeholder={`¿Por qué? #${idx + 1}`} className={inputCls} />
              ))}
            </div>
          )}

          {metodo === 'ishikawa' && (
            <div className="space-y-3">
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Diagrama Ishikawa por 4 categorías estándar (humano, vehículo, vía, entorno).</p>
              {(['humano', 'vehiculo', 'via', 'entorno'] as const).map((cat) => (
                <div key={cat}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>{cat}</p>
                  {ishikawa[cat].map((c, idx) => (
                    <div key={idx} className="mb-1 flex gap-1">
                      <input value={c} onChange={(e) => {
                        const next = { ...ishikawa };
                        next[cat] = [...next[cat]]; next[cat][idx] = e.target.value;
                        setIshikawa(next);
                      }} placeholder={`Causa ${cat}`} className={inputCls + ' flex-1'} />
                      {idx === ishikawa[cat].length - 1 && (
                        <button
                          type="button"
                          onClick={() => setIshikawa({ ...ishikawa, [cat]: [...ishikawa[cat], ''] })}
                          className="flit-focus rounded-[10px] bg-white px-3 text-xs" style={{ border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
                        >
                          +
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {metodo === 'arbol_causas' && (
            <textarea value={arbol} onChange={(e) => setArbol(e.target.value)} rows={6}
              className={inputCls + ' font-mono text-xs'}
              placeholder="Estructura del árbol de causas (ASCII art o texto): &#10;Evento principal&#10;├── Causa inmediata 1&#10;│   └── Causa básica 1.1&#10;└── Causa inmediata 2" />
          )}

          {metodo === 'otro' && (
            <textarea value={otro} onChange={(e) => setOtro(e.target.value)} rows={5}
              className={inputCls} placeholder="Describir metodología y hallazgos (≥20 chars)" />
          )}

          <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={cerrar} onChange={(e) => setCerrar(e.target.checked)} style={{ accentColor: 'var(--flit-blue)' }} />
            Cerrar investigación al guardar (registra fecha de cierre)
          </label>
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 px-6 py-4" style={{ background: 'var(--flit-bg-modal)', borderTop: '1px solid var(--flit-border-soft)' }}>
          <button onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cerrar</button>
          <GradientButton type="button" onClick={submit} disabled={saving}>{saving ? 'Guardando…' : 'Guardar análisis'}</GradientButton>
        </div>
      </div>
    </div>
  );
}
