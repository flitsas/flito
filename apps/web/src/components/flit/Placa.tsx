import type { HTMLAttributes, ReactNode } from 'react';
import { IconoModulo } from './kit/Icono';

/**
 * Placa colombiana del UI Kit 2026 (`.placa`): amarillo del objeto real con el filete, Barlow Condensed, texto real
 * (se lee, se copia y lo anuncia el lector). `size="lg"` es la `.placa--grande` del detalle.
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
}

export default function Placa({ placa, ciudad, size = 'md', formatear = true, className = '', ...rest }: PlacaProps) {
  return (
    <span className={`placa${size === 'lg' ? ' placa--grande' : ''} ${className}`} data-kit="placa" {...rest}>
      <span className="placa__num">{formatear ? formatoPlaca(placa) : placa}</span>
      {ciudad ? <span className="placa__ciudad uppercase">{ciudad}</span> : null}
    </span>
  );
}

/** Bloque de vehículo (`.vehiculo` del detalle): ícono, antetítulo, placa grande + nombre, meta y etiquetas. */
export function Vehiculo({ placa, ciudad, nombre, meta, antetitulo, etiquetas, icono = 'flito-vehiculos' }: {
  placa: string; ciudad?: string | null; nombre: ReactNode; meta?: ReactNode; antetitulo?: string;
  etiquetas?: ReactNode; icono?: string;
}) {
  return (
    <div className="vehiculo" data-kit="vehiculo">
      <IconoModulo clave={icono} disco size={52} className="detalle__ilus" />
      <div className="vehiculo__datos">
        {antetitulo && <p className="antetitulo">{antetitulo}</p>}
        <h3 className="vehiculo__nombre flex flex-wrap items-center gap-3"><Placa placa={placa} ciudad={ciudad} size="lg" /> {nombre}</h3>
        {meta && <p className="vehiculo__meta">{meta}</p>}
        {etiquetas && <div className="vehiculo__estado">{etiquetas}</div>}
      </div>
    </div>
  );
}
