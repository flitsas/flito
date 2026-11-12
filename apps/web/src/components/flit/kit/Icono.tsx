/*
 * Íconos del Manual UI Kit 2026 (porte de flit develop packages/ui/src/Icono.tsx a React 18).
 *  - <Icono nombre="campana" />: glifo en currentColor, 1em por defecto.
 *  - <Icono nombre="reportes" disco />: el `.kico` de la propuesta (disco --kit-hover, glifo azul al 56 %).
 *  - <IconoModulo clave="logistica" />: resuelve la clave de módulo con MAPA_ICONO (un "@x" pinta el SVG suelto).
 * Decorativo por defecto (aria-hidden). Con `etiqueta` pasa a role="img" con nombre accesible.
 * Sin innerHTML: el glifo es un árbol de nodos generado (iconos-kit.generated.ts) que se pinta con createElement.
 */
import { useId, type CSSProperties } from 'react';
import { pintarGlifo } from './GlifoSvg';
import { cn } from './cn';
import { GLIFOS, type NombreIcono } from './iconos-kit.generated';
import { MAPA_ICONO, rutaKit } from './iconos-mapas';

export type { NombreIcono } from './iconos-kit.generated';

export interface IconoProps {
  nombre: NombreIcono;
  /** Lado en px o cualquier unidad CSS. Por defecto 1em. */
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Disco del kit (.kico): fondo --kit-hover y glifo en azul. El `size` es el del disco. */
  disco?: boolean;
  /** Nombre accesible; sin él el ícono es decorativo. */
  etiqueta?: string;
}

const lado = (s: number | string | undefined, def: string) => (s === undefined ? def : typeof s === 'number' ? `${s}px` : s);

export function Icono({ nombre, size, className, style, disco, etiqueta }: IconoProps) {
  const k = `k${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const g = GLIFOS[nombre] ?? GLIFOS.documento;
  const a11y = etiqueta ? { role: 'img' as const, 'aria-label': etiqueta } : { 'aria-hidden': true as const };
  const svg = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={g.vb}
      width={disco ? '56%' : lado(size, '1em')}
      height={disco ? '56%' : lado(size, '1em')}
      focusable="false"
      className={disco ? undefined : cn('kit-icono', className)}
      style={disco ? undefined : style}
      {...(disco ? { 'aria-hidden': true as const } : a11y)}
    >
      {pintarGlifo(g, k)}
    </svg>
  );
  if (!disco) return svg;
  const d = lado(size, '40px');
  return (
    <span className={cn('kit-disco', className)} style={{ width: d, height: d, ...style }} {...a11y}>
      {svg}
    </span>
  );
}

export interface IconoModuloProps extends Omit<IconoProps, 'nombre'> {
  /** Clave de módulo (MAPA_ICONO). Sin mapa cae en «documento», como la propuesta. */
  clave: string;
}

export function IconoModulo({ clave, size, className, style, disco, etiqueta }: IconoModuloProps) {
  const m = MAPA_ICONO[clave] ?? 'documento';
  if (m.startsWith('@')) {
    const d = lado(size, '40px');
    return (
      <img
        src={rutaKit(m)}
        alt={etiqueta ?? ''}
        aria-hidden={etiqueta ? undefined : true}
        width={typeof size === 'number' ? size : 40}
        height={typeof size === 'number' ? size : 40}
        className={cn('kit-imagen', className)}
        style={{ width: d, height: d, ...style }}
      />
    );
  }
  return <Icono nombre={m as NombreIcono} size={size} className={className} style={style} disco={disco} etiqueta={etiqueta} />;
}
