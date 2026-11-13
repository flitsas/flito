import { useEffect, useState, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

// MVP read-only (USR-5): Planes de auditoría LAFT. Conectado a
// GET /api/laft/audit-plan (laft_audit_plan). Crear/editar/cerrar es
// admin|compliance (fuera de este MVP).
interface AuditPlan {
  id: number;
  anio: number;
  tipo: string;
  estado: string;
  titulo?: string | null;
}

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral',
  aprobado: 'active',
  en_ejecucion: 'warning',
  cerrado: 'success',
};

const COLUMNAS: ColumnaTabla<AuditPlan>[] = [
  { key: 'anio', header: 'Año', render: (p) => <span className="font-semibold tabular-nums text-text-primary">{p.anio}</span> },
  { key: 'tipo', header: 'Tipo', render: (p) => <span className="text-xs capitalize text-text-secondary">{p.tipo}</span> },
  { key: 'titulo', header: 'Título', render: (p) => <span className="text-text-primary">{p.titulo || '—'}</span> },
  {
    key: 'estado',
    header: 'Estado',
    render: (p) => <StatusChip tone={ESTADO_TONE[p.estado] ?? 'neutral'}>{(p.estado || '—').replace(/_/g, ' ')}</StatusChip>,
  },
];

const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

export default function LaftAuditPlan() {
  const [data, setData] = useState<AuditPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<{ data: AuditPlan[] }>('/laft/audit-plan');
      setData(res.data ?? []);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : data.length === 0 ? 'empty' : 'ready';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Plan de auditorías"
        subtitle="Planes anuales de auditoría del SARLAFT (interna / externa) y su estado de ejecución"
        icono="flito-laft"
        miga={MIGA}
      />

      {/* Cargando/error/vacío con EstadoVista (no los de DataTable) para conservar el texto «Cargando...». */}
      <EstadoVista status={estado} cargando="Cargando..." onRetry={load} errorMessage={error ?? undefined} emptyMessage="Sin planes de auditoría registrados">
        <DataTable ariaLabel="Planes de auditoría" columnas={COLUMNAS} filas={data} getKey={(p) => String(p.id)} />
      </EstadoVista>
    </div>
  );
}
