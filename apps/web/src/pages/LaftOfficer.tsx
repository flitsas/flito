import { useEffect, useState, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

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

const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

function fecha(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
}

const COLUMNAS: ColumnaTabla<Officer>[] = [
  { key: 'rol', header: 'Rol', render: (o) => <StatusChip tone="active">{o.rol}</StatusChip> },
  { key: 'nombre', header: 'Nombre', render: (o) => <span className="text-text-primary">{o.userName || '—'}</span> },
  { key: 'email', header: 'Email', render: (o) => <span className="text-xs text-text-tertiary">{o.userEmail || '—'}</span> },
  { key: 'desde', header: 'Desde', render: (o) => <span className="text-xs text-text-secondary">{fecha(o.validFrom)}</span> },
  {
    key: 'iso',
    header: 'Cert. ISO 17024',
    render: (o) => <StatusChip tone={o.certificacionIso17024 ? 'success' : 'warning'}>{o.certificacionIso17024 ? 'Sí' : 'Pendiente'}</StatusChip>,
  },
];

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

  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : data.length === 0 ? 'empty' : 'ready';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Oficial de cumplimiento"
        subtitle="Oficiales de cumplimiento vigentes (principal y suplente) con su certificación ISO 17024"
        icono="flito-laft"
        miga={MIGA}
      />

      <EstadoVista status={estado} cargando="Cargando..." onRetry={load} errorMessage={error ?? undefined} emptyMessage="Sin oficiales vigentes designados">
        <DataTable ariaLabel="Oficiales de cumplimiento vigentes" columnas={COLUMNAS} filas={data} getKey={(o) => String(o.id)} />
      </EstadoVista>
    </div>
  );
}

