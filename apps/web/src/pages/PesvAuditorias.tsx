import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

type Tipo = 'interna' | 'externa' | 'supert' | 'onac';
type Estado = 'planificada' | 'en_curso' | 'cerrada';
type Severidad = 'observacion' | 'no_conformidad_menor' | 'no_conformidad_mayor' | 'critico';
type HEstado = 'abierto' | 'en_remediacion' | 'cerrado' | 'aceptado';

interface Auditoria { id: number; anio: number; tipo: Tipo; alcance: string; fechaPlanificada: string; fechaInicio: string | null; fechaCierre: string | null; auditorExterno: string | null; estado: Estado; resumen: string | null; }
interface Hallazgo { id: number; auditoriaId: number; pasoPesv: number | null; severidad: Severidad; descripcion: string; estado: HEstado; fechaLimite: string | null; cerradoAt: string | null; accionesMd: string | null; cierreObservaciones: string | null; }
interface Detail extends Auditoria { hallazgos: Hallazgo[]; }

interface HallazgoBody { severidad: Severidad; descripcion: string; pasoPesv?: number; fechaLimite?: string; }

const TIPOS: Tipo[] = ['interna', 'externa', 'supert', 'onac'];
const SEVERIDADES: Severidad[] = ['observacion', 'no_conformidad_menor', 'no_conformidad_mayor', 'critico'];

const SEV_TONE: Record<Severidad, ChipTone> = {
  observacion: 'active', no_conformidad_menor: 'warning', no_conformidad_mayor: 'warning', critico: 'danger',
};

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const cancelBtn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium';

export default function PesvAuditorias() {
  const [items, setItems] = useState<Auditoria[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ anio: new Date().getFullYear(), tipo: 'interna' as Tipo, alcance: '', fechaPlanificada: '' });
  const [selected, setSelected] = useState<Detail | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ data: Auditoria[] }>('/pesv/auditorias');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.alcance.length < 10 || !form.fechaPlanificada) { toast.error('Alcance ≥10 chars y fecha planificada requeridos'); return; }
    try {
      await api.post('/pesv/auditorias', form);
      toast.success('Auditoría creada');
      setShowCreate(false);
      setForm({ anio: new Date().getFullYear(), tipo: 'interna', alcance: '', fechaPlanificada: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const openDetail = async (id: number) => {
    try {
      const r = await api.get<Detail>(`/pesv/auditorias/${id}`);
      setSelected(r);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const cerrar = async (id: number) => {
    if (!confirm('¿Cerrar auditoría? Se marca fecha_cierre con hoy.')) return;
    try {
      await api.post(`/pesv/auditorias/${id}/cerrar`);
      toast.success('Auditoría cerrada');
      setSelected(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Auditorías PESV"
        subtitle="Programa anual con hallazgos por severidad · Paso 22 · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva auditoría</GradientButton>}
      />

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Año</Th><Th>Tipo</Th><Th>Alcance</Th><Th>Planificada</Th><Th>Estado</Th><Th>Acción</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin auditorías</td></tr>}
              {items.map((a) => (
                <tr key={a.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-sm" style={{ color: 'var(--flit-text-primary)' }}>{a.anio}</td>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider" style={{ color: 'var(--flit-text-secondary)' }}>{a.tipo}</td>
                  <td className="max-w-md truncate px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }} title={a.alcance}>{a.alcance}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{a.fechaPlanificada}</td>
                  <td className="px-4 py-3"><EstadoPill v={a.estado} /></td>
                  <td className="px-4 py-3"><button onClick={() => openDetail(a.id)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Ver</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <DetailPanel detail={selected} onUpdate={() => openDetail(selected.id)} onCerrar={() => cerrar(selected.id)} onClose={() => setSelected(null)} />}

      {showCreate && (
        <FlitModal title="Nueva auditoría" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="number" value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value) })} className={inputCls} placeholder="Año" />
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as Tipo })} className={inputCls}>
                {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <input type="date" value={form.fechaPlanificada} onChange={(e) => setForm({ ...form, fechaPlanificada: e.target.value })} className={inputCls} />
            <textarea placeholder="Alcance (≥10 chars)" value={form.alcance} onChange={(e) => setForm({ ...form, alcance: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function DetailPanel({ detail, onUpdate, onCerrar, onClose }: { detail: Detail; onUpdate: () => void; onCerrar: () => void; onClose: () => void }) {
  const [showH, setShowH] = useState(false);
  const [hForm, setHForm] = useState<{ severidad: Severidad; descripcion: string; pasoPesv: string; fechaLimite: string }>({
    severidad: 'observacion', descripcion: '', pasoPesv: '', fechaLimite: '',
  });

  const addHallazgo = async () => {
    if (hForm.descripcion.length < 10) { toast.error('Descripción ≥10 chars'); return; }
    try {
      const body: HallazgoBody = { severidad: hForm.severidad, descripcion: hForm.descripcion };
      if (hForm.pasoPesv) body.pasoPesv = parseInt(hForm.pasoPesv, 10);
      if (hForm.fechaLimite) body.fechaLimite = hForm.fechaLimite;
      await api.post(`/pesv/auditorias/${detail.id}/hallazgos`, body);
      toast.success('Hallazgo agregado');
      setShowH(false);
      setHForm({ severidad: 'observacion', descripcion: '', pasoPesv: '', fechaLimite: '' });
      onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const closeHallazgo = async (id: number) => {
    const obs = prompt('Observaciones de cierre del hallazgo:');
    if (obs === null) return;
    try {
      await api.post(`/pesv/hallazgos/${id}/cerrar`, { cierreObservaciones: obs });
      toast.success('Hallazgo cerrado');
      onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <section className="bg-white p-6" style={CARD}>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Auditoría {detail.anio} · {detail.tipo}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{detail.alcance}</p>
        </div>
        <div className="flex items-center gap-2">
          {detail.estado !== 'cerrada' && (
            <button onClick={onCerrar} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-success)' }}>Cerrar auditoría</button>
          )}
          <button onClick={onClose} className="flit-focus text-2xl leading-none" style={{ color: 'var(--flit-text-muted)' }} aria-label="Cerrar">×</button>
        </div>
      </div>

      <div className="mb-3 mt-6 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Hallazgos ({detail.hallazgos.length})</h3>
        {detail.estado !== 'cerrada' && (
          <button onClick={() => setShowH(true)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Agregar hallazgo</button>
        )}
      </div>
      {detail.hallazgos.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin hallazgos registrados</p>}
      {detail.hallazgos.map((h) => (
        <div key={h.id} className="mb-2 rounded-[12px] p-4" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <StatusChip tone={SEV_TONE[h.severidad]}>{h.severidad.replace(/_/g, ' ')}</StatusChip>
              {h.pasoPesv && <span className="ml-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Paso {h.pasoPesv}</span>}
              {h.fechaLimite && <span className="ml-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Límite {h.fechaLimite}</span>}
              <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{h.descripcion}</p>
              {h.cierreObservaciones && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-success)' }}>Cerrado: {h.cierreObservaciones}</p>}
            </div>
            {h.estado === 'abierto' && (
              <button onClick={() => closeHallazgo(h.id)} className="flit-focus ml-3 inline-flex h-7 items-center rounded-[999px] px-2 text-[10px] font-semibold text-white" style={{ background: 'var(--flit-gradient-success)' }}>Cerrar</button>
            )}
            {h.estado === 'cerrado' && <div className="ml-3"><StatusChip tone="success">cerrado</StatusChip></div>}
          </div>
        </div>
      ))}

      {showH && (
        <FlitModal title="Nuevo hallazgo" onClose={() => setShowH(false)}>
          <div className="space-y-3">
            <select value={hForm.severidad} onChange={(e) => setHForm({ ...hForm, severidad: e.target.value as Severidad })} className={inputCls}>
              {SEVERIDADES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min="1" max="24" placeholder="Paso 1-24 (opt)" value={hForm.pasoPesv} onChange={(e) => setHForm({ ...hForm, pasoPesv: e.target.value })} className={inputCls} />
              <input type="date" placeholder="Fecha límite" value={hForm.fechaLimite} onChange={(e) => setHForm({ ...hForm, fechaLimite: e.target.value })} className={inputCls} />
            </div>
            <textarea placeholder="Descripción del hallazgo (≥10 chars)" value={hForm.descripcion} onChange={(e) => setHForm({ ...hForm, descripcion: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowH(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={addHallazgo}>Agregar</GradientButton>
          </div>
        </FlitModal>
      )}
    </section>
  );
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }

function EstadoPill({ v }: { v: Estado }) {
  const tone: Record<Estado, ChipTone> = { planificada: 'active', en_curso: 'warning', cerrada: 'success' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
