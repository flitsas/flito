import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

interface Row {
  id: number; userId: number | null; userRole: string | null; resourceTipo: string; resourceId: number | null;
  accion: string; camposAccedidos: string[]; motivo: string | null; ipOrigen: string | null;
  userAgent: string | null; requestId: string | null; accessedAt: string;
}
interface Stats {
  desde: string;
  porUsuario: Array<{ user_id: number; user_role: string; accesos: number }>;
  porRecurso: Array<{ resource_tipo: string; accion: string; accesos: number }>;
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-xs text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvLogPii() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState({ userId: '', resourceTipo: '', accion: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const limit = 100;

  const load = async () => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (filter.userId) params.set('userId', filter.userId);
    if (filter.resourceTipo) params.set('resourceTipo', filter.resourceTipo);
    if (filter.accion) params.set('accion', filter.accion);
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
    try {
      const r = await api.get<{ rows: Row[]; total: number }>('/privacy/pii-access-log?' + params.toString());
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const loadStats = async () => {
    try {
      const r = await api.get<Stats>('/privacy/pii-access-log/stats');
      setStats(r);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  useEffect(() => { load(); }, [filter, offset]);
  useEffect(() => { loadStats(); }, []);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Auditoría accesos a datos personales"
        subtitle="PESV · Ley 1581 art. 17 · Log append-only de accesos a PII conductor (multa hasta 2000 SMMLV)"
      />

      {stats && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="bg-white p-6" style={CARD}>
            <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Top usuarios (últimos 30 días)</h3>
            {stats.porUsuario.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos</p>}
            {stats.porUsuario.slice(0, 10).map((u, i) => (
              <div key={i} className="flex justify-between border-b py-2 text-xs last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <span style={{ color: 'var(--flit-text-secondary)' }}>User #{u.user_id} <span style={{ color: 'var(--flit-text-muted)' }}>({u.user_role})</span></span>
                <span className="font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{u.accesos}</span>
              </div>
            ))}
          </div>
          <div className="bg-white p-6" style={CARD}>
            <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Top recursos accedidos</h3>
            {stats.porRecurso.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos</p>}
            {stats.porRecurso.slice(0, 10).map((r, i) => (
              <div key={i} className="flex justify-between border-b py-2 text-xs last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <span style={{ color: 'var(--flit-text-secondary)' }}>{r.resource_tipo} <span style={{ color: 'var(--flit-text-muted)' }}>({r.accion})</span></span>
                <span className="font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{r.accesos}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <input placeholder="userId" value={filter.userId} onChange={(e) => setFilter({ ...filter, userId: e.target.value.replace(/\D/g, '') })} className={inputCls} />
        <input placeholder="resourceTipo" value={filter.resourceTipo} onChange={(e) => setFilter({ ...filter, resourceTipo: e.target.value })} className={inputCls} />
        <select value={filter.accion} onChange={(e) => setFilter({ ...filter, accion: e.target.value })} className={inputCls}>
          <option value="">— acción —</option>
          <option value="read">read</option>
          <option value="decrypt">decrypt</option>
          <option value="export">export</option>
          <option value="search">search</option>
        </select>
        <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className={inputCls} />
        <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className={inputCls} />
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha UTC</Th><Th>User</Th><Th>Recurso</Th><Th>Acción</Th><Th>Campos</Th><Th>IP</Th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos para los filtros</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.accessedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-primary)' }}>#{r.userId ?? '?'} <span style={{ color: 'var(--flit-text-muted)' }}>{r.userRole}</span></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.resourceTipo}{r.resourceId ? `#${r.resourceId}` : ''}</td>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider" style={{ color: 'var(--flit-text-secondary)' }}>{r.accion}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.camposAccedidos.join(', ')}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{r.ipOrigen ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Total: {total.toLocaleString()} · página {Math.floor(offset / limit) + 1} de {Math.max(1, Math.ceil(total / limit))}</span>
        <div className="flex gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium transition-colors disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>← Anterior</button>
          <button onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium transition-colors disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Siguiente →</button>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
