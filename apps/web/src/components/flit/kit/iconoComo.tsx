/* Componente de ícono del kit para los sitios que esperan un COMPONENTE (`icon={iconoComo('lapiz')}`), como
 * los `LucideIcon` de navItems. Acepta y descarta `strokeWidth`. Mismo componente por nombre (estable). */
import type { CSSProperties } from 'react';
import { Icono, type NombreIcono } from './Icono';

export interface IconoComoProps {
  className?: string;
  style?: CSSProperties;
  size?: number | string;
  strokeWidth?: number | string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
}

const COMO = new Map<NombreIcono, (p: IconoComoProps) => JSX.Element>();

export function iconoComo(nombre: NombreIcono) {
  let c = COMO.get(nombre);
  if (!c) {
    const Comp = ({ className, style, size, 'aria-label': etiqueta }: IconoComoProps) => (
      <Icono nombre={nombre} className={className} style={style} size={size} etiqueta={etiqueta} />
    );
    Comp.displayName = `Icono(${nombre})`;
    c = Comp;
    COMO.set(nombre, c);
  }
  return c;
}
