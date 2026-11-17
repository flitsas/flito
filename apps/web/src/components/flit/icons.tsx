// Íconos heredados de FLITO, servidos ahora por el juego del UI Kit 2026 (<Icono>). Mismos nombres y props.
import type { SVGProps } from 'react';
import { Icono, type NombreIcono } from './kit/Icono';

export type IconProps = SVGProps<SVGSVGElement>;

const kit = (nombre: NombreIcono) => function IconoKit({ className, style, width, 'aria-label': etiqueta }: IconProps) {
  return <Icono nombre={nombre} className={className} style={style} size={typeof width === 'number' || typeof width === 'string' ? width : undefined} etiqueta={etiqueta} />;
};

export const IconHome = kit('carpeta');
export const IconClipboard = kit('portapapeles');
export const IconRoad = kit('ruta');
export const IconTruck = kit('carro');
export const IconWrench = kit('reintento');
export const IconShield = kit('escudo');
export const IconUser = kit('persona');
export const IconPackage = kit('archivo');
export const IconScale = kit('mazo');
export const IconCog = kit('ajustes');
export const IconBell = kit('campana');
export const IconSearch = kit('buscar');
export const IconMenu = kit('lista');
export const IconClose = kit('cerrar');
export const IconChevronDown = kit('abajo');
export const IconLogout = kit('externo');
export const IconDot = kit('punto');
export const IconWallet = kit('pago');
export const IconHelp = kit('ayuda');
