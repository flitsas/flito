import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

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
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

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
        title="Retención documental"
        subtitle="Políticas y bitácora de cumplimiento · Paso 19 · Ley 594/2000"
        actions={tab === 'politicas' ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva política</GradientButton> : undefined}
      />

      <div className="inline-flex w-fit gap-1 rounded-[999px] p-1" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
        <TabBtn active={tab === 'politicas'} onClick={() => setTab('politicas')}>Políticas</TabBtn>
        <TabBtn active={tab === 'log'} onClick={() => setTab('log')}>Bitácora</TabBtn>
      </div>

      {tab === 'politicas' && (
        <div className="overflow-hidden bg-white" style={CARD}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <Th>Tipo</Th><Th>Años</Th><Th>Base legal</Th><Th>Acción</Th><Th>Hab.</Th><Th>—</Th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
                {!loading && politicas.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin políticas</td></tr>}
                {politicas.map((p) => (
                  <tr key={p.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.tipoDocumento}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.retencionAnios}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.baseLegal}</td>
                    <td className="px-4 py-3"><AccionPill v={p.accion} /></td>
                    <td className="px-4 py-3 text-xs">{p.habilitado ? <span style={{ color: 'var(--flit-success)' }}>●</span> : <span style={{ color: 'var(--flit-text-muted)' }}>○</span>}</td>
                    <td className="px-4 py-3"><button onClick={() => dryRun(p)} className="flit-focus text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>DRY-RUN</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="overflow-hidden bg-white" style={CARD}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <Th>Fecha</Th><Th>Tipo</Th><Th>Cutoff</Th><Th>Acción</Th><Th>Cant.</Th><Th>Origen</Th><Th>Detalle</Th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
                {!loading && log.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin entradas en bitácora</td></tr>}
                {log.map((l) => (
                  <tr key={l.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{l.ejecutadoAt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>{l.tipoDocumento}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{l.cutoffDate}</td>
                    <td className="px-4 py-3"><AccionPill v={l.accion} /></td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{l.cantidadAfectada}</td>
                    <td className="px-4 py-3 text-xs">{l.ejecutadoPorCron ? <span style={{ color: 'var(--flit-blue)' }}>cron</span> : <span style={{ color: 'var(--flit-warning)' }}>manual</span>}</td>
                    <td className="max-w-xs truncate px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{l.detalleMd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && (
        <FlitModal title="Nueva política de retención" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <input placeholder="Tipo de documento (snake_case)" value={form.tipoDocumento} onChange={(e) => setForm({ ...form, tipoDocumento: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min={1} max={100} placeholder="Años" value={form.retencionAnios} onChange={(e) => setForm({ ...form, retencionAnios: parseInt(e.target.value, 10) || 0 })} className={inputCls} />
              <select value={form.accion} onChange={(e) => setForm({ ...form, accion: e.target.value as Accion })} className={inputCls}>
                {ACCIONES.map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
              </select>
            </div>
            <input placeholder="Base legal (ej: Ley 594/2000)" value={form.baseLegal} onChange={(e) => setForm({ ...form, baseLegal: e.target.value })} className={inputCls} />
            <textarea placeholder="Notas markdown (opcional)" value={form.notasMd} onChange={(e) => setForm({ ...form, notasMd: e.target.value })} rows={3} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Registrar</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }
function TabBtn({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-sm font-semibold transition-colors" style={active ? { background: '#fff', color: 'var(--flit-blue)', boxShadow: 'var(--flit-shadow-card)' } : { color: 'var(--flit-text-muted)' }}>{children}</button>;
}
function AccionPill({ v }: { v: Accion }) {
  const tone: Record<Accion, ChipTone> = { purgar: 'danger', archivar_offline: 'active', anonimizar: 'warning' };
  return <StatusChip tone={tone[v]}>{v.replace('_', ' ')}</StatusChip>;
}
