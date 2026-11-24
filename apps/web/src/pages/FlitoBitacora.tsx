// FLITO Bitácora (Fase 6). Porta packages/client/src/paginas/bitacora.tsx al kit flit/ + api.
// Consulta de solo lectura sobre audit_logs (dominio FLITO). Toda transición deja rastro,
// incluidas las automáticas del sistema (actor «sistema»).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { flitInp } from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import type { EstadoUi } from '../components/flit/Cargador';

interface BitacoraItem {
  id: number; resource: string; resourceId: string | null; action: string;
  actorNombre: string | null; actorId: number | null; detalle: string | null; creadoEn: string;
}

// resource → etiqueta corta.
const RECURSOS: { slug: string; label: string }[] = [
  { slug: '', label: 'Todas' },
  { slug: 'flito_soat', label: 'SOAT' },
  { slug: 'flito_impuesto', label: 'Impuesto' },
  { slug: 'flito_tramite', label: 'Trámite' },
  { slug: 'flito_revision', label: 'Revisión' },
];

const OPCIONES_RECURSO = RECURSOS.map((r) => ({ valor: r.slug, etiqueta: r.label }));

const COLUMNAS: ColumnaTabla<BitacoraItem>[] = [
  {
    key: 'fecha', header: 'Fecha', etiqueta: 'Fecha',
    render: (e) => <span className="whitespace-nowrap text-xs text-[color:var(--color-text-tertiary)]">{fechaHora(e.creadoEn)}</span>,
  },
  {
    key: 'recurso', header: 'Recurso', etiqueta: 'Recurso',
    render: (e) => <StatusChip tone="neutral">{e.resource.replace('flito_', '')}</StatusChip>,
  },
  { key: 'accion', header: 'Acción', etiqueta: 'Acción', render: (e) => <span className="text-sm font-medium">{e.action}</span> },
  {
    key: 'actor', header: 'Actor', etiqueta: 'Actor',
    render: (e) => (e.actorNombre === 'sistema'
      ? <StatusChip tone="draft">sistema</StatusChip>
      : <span className="text-sm">{e.actorNombre ?? '—'}</span>),
  },
  {
    key: 'detalle', header: 'Detalle', etiqueta: 'Detalle',
    render: (e) => <span className="block max-w-[420px] text-xs italic text-[color:var(--color-text-secondary)]">{e.detalle ?? '—'}</span>,
  },
];

function fechaHora(iso: string) {
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

export default function FlitoBitacora() {
  const [resource, setResource] = useState('');
  const [limite, setLimite] = useState(100);
  const [data, setData] = useState<BitacoraItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setData(null);
    const q = new URLSearchParams();
    if (resource) q.set('resource', resource);
    q.set('limite', String(limite));
    api.get<BitacoraItem[]>(`/flito/bitacora?${q.toString()}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [resource, limite]);

  const status: EstadoUi = error ? 'error' : data === null ? 'loading' : data.length === 0 ? 'empty' : 'ready';

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Bitácora"
        icono="flito-bitacora"
        miga={[{ etiqueta: 'Logística', to: '/flito/logistica' }]}
        subtitle="Toda transición deja rastro, incluidas las automáticas del sistema."
      />

      <div className="flex flex-wrap items-center gap-3">
        <FiltroSegmentado opciones={OPCIONES_RECURSO} valor={resource} onCambio={setResource} ariaLabel="Filtrar por recurso" />
        <label className="ml-auto flex items-center gap-2 text-xs text-[color:var(--color-text-tertiary)]">
          Límite
          <input type="number" min={1} max={500} value={limite} className={`${flitInp} w-24`}
            onChange={(e) => setLimite(Math.min(500, Math.max(1, Number(e.target.value) || 100)))} />
        </label>
      </div>

      <DataTable
        ariaLabel="Bitácora de movimientos"
        columnas={COLUMNAS}
        filas={data ?? []}
        getKey={(e) => String(e.id)}
        status={status}
        errorMessage={error ?? undefined}
        emptyMessage="Sin movimientos registrados. Cuando se sincronice, se tome o se pague algo, aparecerá aquí."
      />
    </div>
  );
}
