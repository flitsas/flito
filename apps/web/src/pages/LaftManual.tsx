import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';

// MVP read-only (USR-5): Manual SARLAFT — versiones. Conectado a
// GET /api/laft/manual (laft_manual). Mutaciones (crear/firmar/publicar) son
// admin-only y quedan fuera de este MVP.
interface ManualVersion {
  id: number;
  version: number;
  publicado: boolean;
  publicadoAt: string | null;
  sha256: string | null;
  createdAt: string | null;
}

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

function fecha(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
}

export default function LaftManual() {
  const [data, setData] = useState<ManualVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<{ data: ManualVersion[] }>('/laft/manual');
      setData(res.data ?? []);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const descargarPdf = async (v: ManualVersion) => {
    try { await api.download(`/laft/manual/${v.id}/pdf`, `manual-sarlaft-v${v.version}.pdf`); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Manual SARLAFT"
        subtitle="Versiones del manual de prevención LA/FT/FPADM. La versión publicada vigente es la de referencia oficial"
      />

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>{['Versión', 'Estado', 'Publicada', 'SHA-256', ''].map((h, i) => <Th key={i}>{h}</Th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && error && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</td></tr>}
              {!loading && !error && data.length === 0 && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin versiones de manual registradas</td></tr>}
              {!loading && !error && data.map((v) => (
                <tr key={v.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>v{v.version}</td>
                  <td className="px-4 py-3"><StatusChip tone={v.publicado ? 'success' : 'neutral'}>{v.publicado ? 'Publicada' : 'Borrador'}</StatusChip></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{fecha(v.publicadoAt)}</td>
                  <td className="px-4 py-3 font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{v.sha256 ? `${v.sha256.slice(0, 12)}…` : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => descargarPdf(v)}
                      className="flit-focus inline-flex items-center rounded-[999px] px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80"
                      style={{ background: 'rgba(79,116,201,0.14)', color: 'var(--flit-blue)' }}>PDF</button>
                  </td>
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
