import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import CounterpartyForm from '../components/laft/CounterpartyForm';
import CounterpartyDetail from '../components/laft/CounterpartyDetail';
import ListsPanel from '../components/laft/ListsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface Counterparty {
  id: number;
  kind: 'PN' | 'PJ';
  docType: string;
  docNumber: string;
  fullName: string;
  email: string | null;
  city: string | null;
  country: string;
  isPep: boolean;
  riskLevel: 'bajo' | 'medio' | 'alto' | null;
  status: 'pendiente' | 'vinculada' | 'bloqueada' | 'archivada';
  nextReviewAt: string | null;
  version: number;
  createdAt: string;
}

interface ListResponse {
  rows: Counterparty[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_LABEL: Record<Counterparty['status'], { label: string; tone: ChipTone }> = {
  pendiente: { label: 'Pendiente', tone: 'neutral' },
  vinculada: { label: 'Vinculada', tone: 'success' },
  bloqueada: { label: 'Bloqueada', tone: 'danger' },
  archivada: { label: 'Archivada', tone: 'neutral' },
};

const RISK_LABEL: Record<NonNullable<Counterparty['riskLevel']>, { label: string; tone: ChipTone }> = {
  bajo: { label: 'Bajo', tone: 'success' },
  medio: { label: 'Medio', tone: 'warning' },
  alto: { label: 'Alto', tone: 'danger' },
};

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function Laft() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [riskFilter, setRiskFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (statusFilter) params.set('status', statusFilter);
      if (riskFilter) params.set('risk', riskFilter);
      if (search.trim()) params.set('search', search.trim());
      const res = await api.get<ListResponse>(`/laft/counterparties?${params}`);
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error cargando');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, riskFilter, search, offset]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (cp: Counterparty, newStatus: Counterparty['status']) => {
    let reason: string | undefined;
    if (newStatus === 'bloqueada') {
      reason = window.prompt('Motivo del bloqueo (obligatorio):') ?? undefined;
      if (!reason) return;
    }
    try {
      await api.post(`/laft/counterparties/${cp.id}/status`, { status: newStatus, reason, version: cp.version });
      toast.success('Estado actualizado');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error actualizando');
    }
  };

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Cumplimiento LAFT"
        subtitle="Prevención de lavado de activos y financiación del terrorismo"
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowLists(true)}
              className="flit-focus inline-flex h-11 items-center gap-2 rounded-[999px] border bg-white px-4 text-sm font-medium"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            >
              Listas restrictivas
            </button>
            <GradientButton type="button" onClick={() => setShowForm(true)}>Nueva contraparte</GradientButton>
          </>
        }
      />

      <section className="bg-white p-4" style={CARD}>
        <div className="grid grid-cols-12 items-center gap-3">
          <div className="col-span-12 md:col-span-5">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
              placeholder="Buscar por documento o nombre..."
              className={inputCls}
            />
          </div>
          <div className="col-span-6 md:col-span-3">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }} className={inputCls}>
              <option value="">Todos los estados</option>
              <option value="pendiente">Pendiente</option>
              <option value="vinculada">Vinculada</option>
              <option value="bloqueada">Bloqueada</option>
              <option value="archivada">Archivada</option>
            </select>
          </div>
          <div className="col-span-6 md:col-span-3">
            <select value={riskFilter} onChange={(e) => { setRiskFilter(e.target.value); setOffset(0); }} className={inputCls}>
              <option value="">Todos los riesgos</option>
              <option value="bajo">Riesgo bajo</option>
              <option value="medio">Riesgo medio</option>
              <option value="alto">Riesgo alto</option>
            </select>
          </div>
          <div className="col-span-12 text-right text-xs font-medium md:col-span-1" style={{ color: 'var(--flit-text-muted)' }}>
            {total} total
          </div>
        </div>
      </section>

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Tipo</Th><Th>Documento</Th><Th>Nombre / Razón social</Th><Th>PEP</Th><Th>Riesgo</Th><Th>Estado</Th><Th>Próxima revisión</Th><Th className="text-right">Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={8} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin contrapartes registradas</td></tr>
              )}
              {!loading && rows.map((cp) => {
                const s = STATUS_LABEL[cp.status];
                const r = cp.riskLevel ? RISK_LABEL[cp.riskLevel] : null;
                return (
                  <tr key={cp.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3"><StatusChip tone={cp.kind === 'PJ' ? 'active' : 'neutral'}>{cp.kind}</StatusChip></td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>{cp.docType} {cp.docNumber}</td>
                    <td className="px-4 py-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{cp.fullName}</td>
                    <td className="px-4 py-3">{cp.isPep && <StatusChip tone="warning">PEP</StatusChip>}</td>
                    <td className="px-4 py-3">{r && <StatusChip tone={r.tone}>{r.label}</StatusChip>}</td>
                    <td className="px-4 py-3"><StatusChip tone={s.tone}>{s.label}</StatusChip></td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{cp.nextReviewAt ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setDetailId(cp.id)}
                        className="flit-focus mr-1 inline-flex h-7 items-center rounded-[999px] px-2.5 text-xs font-semibold"
                        style={{ background: 'rgba(79,116,201,0.14)', color: 'var(--flit-blue)' }}
                      >
                        Listas
                      </button>
                      {cp.status === 'pendiente' && (
                        <button
                          type="button"
                          onClick={() => handleStatusChange(cp, 'vinculada')}
                          className="flit-focus mr-1 inline-flex h-7 items-center rounded-[999px] px-2.5 text-xs font-semibold"
                          style={{ background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success)' }}
                        >
                          Vincular
                        </button>
                      )}
                      {cp.status !== 'bloqueada' && cp.status !== 'archivada' && (
                        <button
                          type="button"
                          onClick={() => handleStatusChange(cp, 'bloqueada')}
                          className="flit-focus inline-flex h-7 items-center rounded-[999px] px-2.5 text-xs font-semibold"
                          style={{ background: 'rgba(228,61,48,0.14)', color: 'var(--flit-danger)' }}
                        >
                          Bloquear
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {data && total > limit && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-sm font-medium transition-colors disabled:opacity-30"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Anterior
          </button>
          <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{offset + 1}–{Math.min(offset + limit, total)} de {total}</span>
          <button
            type="button"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
            className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-sm font-medium transition-colors disabled:opacity-30"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Siguiente
          </button>
        </div>
      )}

      {showForm && <CounterpartyForm onClose={() => setShowForm(false)} onCreated={load} />}
      {showLists && <ListsPanel onClose={() => setShowLists(false)} />}
      {detailId !== null && <CounterpartyDetail counterpartyId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}

function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide ${className}`} style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
