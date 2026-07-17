import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

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

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Plan de auditorías"
        subtitle="Planes anuales de auditoría del SARLAFT (interna / externa) y su estado de ejecución"
      />

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>{['Año', 'Tipo', 'Título', 'Estado'].map((h) => <Th key={h}>{h}</Th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && error && <tr><td colSpan={4} className="py-12 text-center text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</td></tr>}
              {!loading && !error && data.length === 0 && <tr><td colSpan={4} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin planes de auditoría registrados</td></tr>}
              {!loading && !error && data.map((p) => (
                <tr key={p.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.anio}</td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{p.tipo}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-primary)' }}>{p.titulo || '—'}</td>
                  <td className="px-4 py-3"><StatusChip tone={ESTADO_TONE[p.estado] ?? 'neutral'}>{(p.estado || '—').replace(/_/g, ' ')}</StatusChip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
