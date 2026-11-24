import { Icono, type NombreIcono } from './Icono';
import { rutaKit } from './iconos-mapas';

/** Pinta un glifo del kit o, si el valor empieza por «@», el SVG suelto de public/kit (disco de color propio). */
export function IconoGlifo({ icono, size }: { icono: NombreIcono | `@${string}`; size?: number | string }) {
  if (icono.startsWith('@')) return <img src={rutaKit(icono)} alt="" aria-hidden="true" className="kit-imagen h-full w-full" />;
  return <Icono nombre={icono as NombreIcono} size={size} />;
}
