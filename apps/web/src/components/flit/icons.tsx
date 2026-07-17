import type { SVGProps } from 'react';

// Iconografía lineal FLIT (Lucide style, stroke 1.6, currentColor) — blanca en
// sidebar, azul/gris en topbar. Centralizada para no repetir SVG por componente.
const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export type IconProps = SVGProps<SVGSVGElement>;

export const IconHome = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" /></svg>
);
export const IconClipboard = (p: IconProps) => (
  <svg {...base} {...p}><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9z" /><path d="M9 12h6M9 16h4" /></svg>
);
export const IconRoad = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 19h16M6 19V9l3-4h6l3 4v10" /><path d="M9 9h6M10 13h4" /></svg>
);
export const IconTruck = (p: IconProps) => (
  <svg {...base} {...p}><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" /><circle cx="7" cy="17" r="1.6" /><circle cx="17.5" cy="17" r="1.6" /></svg>
);
export const IconWrench = (p: IconProps) => (
  <svg {...base} {...p}><path d="M14.5 6.5a3.5 3.5 0 0 1-4.6 4.6L5 16l3 3 4.9-4.9a3.5 3.5 0 0 0 4.6-4.6l-2 2-2-2z" /></svg>
);
export const IconShield = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
);
export const IconPackage = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" /><path d="m4 7 8 4 8-4M12 11v10" /></svg>
);
export const IconScale = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 4v16M7 20h10M6 7l-3 6h6zM18 7l-3 6h6zM6 7h12" /></svg>
);
export const IconCog = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M4.2 7l2.2 1.3M17.6 15.7 19.8 17M19.8 7l-2.2 1.3M6.4 15.7 4.2 17" /></svg>
);
export const IconBell = (p: IconProps) => (
  <svg {...base} {...p}><path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>
);
export const IconSearch = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IconMenu = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
);
export const IconClose = (p: IconProps) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconChevronDown = (p: IconProps) => (
  <svg {...base} {...p}><path d="m6 9 6 6 6-6" /></svg>
);
export const IconLogout = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>
);
export const IconDot = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3.2" /></svg>
);
