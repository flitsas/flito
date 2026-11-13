import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import StatusChip, { type ChipTone } from './StatusChip';
import { IconoModulo } from './kit/Icono';

/**
 * Tarjeta de cifra del UI Kit 2026 (`.metrica` de la propuesta; TarjetaMetrica de flit develop): etiqueta, cifra
 * azul 24 bold, pie subrayado y disco del módulo a la derecha. Enlazada (`to`) es un botón que lleva a lo que cuenta.
 */
interface KpiCardProps {
  to?: string;
  ariaLabel?: string;
  label: string;
  value: ReactNode;
  hint?: string;
  chip?: { tone: ChipTone; label: string };
  children?: ReactNode;
  /** Clave de módulo (MAPA_ICONO) para el disco de la derecha. */
  icono?: string;
  /** Cifra que pide atención: borde y cifra en naranja (`.metrica--pendiente`). */
  pendiente?: boolean;
}

export default function KpiCard({ to, ariaLabel, label, value, hint, chip, children, icono, pendiente }: KpiCardProps) {
  const inner = (
    <>
      <span className="metrica__etiqueta flex flex-wrap items-center gap-2">
        {label}
        {chip && <StatusChip tone={chip.tone}>{chip.label}</StatusChip>}
      </span>
      <span className="metrica__cifra tabular-nums">{value}</span>
      {hint && <span className="metrica__pie">{hint}</span>}
      {icono && <IconoModulo clave={icono} disco size={40} className="metrica__ilus" />}
      {children && <div className="col-span-2 min-w-0">{children}</div>}
    </>
  );
  const cls = `metrica${pendiente ? ' metrica--pendiente' : ''}`;
  if (to) {
    return <Link to={to} aria-label={ariaLabel ?? label} className={cls} data-kit="metrica">{inner}</Link>;
  }
  return <div className={`${cls} cursor-default`} data-kit="metrica">{inner}</div>;
}
