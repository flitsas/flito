import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';

// MVP read-only (USR-5): Oficial de cumplimiento — vigentes. Conectado a
// GET /api/laft/officer/vigentes (laft_oficial). Designar/revocar es admin-only
// (fuera de este MVP).
interface Officer {
  id: number;
  rol: string;
  userName: string | null;
  userEmail: string | null;
  validFrom: string | null;
  validTo: string | null;
  certificacionIso17024: boolean | null;
}

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

function fecha(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
}

export default function LaftOfficer() {
  const [data, setData] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<{ data: Officer[] }>('/laft/officer/vigentes');
      setData(res.data ?? []);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Oficial de cumplimiento"
        subtitle="Oficiales de cumplimiento vigentes (principal y suplente) con su certificación ISO 17024"
      />

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>{['Rol', 'Nombre', 'Email', 'Desde', 'Cert. ISO 17024'].map((h) => <Th key={h}>{h}</Th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && error && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</td></tr>}
              {!loading && !error && data.length === 0 && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin oficiales vigentes designados</td></tr>}
              {!loading && !error && data.map((o) => (
                <tr key={o.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3"><StatusChip tone="active">{o.rol}</StatusChip></td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-primary)' }}>{o.userName || '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{o.userEmail || '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{fecha(o.validFrom)}</td>
                  <td className="px-4 py-3"><StatusChip tone={o.certificacionIso17024 ? 'success' : 'warning'}>{o.certificacionIso17024 ? 'Sí' : 'Pendiente'}</StatusChip></td>
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
