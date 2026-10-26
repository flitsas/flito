import type { TarjetaDerechoGestion } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';

// Dr. Flit — tarjeta de Gestión Derechos (HU #13838 G3, UX F6.6). Subconjunto de la fila «Registrados»
// de `FlitoDerechos.tsx`: placa · id FLIT; la cola no tiene estado, así que el único chip es «Con
// advertencia» (tono `warning`, el de la cola) y SOLO si la fila la trae. Filas `dt/dd`: Concepto, Valor
// y Fecha de pago. NO es interactiva (F6.7): sin hover, sin cursor de mano.

/** El mismo formato de la columna Valor de `FlitoDerechos.tsx`. */
const pesos = (v: number | null): string =>
  v === null ? '—' : `$ ${Number(v).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

/**
 * El mismo formateador de la columna Fecha de pago de `FlitoDerechos.tsx`: `fechaPago` es una fecha SIN
 * hora; `new Date(...)` la leería como medianoche UTC y en Colombia retrocedería un día.
 */
const fecha = (v: string | null): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
};

export default function TarjetaDerecho({ tarjeta }: { tarjeta: TarjetaDerechoGestion }) {
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
        {tarjeta.conAdvertencia && <StatusChip tone="warning">Con advertencia</StatusChip>}
      </div>
      <dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <dt className="text-flit-secondary">Concepto</dt>
        <dd className="break-words">{tarjeta.concepto ?? '—'}</dd>
        <dt className="text-flit-secondary">Valor</dt>
        <dd className="tabular-nums">{pesos(tarjeta.valor)}</dd>
        <dt className="text-flit-secondary">Fecha de pago</dt>
        <dd className="tabular-nums">{fecha(tarjeta.fechaPago)}</dd>
      </dl>
    </div>
  );
}
