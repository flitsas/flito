import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import KpiCard from '../components/flit/KpiCard';
import { flitInp } from '../components/flit/flitPageKit';

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
const inputCls = flitInp;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];
const TENUE = 'text-[color:var(--color-text-tertiary)]';
const TREINTA_DIAS = 30 * 24 * 60 * 60 * 1000;

const COLUMNAS: ColumnaTabla<Norm>[] = [
  { key: 'codigo', header: 'Código', render: (n) => <span className="font-mono text-xs font-semibold text-[color:var(--color-text-primary)]">{n.codigo}</span> },
  { key: 'tipo', header: 'Tipo', render: (n) => <StatusChip tone="active">{n.tipo.replace('_', ' ')}</StatusChip> },
  { key: 'titulo', header: 'Título', render: (n) => <span className="block max-w-md truncate text-sm text-[color:var(--color-text-primary)]">{n.titulo}</span> },
  { key: 'emisor', header: 'Emisor', render: (n) => <span className="text-xs text-[color:var(--color-text-secondary)]">{n.emisor}</span> },
  {
    key: 'prox', header: 'Próxima rev.', render: (n) => {
      const prox = new Date(n.proximaRevisionAt).getTime() <= Date.now() + TREINTA_DIAS;
      return <span className={`font-mono text-xs ${prox ? 'font-semibold text-[color:var(--kit-naranja-texto)]' : 'text-[color:var(--color-text-secondary)]'}`}>{n.proximaRevisionAt.slice(0, 10)}</span>;
    },
  },
  { key: 'vigente', header: 'Vigente', render: (n) => (n.vigente ? <span className="text-xs text-[color:var(--kit-verde-texto)]">●</span> : <span className={`text-xs ${TENUE}`}>○</span>) },
];

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
        icono="flito-pesv"
        miga={MIGA}
        subtitle="Seguimiento de regulaciones aplicables · Paso 1.7 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva norma</GradientButton>}
      />

      {proximas > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <KpiCard label="Próximas a revisar (≤30 días)" value={proximas} pendiente />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)} className={`${inputCls} h-10 w-full sm:w-auto sm:min-w-[200px]`}>
          <option value="">Todos los tipos</option>
          {TIPOS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </select>
      </div>

      <section className="card p-0">
        <DataTable<Norm>
          ariaLabel="Tracker normativo"
          columnas={COLUMNAS}
          filas={items}
          getKey={(n) => String(n.id)}
          status={loading ? 'loading' : undefined}
          emptyMessage="Sin normativa registrada"
          onFilaClick={openDetalle}
        />
      </section>

      {showCreate && (
        <FlitModal title="Nueva normativa" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input placeholder="Código (ej. RES-40595-2022)" value={form.codigo} onChange={(e) => setForm({ ...form, codigo: e.target.value })} className={inputCls} />
              <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as Tipo })} className={inputCls}>
                {TIPOS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
            <input placeholder="Título" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className={inputCls} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input placeholder="Emisor" value={form.emisor} onChange={(e) => setForm({ ...form, emisor: e.target.value })} className={inputCls} />
              <input type="date" value={form.fechaPublicacion} onChange={(e) => setForm({ ...form, fechaPublicacion: e.target.value })} className={inputCls} />
            </div>
            <input placeholder="URL oficial" value={form.urlOficial} onChange={(e) => setForm({ ...form, urlOficial: e.target.value })} className={inputCls} />
            <input placeholder="Aplica a (csv: pesv,jornadas,rutas)" value={form.aplicaA} onChange={(e) => setForm({ ...form, aplicaA: e.target.value })} className={inputCls} />
            <input type="date" placeholder="Próxima revisión" value={form.proximaRevisionAt} onChange={(e) => setForm({ ...form, proximaRevisionAt: e.target.value })} className={inputCls} />
            <textarea placeholder="Resumen markdown" value={form.resumenMd} onChange={(e) => setForm({ ...form, resumenMd: e.target.value })} rows={4} className={inputCls} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={create}>Registrar</GradientButton>
          </div>
        </FlitModal>
      )}

      {detalle && (
        <FlitModal title={detalle.norm.codigo} onClose={() => setDetalle(null)}>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-[color:var(--color-text-secondary)]">{detalle.norm.titulo}</p>
              <p className={`mt-1 text-xs ${TENUE}`}>{detalle.norm.emisor} · {detalle.norm.fechaPublicacion?.slice(0, 10)}</p>
            </div>
            <GradientButton type="button" variant="success" size="sm" onClick={() => revisar(detalle.norm)} aria-label="Marcar normativa como revisada">Marcar como revisada</GradientButton>
          </div>
          {detalle.norm.urlOficial && <a href={detalle.norm.urlOficial} target="_blank" rel="noreferrer" className="flit-focus rounded-sm text-xs text-[color:var(--color-action)] underline transition-colors hover:no-underline">Ver fuente oficial</a>}
          {detalle.norm.resumenMd && <pre className="mt-3 whitespace-pre-wrap rounded-[9px] bg-[var(--color-surface)] p-3 font-sans text-xs text-[color:var(--color-text-secondary)]">{detalle.norm.resumenMd}</pre>}
          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">Historial de revisiones</h4>
          {detalle.revisiones.length === 0 && <p className={`text-xs ${TENUE}`}>Sin revisiones aún.</p>}
          {detalle.revisiones.map((r) => (
            <div key={r.id} className="mb-2 border-l-2 border-[color:var(--kit-azul)] py-2 pl-3">
              <p className="font-mono text-xs text-[color:var(--color-text-secondary)]">{r.revisadaAt.slice(0, 10)} → próxima {r.proximaRevisionAt.slice(0, 10)}</p>
              {r.cambiosObservados && <p className="mt-1 text-xs text-[color:var(--color-text-primary)]">{r.cambiosObservados}</p>}
            </div>
          ))}
        </FlitModal>
      )}
    </div>
  );
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
