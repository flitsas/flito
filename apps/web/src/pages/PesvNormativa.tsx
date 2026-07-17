import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

type Tipo = 'ley' | 'decreto' | 'resolucion' | 'concepto' | 'circular' | 'norma_tecnica';
interface Norm {
  id: number; codigo: string; tipo: Tipo; titulo: string; emisor: string;
  fechaPublicacion: string; vigente: boolean; aplicaA: string[]; urlOficial: string | null;
  resumenMd: string | null; ultimaRevisionAt: string | null;
  proximaRevisionAt: string; notasMd: string | null; optimisticV: number;
}
interface Revision { id: number; revisadaAt: string; cambiosObservados: string | null; proximaRevisionAt: string; }

interface NormBody {
  codigo: string; tipo: Tipo; titulo: string; emisor: string;
  fechaPublicacion: string; aplicaA: string[]; proximaRevisionAt: string;
  urlOficial?: string; resumenMd?: string;
}

const TIPOS: Tipo[] = ['ley', 'decreto', 'resolucion', 'concepto', 'circular', 'norma_tecnica'];
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const cancelBtn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium';

export default function PesvNormativa() {
  const [items, setItems] = useState<Norm[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroTipo, setFiltroTipo] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [detalle, setDetalle] = useState<{ norm: Norm; revisiones: Revision[] } | null>(null);
  const [form, setForm] = useState({
    codigo: '', tipo: 'resolucion' as Tipo, titulo: '', emisor: '', fechaPublicacion: '',
    aplicaA: '' as string, urlOficial: '', resumenMd: '', proximaRevisionAt: '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const q = filtroTipo ? `?tipo=${filtroTipo}` : '';
      const r = await api.get<{ data: Norm[] }>(`/pesv/normativa${q}`);
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filtroTipo]);

  const proximas = useMemo(() => {
    const lim = Date.now() + 30 * 24 * 60 * 60 * 1000;
    return items.filter((n) => new Date(n.proximaRevisionAt).getTime() <= lim).length;
  }, [items]);

  const create = async () => {
    if (form.codigo.length < 3 || form.titulo.length < 5 || !form.fechaPublicacion || !form.proximaRevisionAt) {
      toast.error('Código, título, fechas obligatorios'); return;
    }
    try {
      const aplicaA = form.aplicaA.split(',').map((s) => s.trim()).filter(Boolean);
      const body: NormBody = {
        codigo: form.codigo, tipo: form.tipo, titulo: form.titulo, emisor: form.emisor,
        fechaPublicacion: form.fechaPublicacion, aplicaA,
        proximaRevisionAt: form.proximaRevisionAt,
      };
      if (form.urlOficial) body.urlOficial = form.urlOficial;
      if (form.resumenMd) body.resumenMd = form.resumenMd;
      await api.post('/pesv/normativa', body);
      toast.success('Normativa registrada');
      setShowCreate(false);
      setForm({ codigo: '', tipo: 'resolucion', titulo: '', emisor: '', fechaPublicacion: '', aplicaA: '', urlOficial: '', resumenMd: '', proximaRevisionAt: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const openDetalle = async (n: Norm) => {
    try {
      const r = await api.get<Norm & { revisiones: Revision[] }>(`/pesv/normativa/${n.id}`);
      setDetalle({ norm: r, revisiones: r.revisiones || [] });
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const revisar = async (norm: Norm) => {
    const proxima = window.prompt('Próxima fecha de revisión (YYYY-MM-DD):', addDays(today(), 365));
    if (!proxima || !/^\d{4}-\d{2}-\d{2}$/.test(proxima)) return;
    const cambios = window.prompt('¿Qué cambió en esta revisión? (opcional)') ?? '';
    try {
      await api.post(`/pesv/normativa/${norm.id}/revisar`, { proximaRevisionAt: proxima, cambiosObservados: cambios });
      toast.success('Revisión registrada');
      setDetalle(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Tracker normativo"
        subtitle="Seguimiento de regulaciones aplicables · Paso 1.7 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva norma</GradientButton>}
      />

      {proximas > 0 && (
        <div className="rounded-[18px] p-5" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.20)' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-warning)' }}>Próximas a revisar (≤30 días)</p>
          <div className="mt-1 text-3xl font-bold" style={{ color: 'var(--flit-warning)' }}>{proximas}</div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)} className={`${inputCls} w-auto min-w-[200px]`}>
          <option value="">Todos los tipos</option>
          {TIPOS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </select>
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Código</Th><Th>Tipo</Th><Th>Título</Th><Th>Emisor</Th><Th>Próxima rev.</Th><Th>Vigente</Th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin normativa registrada</td></tr>}
              {items.map((n) => {
                const prox = new Date(n.proximaRevisionAt).getTime() <= Date.now() + 30 * 24 * 60 * 60 * 1000;
                return (
                  <tr key={n.id} className="cursor-pointer border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }} onClick={() => openDetalle(n)}>
                    <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{n.codigo}</td>
                    <td className="px-4 py-3"><StatusChip tone="active">{n.tipo.replace('_', ' ')}</StatusChip></td>
                    <td className="max-w-md truncate px-4 py-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{n.titulo}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{n.emisor}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: prox ? 'var(--flit-warning)' : 'var(--flit-text-secondary)', fontWeight: prox ? 600 : 400 }}>{n.proximaRevisionAt.slice(0, 10)}</td>
                    <td className="px-4 py-3 text-xs">{n.vigente ? <span style={{ color: 'var(--flit-success)' }}>●</span> : <span style={{ color: 'var(--flit-text-muted)' }}>○</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <FlitModal title="Nueva normativa" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Código (ej. RES-40595-2022)" value={form.codigo} onChange={(e) => setForm({ ...form, codigo: e.target.value })} className={inputCls} />
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as Tipo })} className={inputCls}>
                {TIPOS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
            <input placeholder="Título" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Emisor" value={form.emisor} onChange={(e) => setForm({ ...form, emisor: e.target.value })} className={inputCls} />
              <input type="date" value={form.fechaPublicacion} onChange={(e) => setForm({ ...form, fechaPublicacion: e.target.value })} className={inputCls} />
            </div>
            <input placeholder="URL oficial" value={form.urlOficial} onChange={(e) => setForm({ ...form, urlOficial: e.target.value })} className={inputCls} />
            <input placeholder="Aplica a (csv: pesv,jornadas,rutas)" value={form.aplicaA} onChange={(e) => setForm({ ...form, aplicaA: e.target.value })} className={inputCls} />
            <input type="date" placeholder="Próxima revisión" value={form.proximaRevisionAt} onChange={(e) => setForm({ ...form, proximaRevisionAt: e.target.value })} className={inputCls} />
            <textarea placeholder="Resumen markdown" value={form.resumenMd} onChange={(e) => setForm({ ...form, resumenMd: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Registrar</GradientButton>
          </div>
        </FlitModal>
      )}

      {detalle && (
        <FlitModal title={detalle.norm.codigo} onClose={() => setDetalle(null)}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{detalle.norm.titulo}</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{detalle.norm.emisor} · {detalle.norm.fechaPublicacion?.slice(0, 10)}</p>
            </div>
            <button onClick={() => revisar(detalle.norm)} aria-label="Marcar normativa como revisada" className="flit-focus inline-flex h-9 shrink-0 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-success)' }}>Marcar como revisada</button>
          </div>
          {detalle.norm.urlOficial && <a href={detalle.norm.urlOficial} target="_blank" rel="noreferrer" className="text-xs underline" style={{ color: 'var(--flit-blue)' }}>Ver fuente oficial</a>}
          {detalle.norm.resumenMd && <pre className="mt-3 whitespace-pre-wrap rounded-[10px] p-3 font-sans text-xs" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>{detalle.norm.resumenMd}</pre>}
          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-text-secondary)' }}>Historial de revisiones</h4>
          {detalle.revisiones.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin revisiones aún.</p>}
          {detalle.revisiones.map((r) => (
            <div key={r.id} className="mb-2 border-l-2 py-2 pl-3" style={{ borderColor: 'var(--flit-blue)' }}>
              <p className="font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.revisadaAt.slice(0, 10)} → próxima {r.proximaRevisionAt.slice(0, 10)}</p>
              {r.cambiosObservados && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{r.cambiosObservados}</p>}
            </div>
          ))}
        </FlitModal>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }
function today(): string { return new Date().toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
