import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import CounterpartyForm from '../components/laft/CounterpartyForm';
import CounterpartyDetail from '../components/laft/CounterpartyDetail';
import ListsPanel from '../components/laft/ListsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

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

const inputCls = 'control';
const MIGA = [{ etiqueta: 'Cumplimiento' }];

export default function Laft() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [riskFilter, setRiskFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // Bug #11768 — el fallo del listado solo se contaba con un toast que se desvanece y la tabla
  // quedaba diciendo «Sin contrapartes registradas». En LAFT eso no es un matiz: «no hay
  // contrapartes que debida diligencia deba revisar» y «no pude leer las contrapartes» llevan a
  // decisiones opuestas. Estado de error en el cuerpo, calcado de LaftAuditPlan / LaftManual /
  // LaftOfficer, más el «Reintentar» que ya usa finanzas (ContadoresFacturacion).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      // Se descarta la página anterior: dejar contrapartes viejas con su documento bajo un cartel
      // de error es enseñar datos que ya no se sabe si siguen siendo los vigentes.
      setData(null);
      setError(errorMessage(e));
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
  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'ready';

  const columnas: ColumnaTabla<Counterparty>[] = [
    { key: 'tipo', header: 'Tipo', render: (cp) => <StatusChip tone={cp.kind === 'PJ' ? 'active' : 'neutral'}>{cp.kind}</StatusChip> },
    { key: 'documento', header: 'Documento', render: (cp) => <span className="mono text-text-primary">{cp.docType} {cp.docNumber}</span> },
    { key: 'nombre', header: 'Nombre / Razón social', render: (cp) => <span className="text-sm text-text-primary">{cp.fullName}</span> },
    { key: 'pep', header: 'PEP', render: (cp) => cp.isPep && <StatusChip tone="warning">PEP</StatusChip> },
    {
      key: 'riesgo',
      header: 'Riesgo',
      render: (cp) => {
        const r = cp.riskLevel ? RISK_LABEL[cp.riskLevel] : null;
        return r && <StatusChip tone={r.tone}>{r.label}</StatusChip>;
      },
    },
    { key: 'estado', header: 'Estado', render: (cp) => <StatusChip tone={STATUS_LABEL[cp.status].tone}>{STATUS_LABEL[cp.status].label}</StatusChip> },
    { key: 'revision', header: 'Próxima revisión', render: (cp) => <span className="text-xs text-text-tertiary">{cp.nextReviewAt ?? '—'}</span> },
    {
      key: 'acciones',
      header: 'Acciones',
      align: 'right',
      acciones: true,
      render: (cp) => (
        <div className="inline-flex flex-wrap justify-end gap-1.5">
          <GradientButton type="button" variant="secondary" size="sm" onClick={() => setDetailId(cp.id)}>Listas</GradientButton>
          {cp.status === 'pendiente' && (
            <GradientButton type="button" variant="success" size="sm" onClick={() => handleStatusChange(cp, 'vinculada')}>Vincular</GradientButton>
          )}
          {cp.status !== 'bloqueada' && cp.status !== 'archivada' && (
            <GradientButton type="button" variant="alerta" size="sm" onClick={() => handleStatusChange(cp, 'bloqueada')}>Bloquear</GradientButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Cumplimiento LAFT"
        subtitle="Prevención de lavado de activos y financiación del terrorismo"
        icono="flito-laft"
        miga={MIGA}
        actions={
          <>
            <GradientButton type="button" variant="secondary" onClick={() => setShowLists(true)}>
              Listas restrictivas
            </GradientButton>
            <GradientButton type="button" onClick={() => setShowForm(true)}>Nueva contraparte</GradientButton>
          </>
        }
      />

      <section className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
        <div className="grid grid-cols-12 items-center gap-3">
          <div className="col-span-12 md:col-span-5">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
              placeholder="Buscar por documento o nombre..."
              className={inputCls}
            />
          </div>
          <div className="col-span-12 sm:col-span-6 md:col-span-3">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }} className={inputCls}>
              <option value="">Todos los estados</option>
              <option value="pendiente">Pendiente</option>
              <option value="vinculada">Vinculada</option>
              <option value="bloqueada">Bloqueada</option>
              <option value="archivada">Archivada</option>
            </select>
          </div>
          <div className="col-span-12 sm:col-span-6 md:col-span-3">
            <select value={riskFilter} onChange={(e) => { setRiskFilter(e.target.value); setOffset(0); }} className={inputCls}>
              <option value="">Todos los riesgos</option>
              <option value="bajo">Riesgo bajo</option>
              <option value="medio">Riesgo medio</option>
              <option value="alto">Riesgo alto</option>
            </select>
          </div>
          {/* Guardado por `!error` — ver el motivo largo en LaftUnusual.tsx: «0 total» bajo el
              cartel de error es el propio defecto del Bug #11768 dicho por la cabecera. El pie de
              paginación de más abajo ya está a salvo por su `data &&`, con `setData(null)`. */}
          {!error && (
            <div className="col-span-12 text-right text-xs font-medium text-text-tertiary md:col-span-1">
              {total} total
            </div>
          )}
        </div>
      </section>

      <EstadoVista
        status={estado}
        cargando="Cargando..."
        onRetry={load}
        errorMessage={`No se pudo cargar el listado de contrapartes. ${error ?? ''}`}
        emptyMessage="Sin contrapartes registradas"
      >
        <DataTable ariaLabel="Contrapartes" columnas={columnas} filas={rows} getKey={(cp) => String(cp.id)} />
      </EstadoVista>

      {data && total > limit && (
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
          <GradientButton type="button" variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            Anterior
          </GradientButton>
          <span className="text-xs text-text-tertiary">{offset + 1}–{Math.min(offset + limit, total)} de {total}</span>
          <GradientButton type="button" variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
            Siguiente
          </GradientButton>
        </div>
      )}

      {showForm && <CounterpartyForm onClose={() => setShowForm(false)} onCreated={load} />}
      {showLists && <ListsPanel onClose={() => setShowLists(false)} />}
      {detailId !== null && <CounterpartyDetail counterpartyId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
    </div>
  );
}

