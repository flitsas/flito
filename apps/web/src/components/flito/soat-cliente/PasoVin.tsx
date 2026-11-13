// FLITO — canal Cliente del SOAT: las piezas del paso del VIN (bloque 1), HU #12844.
//
// Fuera de la página porque `FlitoSoatSolicitud.tsx` roza el techo de 800 líneas del lint, y porque
// son presentación pura: ninguna decide nada, solo pinta lo que la página ya resolvió.
// Diseño: docs/ux/soat-cliente-tarjeta-soat-activo.md §3 y §5.

import { Icono } from '../../flit/kit/Icono';
import { normalizarVin, VIN_LARGO, type DesenlaceRunt } from '../../../lib/soatCliente';

/** Superficie común de la banda, el vacío y la tarjeta: la de la banda que ya existía. */
const CAJA = { border: '1px solid var(--color-border)', background: 'var(--color-surface)' };

/**
 * Ayuda + contador bajo el renglón del VIN. El contador cuenta sobre el valor NORMALIZADO
 * (`9FKRG-2222-T2042405` → 17 de 17) y no es región viva: entra al `aria-describedby` del campo.
 */
export function AyudaVin({ vin }: { vin: string }) {
  return (
    <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
      <span className="flex items-start gap-1.5">
        <Icono nombre="exclamacion" size={14} className="mt-px shrink-0" />
        Está en la tarjeta de propiedad y en la factura de venta.
      </span>
      <span className="ml-auto tabular-nums text-[color:var(--color-text-tertiary)]">
        {normalizarVin(vin).length} de {VIN_LARGO}
      </span>
    </span>
  );
}

/** Aviso de 11 a 16 caracteres: no bloquea. Icono en insignia; la tinta del texto es secundaria. */
export function AvisoLongitudVin({ texto }: { texto: string }) {
  return (
    <p className="mt-2 flex items-start gap-2 text-xs text-[color:var(--color-text-secondary)]">
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--kit-naranja) 10%, var(--color-surface-elevated))', color: 'var(--kit-naranja-texto)' }}
      >
        <Icono nombre="alerta" size={12} />
      </span>
      {texto}
    </p>
  );
}

/** Estado vacío: antes de la primera consulta, o después de editar el VIN. */
export function VacioVin({ renovacion = false }: { renovacion?: boolean }) {
  return (
    <div className="mt-3 flex items-start gap-3 rounded-[9px] p-4" style={CAJA}>
      <Icono nombre="buscar" size={20} className="mt-0.5 shrink-0 text-[color:var(--color-text-tertiary)]" />
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {renovacion
          ? 'Con la placa y el documento del propietario, el RUNT le trae la marca, la línea, el modelo y la ficha técnica. Usted no tiene que escribirlos.'
          : 'Con el VIN, el RUNT le trae la placa, la marca, la línea, el modelo y la ficha técnica. Usted no tiene que escribirlos.'}
      </p>
    </div>
  );
}

/** Esqueleto con la rejilla de `FichaRunt` mientras el RUNT responde. Pulsa salvo `reduced-motion`. */
export function EsqueletoFicha() {
  return (
    <div aria-hidden="true" className="mt-3 rounded-[9px] p-4" style={CAJA}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="kit-esqueleto h-2.5 w-16" />
            <div className="kit-esqueleto h-3.5 w-24 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Banda de desenlace del RUNT. El tono se lee por la insignia y el copy; el título va en
 * `--color-text-primary` (el texto naranja de antes daba ~2,6:1 en oscuro).
 */
export function BandaDesenlace({ id, desenlace }: { id: string; desenlace: DesenlaceRunt }) {
  const peligro = desenlace.tono === 'danger';
  return (
    <div id={id} role="alert" data-tono={desenlace.tono} className="mt-3 flex items-start gap-3 rounded-[9px] p-3" style={CAJA}>
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={peligro
          ? { background: 'color-mix(in srgb, var(--kit-rojo) 10%, var(--color-surface-elevated))', color: 'var(--kit-rojo-texto)' }
          : { background: 'color-mix(in srgb, var(--kit-naranja) 10%, var(--color-surface-elevated))', color: 'var(--kit-naranja-texto)' }}
      >
        <Icono nombre={peligro ? 'exclamacion' : 'alerta'} size={18} />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{desenlace.titulo}</p>
        <p className="text-xs text-[color:var(--color-text-secondary)]">{desenlace.detalle}</p>
      </div>
    </div>
  );
}
