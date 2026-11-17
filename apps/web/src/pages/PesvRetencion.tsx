import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import Pestanas from '../components/flit/Pestanas';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp } from '../components/flit/flitPageKit';

type Accion = 'purgar' | 'archivar_offline' | 'anonimizar';
interface Politica {
  id: number; tipoDocumento: string; retencionAnios: number; baseLegal: string;
  accion: Accion; habilitado: boolean; notasMd: string | null; optimisticV: number;
}
interface LogEntry {
  id: number; politicaId: number | null; tipoDocumento: string; cantidadAfectada: number;
  cutoffDate: string; accion: Accion; ejecutadoAt: string; ejecutadoPorCron: boolean; detalleMd: string | null;
}

interface PoliticaBody {
  tipoDocumento: string; retencionAnios: number; baseLegal: string; accion: Accion; notasMd?: string;
}

const ACCIONES: Accion[] = ['purgar', 'archivar_offline', 'anonimizar'];
const inputCls = flitInp;

export default function PesvRetencion() {
  const [tab, setTab] = useState<'politicas' | 'log'>('politicas');
  const [politicas, setPoliticas] = useState<Politica[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    tipoDocumento: '', retencionAnios: 5, baseLegal: '', accion: 'archivar_offline' as Accion, notasMd: '',
  });

  const load = async () => {
    setLoading(true);
    try {
      if (tab === 'politicas') {
        const r = await api.get<{ data: Politica[] }>('/pesv/retencion/politicas');
        setPoliticas(r.data);
      } else {
        const r = await api.get<{ data: LogEntry[] }>('/pesv/retencion/log?limit=100');
        setLog(r.data);
      }
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tab]);

  const create = async () => {
    if (!/^[a-z0-9_]{2,60}$/.test(form.tipoDocumento) || form.baseLegal.length < 5) {
      toast.error('Tipo en snake_case y base legal ≥5 chars'); return;
    }
    try {
      const body: PoliticaBody = {
        tipoDocumento: form.tipoDocumento, retencionAnios: form.retencionAnios,
        baseLegal: form.baseLegal, accion: form.accion,
      };
      if (form.notasMd) body.notasMd = form.notasMd;
      await api.post('/pesv/retencion/politicas', body);
      toast.success('Política registrada');
      setShowCreate(false);
      setForm({ tipoDocumento: '', retencionAnios: 5, baseLegal: '', accion: 'archivar_offline', notasMd: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const dryRun = async (p: Politica) => {
    if (!window.confirm(`Ejecutar DRY-RUN para "${p.tipoDocumento}"? No tocará datos.`)) return;
    try {
      const r = await api.post<{ ok: boolean; cutoffDate: string; modo: string }>('/pesv/retencion/run', {
        tipoDocumento: p.tipoDocumento, confirm: false,
      });
      toast.success(`DRY-RUN registrado · cutoff ${r.cutoffDate}`);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        icono="flito-pesv"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }]}
        title="Retención documental"
        subtitle="Políticas y bitácora de cumplimiento · Paso 19 · Ley 594/2000"
        actions={tab === 'politicas' ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva política</GradientButton> : undefined}
      />

      <Pestanas
        etiqueta="Vistas de retención documental"
        pestanas={[{ id: 'politicas', etiqueta: 'Políticas' }, { id: 'log', etiqueta: 'Bitácora' }]}
        activa={tab}
        onElegir={(id) => setTab(id as 'politicas' | 'log')}
      />

      {tab === 'politicas' && (
        <DataTable
          ariaLabel="Políticas de retención"
          columnas={columnasPoliticas(dryRun)}
          filas={politicas}
          getKey={(p) => String(p.id)}
          status={loading ? 'loading' : politicas.length === 0 ? 'empty' : 'ready'}
          emptyMessage="Sin políticas"
        />
      )}

      {tab === 'log' && (
        <DataTable
          ariaLabel="Bitácora de retención"
          columnas={COLUMNAS_LOG}
          filas={log}
          getKey={(l) => String(l.id)}
          status={loading ? 'loading' : log.length === 0 ? 'empty' : 'ready'}
          emptyMessage="Sin entradas en bitácora"
        />
      )}

      {showCreate && (
        <FlitModal title="Nueva política de retención" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Tipo de documento (snake_case)" value={form.tipoDocumento} onChange={(e) => setForm({ ...form, tipoDocumento: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input type="number" min={1} max={100} placeholder="Años" value={form.retencionAnios} onChange={(e) => setForm({ ...form, retencionAnios: parseInt(e.target.value, 10) || 0 })} className={inputCls} />
              <select value={form.accion} onChange={(e) => setForm({ ...form, accion: e.target.value as Accion })} className={inputCls}>
                {ACCIONES.map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
              </select>
            </div>
            <input placeholder="Base legal (ej: Ley 594/2000)" value={form.baseLegal} onChange={(e) => setForm({ ...form, baseLegal: e.target.value })} className={inputCls} />
            <textarea placeholder="Notas markdown (opcional)" value={form.notasMd} onChange={(e) => setForm({ ...form, notasMd: e.target.value })} rows={3} className={inputCls} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={create}>Registrar</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function columnasPoliticas(dryRun: (p: Politica) => void): ColumnaTabla<Politica>[] {
  return [
    { key: 'tipo', header: 'Tipo', render: (p) => <span className="font-mono text-xs font-semibold text-[color:var(--color-text-primary)]">{p.tipoDocumento}</span> },
    { key: 'anios', header: 'Años', render: (p) => <span className="text-xs text-[color:var(--color-text-secondary)]">{p.retencionAnios}</span> },
    { key: 'base', header: 'Base legal', render: (p) => <span className="text-xs text-[color:var(--color-text-secondary)]">{p.baseLegal}</span> },
    { key: 'accion', header: 'Acción', render: (p) => <AccionPill v={p.accion} /> },
    {
      key: 'hab', header: 'Hab.',
      render: (p) => (p.habilitado
        ? <span className="text-xs text-[color:var(--kit-verde-texto)]">●</span>
        : <span className="text-xs text-[color:var(--color-text-tertiary)]">○</span>),
    },
    { key: 'dry', header: '—', acciones: true, render: (p) => <GradientButton type="button" variant="ghost" size="sm" onClick={() => dryRun(p)}>DRY-RUN</GradientButton> },
  ];
}

const COLUMNAS_LOG: ColumnaTabla<LogEntry>[] = [
  { key: 'fecha', header: 'Fecha', render: (l) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{l.ejecutadoAt.slice(0, 16).replace('T', ' ')}</span> },
  { key: 'tipo', header: 'Tipo', render: (l) => <span className="font-mono text-xs text-[color:var(--color-text-primary)]">{l.tipoDocumento}</span> },
  { key: 'cutoff', header: 'Cutoff', render: (l) => <span className="text-xs text-[color:var(--color-text-secondary)]">{l.cutoffDate}</span> },
  { key: 'accion', header: 'Acción', render: (l) => <AccionPill v={l.accion} /> },
  { key: 'cant', header: 'Cant.', render: (l) => <span className="text-xs text-[color:var(--color-text-primary)]">{l.cantidadAfectada}</span> },
  {
    key: 'origen', header: 'Origen',
    render: (l) => (l.ejecutadoPorCron
      ? <span className="text-xs text-[color:var(--color-action)]">cron</span>
      : <span className="text-xs text-[color:var(--kit-naranja-texto)]">manual</span>),
  },
  { key: 'detalle', header: 'Detalle', render: (l) => <span className="block max-w-xs truncate text-xs text-[color:var(--color-text-secondary)]">{l.detalleMd}</span> },
];

function AccionPill({ v }: { v: Accion }) {
  const tone: Record<Accion, ChipTone> = { purgar: 'danger', archivar_offline: 'active', anonimizar: 'warning' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
