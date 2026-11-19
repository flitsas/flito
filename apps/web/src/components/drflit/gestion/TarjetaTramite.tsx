import type { TarjetaTramiteGestion } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';

// Dr. Flit — tarjeta de Gestión Trámites (HU #13836 G1, UX F6.6). Subconjunto de la fila de la cola:
// placa · id FLIT, el chip de estado con el MISMO tono que la cola (`active` si asignado) y tres filas
// `dt/dd` (Trámite, Empresa, Creado). NO es interactiva (F6.7): sin hover, sin cursor de mano.

/** El mismo formateador de la columna «Creado» de `FlitoTramites.tsx`; vacío = «—». */
const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

export default function TarjetaTramite({ tarjeta }: { tarjeta: TarjetaTramiteGestion }) {
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <p className="min-w-0 break-words">
          {tarjeta.placa && (
            <>
              <span className="font-semibold">{tarjeta.placa}</span>
              <span className="text-flit-secondary" aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
            </>
          )}
          <span className="break-all tabular-nums text-flit-secondary">{tarjeta.idFlit}</span>
        </p>
        <StatusChip tone={tarjeta.asignado ? 'active' : 'neutral'}>{tarjeta.estado}</StatusChip>
      </div>
      <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-flit-secondary">Trámite</dt>
        <dd className="break-words">{tarjeta.tipoTramite ?? '—'}</dd>
        <dt className="text-flit-secondary">Empresa</dt>
        <dd className="break-words">{tarjeta.empresa ?? '—'}</dd>
        <dt className="text-flit-secondary">Creado</dt>
        <dd className="tabular-nums">{fecha(tarjeta.creado)}</dd>
      </dl>
    </div>
  );
}
