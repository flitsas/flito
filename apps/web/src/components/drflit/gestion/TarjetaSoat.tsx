import type { EstadoSoat, TarjetaSoatGestion } from '@operaciones/shared-types';
import ChipEstadoSoat from '../../flito/soat/ChipEstadoSoat';
import { fecha } from '../../flito/soat/tipos';

// Dr. Flit — tarjeta de Gestión SOAT (HU #13837 G2, UX F6.6). Subconjunto de la fila de la cola:
// título placa (o VIN cuando no hay placa: el API solo lo manda en ese caso), el MISMO chip de estado
// de la cola (`ChipEstadoSoat`) y filas `dt/dd`: Compañía (solo si viene: la cola del canal Cliente no
// la muestra), Solicitado y Pagado, con el formateador de fecha de `TablaColaSoat.tsx`.
// NO es interactiva (F6.7): sin hover, sin cursor de mano.

export default function TarjetaSoat({ tarjeta }: { tarjeta: TarjetaSoatGestion }) {
  const titulo = tarjeta.placa ?? tarjeta.vin ?? '—';
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <p className={`min-w-0 font-semibold ${tarjeta.placa ? 'break-words' : 'break-all tabular-nums'}`}>{titulo}</p>
        <ChipEstadoSoat estado={tarjeta.estado as EstadoSoat} />
      </div>
      <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        {tarjeta.compania !== undefined && (
          <>
            <dt className="text-flit-secondary">Compañía</dt>
            <dd className="break-words">{tarjeta.compania || '—'}</dd>
          </>
        )}
        <dt className="text-flit-secondary">Solicitado</dt>
        <dd className="tabular-nums">{fecha(tarjeta.solicitado)}</dd>
        <dt className="text-flit-secondary">Pagado</dt>
        <dd className="tabular-nums">{fecha(tarjeta.pagado)}</dd>
      </dl>
    </div>
  );
}
