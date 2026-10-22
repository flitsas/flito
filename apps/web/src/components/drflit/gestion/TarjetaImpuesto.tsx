import { ESTADO_IMPUESTO_LABEL, type EstadoImpuesto, type TarjetaImpuestoGestion } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import { TONO_IMPUESTO, fecha } from '../../flito/ImpuestoCola';
import { pesos } from '../../../lib/pesos';

// Dr. Flit — tarjeta de Gestión Impuestos (HU #13838 G3, UX F6.6). Subconjunto de la fila de la cola:
// placa · id FLIT, el MISMO chip de la columna Estado de `FlitoImpuestos.tsx` (etiqueta + tono) y filas
// `dt/dd`: Organismo, Liquidado y Fecha pago, con los formateadores de la cola (`pesos`, `fecha`).
// NO es interactiva (F6.7): sin hover, sin cursor de mano.

export default function TarjetaImpuesto({ tarjeta }: { tarjeta: TarjetaImpuestoGestion }) {
  const estado = tarjeta.estado as EstadoImpuesto;
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
        <StatusChip tone={TONO_IMPUESTO[estado] ?? 'neutral'}>{ESTADO_IMPUESTO_LABEL[estado] ?? tarjeta.estado}</StatusChip>
      </div>
      <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-flit-secondary">Organismo</dt>
        <dd className="break-words">{tarjeta.organismo || '—'}</dd>
        <dt className="text-flit-secondary">Liquidado</dt>
        <dd className="tabular-nums">{pesos(tarjeta.liquidado)}</dd>
        <dt className="text-flit-secondary">Fecha pago</dt>
        <dd className="tabular-nums">{fecha(tarjeta.pagado)}</dd>
      </dl>
    </div>
  );
}
