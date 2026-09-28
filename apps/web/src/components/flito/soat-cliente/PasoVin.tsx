// FLITO — canal Cliente del SOAT: las piezas del paso del VIN (bloque 1), HU #12844.
//
// Fuera de la página porque `FlitoSoatSolicitud.tsx` roza el techo de 800 líneas del lint, y porque
// son presentación pura: ninguna decide nada, solo pinta lo que la página ya resolvió.
// Diseño: docs/ux/soat-cliente-tarjeta-soat-activo.md §3 y §5.

import { CircleAlert, Info, ScanSearch, TriangleAlert } from 'lucide-react';
import { normalizarVin, VIN_LARGO, type DesenlaceRunt } from '../../../lib/soatCliente';

/** Superficie común de la banda, el vacío y la tarjeta: la de la banda que ya existía. */
const CAJA = { border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' };

/**
 * Ayuda + contador bajo el renglón del VIN. El contador cuenta sobre el valor NORMALIZADO
 * (`9FKRG-2222-T2042405` → 17 de 17) y no es región viva: entra al `aria-describedby` del campo.
 */
export function AyudaVin({ vin }: { vin: string }) {
  return (
    <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
      <span className="flex items-start gap-1.5">
        <Info size={14} aria-hidden="true" className="mt-px shrink-0" />
        Está en la tarjeta de propiedad y en la factura de venta.
      </span>
      <span className="ml-auto tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
        {normalizarVin(vin).length} de {VIN_LARGO}
      </span>
    </span>
  );
}

/** Aviso de 11 a 16 caracteres: no bloquea. Icono en insignia; la tinta del texto es secundaria. */
export function AvisoLongitudVin({ texto }: { texto: string }) {
  return (
    <p className="mt-2 flex items-start gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}
      >
        <TriangleAlert size={12} />
      </span>
      {texto}
    </p>
  );
}

/** Estado vacío: antes de la primera consulta, o después de editar el VIN. */
export function VacioVin() {
  return (
    <div className="mt-3 flex items-start gap-3 rounded-[10px] p-4" style={CAJA}>
      <ScanSearch size={20} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-text-muted)' }} />
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Con el VIN, el RUNT le trae la placa, la marca, la línea, el modelo y la ficha técnica. Usted
        no tiene que escribirlos.
      </p>
    </div>
  );
}

/** Esqueleto con la rejilla de `FichaRunt` mientras el RUNT responde. Pulsa salvo `reduced-motion`. */
export function EsqueletoFicha() {
  return (
    <div aria-hidden="true" className="mt-3 animate-pulse rounded-[12px] p-4 motion-reduce:animate-none" style={CAJA}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-16 rounded" style={{ background: 'var(--flit-bg-hover)' }} />
            <div className="h-3.5 w-24 max-w-full rounded" style={{ background: 'var(--flit-bg-hover)' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Banda de desenlace del RUNT. El tono se lee por la insignia y el copy; el título va en
 * `--flit-text-primary` (el `--flit-warning-ink` de antes daba ~2,6:1 en oscuro).
 */
export function BandaDesenlace({ id, desenlace }: { id: string; desenlace: DesenlaceRunt }) {
  const peligro = desenlace.tono === 'danger';
  return (
    <div id={id} role="alert" data-tono={desenlace.tono} className="mt-3 flex items-start gap-3 rounded-[10px] p-3" style={CAJA}>
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={peligro
          ? { background: 'var(--flit-chip-danger-bg)', color: 'var(--flit-danger-ink)' }
          : { background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}
      >
        {peligro ? <CircleAlert size={18} /> : <TriangleAlert size={18} />}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{desenlace.titulo}</p>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{desenlace.detalle}</p>
      </div>
    </div>
  );
}
