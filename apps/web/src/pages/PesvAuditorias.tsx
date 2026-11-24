import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp } from '../components/flit/flitPageKit';

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

const inputCls = flitInp;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];
const TEXTO_TENUE = 'text-[color:var(--color-text-tertiary)]';

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
        icono="flito-pesv"
        miga={MIGA}
        subtitle="Programa anual con hallazgos por severidad · Paso 22 · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva auditoría</GradientButton>}
      />

      <section className="card p-0">
        <DataTable<Auditoria>
          ariaLabel="Auditorías PESV"
          columnas={COLUMNAS(openDetail)}
          filas={items}
          getKey={(a) => String(a.id)}
          emptyMessage="Sin auditorías"
        />
      </section>

      {selected && <DetailPanel detail={selected} onUpdate={() => openDetail(selected.id)} onCerrar={() => cerrar(selected.id)} onClose={() => setSelected(null)} />}

      {showCreate && (
        <FlitModal title="Nueva auditoría" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input type="number" value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value) })} className={inputCls} placeholder="Año" />
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as Tipo })} className={inputCls}>
                {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <input type="date" value={form.fechaPlanificada} onChange={(e) => setForm({ ...form, fechaPlanificada: e.target.value })} className={inputCls} />
            <textarea placeholder="Alcance (≥10 chars)" value={form.alcance} onChange={(e) => setForm({ ...form, alcance: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
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
    <section className="card">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">Auditoría {detail.anio} · {detail.tipo}</h2>
          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{detail.alcance}</p>
        </div>
        <div className="flex items-center gap-2">
          {detail.estado !== 'cerrada' && (
            <GradientButton type="button" variant="success" size="sm" onClick={onCerrar}>Cerrar auditoría</GradientButton>
          )}
          <button type="button" onClick={onClose} className={`flit-focus inline-grid h-9 w-9 place-items-center rounded-full text-2xl leading-none transition-colors hover:bg-[var(--kit-hover)] hover:text-[color:var(--color-action)] ${TEXTO_TENUE}`} aria-label="Cerrar">×</button>
        </div>
      </div>

      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[color:var(--color-text-secondary)]">Hallazgos ({detail.hallazgos.length})</h3>
        {detail.estado !== 'cerrada' && (
          <GradientButton type="button" size="sm" onClick={() => setShowH(true)}>Agregar hallazgo</GradientButton>
        )}
      </div>
      {detail.hallazgos.length === 0 && <p className={`text-xs ${TEXTO_TENUE}`}>Sin hallazgos registrados</p>}
      {detail.hallazgos.map((h) => (
        <div key={h.id} className="mb-2 rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <StatusChip tone={SEV_TONE[h.severidad]}>{h.severidad.replace(/_/g, ' ')}</StatusChip>
              {h.pasoPesv && <span className={`ml-2 text-[11px] ${TEXTO_TENUE}`}>Paso {h.pasoPesv}</span>}
              {h.fechaLimite && <span className={`ml-2 text-[11px] ${TEXTO_TENUE}`}>Límite {h.fechaLimite}</span>}
              <p className="mt-2 text-sm text-[color:var(--color-text-primary)]">{h.descripcion}</p>
              {h.cierreObservaciones && <p className="mt-1 text-[11px] text-[color:var(--kit-verde-texto)]">Cerrado: {h.cierreObservaciones}</p>}
            </div>
            {h.estado === 'abierto' && (
              <GradientButton type="button" variant="success" size="sm" onClick={() => closeHallazgo(h.id)}>Cerrar</GradientButton>
            )}
            {h.estado === 'cerrado' && <div><StatusChip tone="success">cerrado</StatusChip></div>}
          </div>
        </div>
      ))}

      {showH && (
        <FlitModal title="Nuevo hallazgo" onClose={() => setShowH(false)}>
          <div className="space-y-3">
            <select value={hForm.severidad} onChange={(e) => setHForm({ ...hForm, severidad: e.target.value as Severidad })} className={inputCls}>
              {SEVERIDADES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input type="number" min="1" max="24" placeholder="Paso 1-24 (opt)" value={hForm.pasoPesv} onChange={(e) => setHForm({ ...hForm, pasoPesv: e.target.value })} className={inputCls} />
              <input type="date" placeholder="Fecha límite" value={hForm.fechaLimite} onChange={(e) => setHForm({ ...hForm, fechaLimite: e.target.value })} className={inputCls} />
            </div>
            <textarea placeholder="Descripción del hallazgo (≥10 chars)" value={hForm.descripcion} onChange={(e) => setHForm({ ...hForm, descripcion: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowH(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={addHallazgo}>Agregar</GradientButton>
          </div>
        </FlitModal>
      )}
    </section>
  );
}

function COLUMNAS(onVer: (id: number) => void): ColumnaTabla<Auditoria>[] {
  return [
    { key: 'anio', header: 'Año', render: (a) => <span className="font-mono text-sm text-[color:var(--color-text-primary)]">{a.anio}</span> },
    { key: 'tipo', header: 'Tipo', render: (a) => <span className="text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">{a.tipo}</span> },
    { key: 'alcance', header: 'Alcance', render: (a) => <span className="block max-w-md truncate text-xs text-[color:var(--color-text-secondary)]" title={a.alcance}>{a.alcance}</span> },
    { key: 'planificada', header: 'Planificada', render: (a) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{a.fechaPlanificada}</span> },
    { key: 'estado', header: 'Estado', render: (a) => <EstadoPill v={a.estado} /> },
    { key: 'accion', header: 'Acción', acciones: true, render: (a) => <GradientButton type="button" variant="secondary" size="sm" onClick={() => onVer(a.id)}>Ver</GradientButton> },
  ];
}

function EstadoPill({ v }: { v: Estado }) {
  const tone: Record<Estado, ChipTone> = { planificada: 'active', en_curso: 'warning', cerrada: 'success' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
