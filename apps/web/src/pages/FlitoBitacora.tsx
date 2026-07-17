// FLITO Bitácora (Fase 6). Porta packages/client/src/paginas/bitacora.tsx al kit flit/ + api.
// Consulta de solo lectura sobre audit_logs (dominio FLITO). Toda transición deja rastro,
// incluidas las automáticas del sistema (actor «sistema»).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitPillGroup, FlitPillButton, flitInp,
} from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';

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

const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

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

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Bitácora"
        subtitle="Toda transición deja rastro, incluidas las automáticas del sistema."
      />

      <FlitCard>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <FlitPillGroup>
            {RECURSOS.map((r) => (
              <FlitPillButton key={r.slug} active={resource === r.slug} onClick={() => setResource(r.slug)}>
                {r.label}
              </FlitPillButton>
            ))}
          </FlitPillGroup>
          <label className="ml-auto flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Límite
            <input type="number" min={1} max={500} value={limite} className={`${flitInp} h-8 w-20`}
              onChange={(e) => setLimite(Math.min(500, Math.max(1, Number(e.target.value) || 100)))} />
          </label>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && data && data.length === 0 && (
          <FlitEmpty>Sin movimientos registrados. Cuando se sincronice, se tome o se pague algo, aparecerá aquí.</FlitEmpty>
        )}

        {!!data?.length && (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Fecha</FlitTh><FlitTh>Recurso</FlitTh><FlitTh>Acción</FlitTh>
                <FlitTh>Actor</FlitTh><FlitTh>Detalle</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {data.map((e) => (
                <FlitTr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{fechaHora(e.creadoEn)}</td>
                  <td className="px-3 py-2"><StatusChip tone="neutral">{e.resource.replace('flito_', '')}</StatusChip></td>
                  <td className="px-3 py-2 text-sm font-medium">{e.action}</td>
                  <td className="px-3 py-2 text-sm">
                    {e.actorNombre === 'sistema'
                      ? <StatusChip tone="draft">sistema</StatusChip>
                      : (e.actorNombre ?? '—')}
                  </td>
                  <td className="max-w-[420px] px-3 py-2 text-xs italic" style={{ color: 'var(--flit-text-secondary)' }}>{e.detalle ?? '—'}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
      </FlitCard>
    </div>
  );
}
