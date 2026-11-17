import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';
import { Icono } from '../components/flit/kit/Icono';

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

const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

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

  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : data.length === 0 ? 'empty' : 'ready';

  const descargarPdf = async (v: ManualVersion) => {
    try { await api.download(`/laft/manual/${v.id}/pdf`, `manual-sarlaft-v${v.version}.pdf`); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  const columnas: ColumnaTabla<ManualVersion>[] = [
    { key: 'version', header: 'Versión', render: (v) => <span className="font-semibold tabular-nums text-text-primary">v{v.version}</span> },
    { key: 'estado', header: 'Estado', render: (v) => <StatusChip tone={v.publicado ? 'success' : 'neutral'}>{v.publicado ? 'Publicada' : 'Borrador'}</StatusChip> },
    { key: 'publicada', header: 'Publicada', render: (v) => <span className="text-xs text-text-secondary">{fecha(v.publicadoAt)}</span> },
    { key: 'sha', header: 'SHA-256', render: (v) => <span className="mono text-text-tertiary">{v.sha256 ? `${v.sha256.slice(0, 12)}…` : '—'}</span> },
    {
      key: 'pdf',
      header: '',
      align: 'right',
      acciones: true,
      render: (v) => (
        <GradientButton type="button" variant="secondary" size="sm" onClick={() => descargarPdf(v)}>
          <Icono nombre="nube-bajar" size={16} />
          PDF
        </GradientButton>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Manual SARLAFT"
        subtitle="Versiones del manual de prevención LA/FT/FPADM. La versión publicada vigente es la de referencia oficial"
        icono="flito-laft"
        miga={MIGA}
      />

      <EstadoVista status={estado} cargando="Cargando..." onRetry={load} errorMessage={error ?? undefined} emptyMessage="Sin versiones de manual registradas">
        <DataTable ariaLabel="Versiones del manual SARLAFT" columnas={columnas} filas={data} getKey={(v) => String(v.id)} />
      </EstadoVista>
    </div>
  );
}

