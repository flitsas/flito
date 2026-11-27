import type { HTMLAttributes, ReactNode } from 'react';
import { normalizarTipoServicio, variantePlaca } from '@operaciones/shared-types';
import { IconoModulo } from './kit/Icono';

/**
 * Placa colombiana del UI Kit 2026 (`.placa`): amarillo del objeto real con el filete, Barlow Condensed, texto real
 * (se lee, se copia y lo anuncia el lector). `size="lg"` es la `.placa--grande` del detalle.
 *
 * Variantes (Épica #14707, UX rediseño Trámites §7): la moto (AAA00A) sale naranjada en TODAS las pantallas; la
 * blanca de servicio público solo donde se pase `tipoServicio`. La variante la decide `variantePlaca` de
 * shared-types (único intérprete del texto libre); `data-variante` es el gancho estable para E2E.
 */
export function formatoPlaca(placa: string): string {
  const limpia = placa.trim().toUpperCase();
  return /^[A-Z]{3}\d{2}[0-9A-Z]$/.test(limpia) ? `${limpia.slice(0, 3)} ${limpia.slice(3)}` : limpia;
}

export interface PlacaProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  placa: string;
  ciudad?: string | null;
  size?: 'md' | 'lg';
  formatear?: boolean;
  /** Texto crudo de `vehicles.tipo_servicio`. Lo interpreta `variantePlaca`; sin dato → amarilla. */
  tipoServicio?: string | null;
  /**
   * Servicio público dicho en texto (sr-only «, servicio público» + `title`), porque el color no basta (1.4.1).
   * `false` donde la línea del vehículo ya lo dice en texto visible.
   */
  anunciarServicio?: boolean;
}

export default function Placa({
  placa, ciudad, size = 'md', formatear = true, tipoServicio, anunciarServicio = true, className = '', ...rest
}: PlacaProps) {
  const variante = variantePlaca(placa, tipoServicio);
  const moto = variante === 'moto' || variante === 'moto-publico';
  const publico = variante === 'publico' || variante === 'moto-publico';
  const clases = ['placa', size === 'lg' && 'placa--grande', moto && 'placa--moto', publico && 'placa--publico', className]
    .filter(Boolean).join(' ');
  const anuncia = publico && anunciarServicio;
  return (
    <span className={clases} data-kit="placa" data-variante={variante === 'particular' ? undefined : variante}
      title={anuncia ? 'Servicio público' : undefined} {...rest}>
      <span className="placa__num">{formatear ? formatoPlaca(placa) : placa}</span>
      {ciudad ? <span className="placa__ciudad uppercase">{ciudad}</span> : null}
      {anuncia && <span className="sr-only">, servicio público</span>}
    </span>
  );
}

/**
 * Servicio del vehículo dicho en TEXTO para la meta del bloque (1.4.1: el color de la placa no basta). Lo interpreta
 * shared-types, no la pantalla: «Servicio público» / «Particular»; otro valor, tal cual; sin dato, null.
 */
export function textoServicioVehiculo(crudo: string | null | undefined): string | null {
  const n = normalizarTipoServicio(crudo);
  if (n === 'publico') return 'Servicio público';
  if (n === 'particular') return 'Particular';
  return crudo && crudo.trim() ? crudo.trim() : null;
}

/** Bloque de vehículo (`.vehiculo` del detalle): ícono, antetítulo, placa grande + nombre, meta y etiquetas. */
export function Vehiculo({
  placa, ciudad, nombre, meta, antetitulo, etiquetas, icono = 'flito-vehiculos', tipoServicio, anunciarServicio,
}: {
  placa: string; ciudad?: string | null; nombre: ReactNode; meta?: ReactNode; antetitulo?: string;
  /** `null`: sin ícono (detalles apaisados, UX `flito-tramites-rediseno.md` §8.1: la placa abre el bloque). */
  etiquetas?: ReactNode; icono?: string | null;
  /** Se pasan a la placa grande (ver `PlacaProps`). */
  tipoServicio?: string | null; anunciarServicio?: boolean;
}) {
  return (
    <div className="vehiculo" data-kit="vehiculo">
      {icono && <IconoModulo clave={icono} disco size={52} className="detalle__ilus" />}
      <div className="vehiculo__datos">
        {antetitulo && <p className="antetitulo">{antetitulo}</p>}
        <h3 className="vehiculo__nombre flex flex-wrap items-center gap-3"><Placa placa={placa} ciudad={ciudad} size="lg" tipoServicio={tipoServicio} anunciarServicio={anunciarServicio} /> {nombre}</h3>
        {meta && <p className="vehiculo__meta">{meta}</p>}
        {etiquetas && <div className="vehiculo__estado">{etiquetas}</div>}
      </div>
    </div>
  );
}
