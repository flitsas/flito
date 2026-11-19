import type { ReactNode, RefObject } from 'react';
import { IconoModulo } from './kit/Icono';
import Miga, { type PasoMiga } from './Miga';

/**
 * Cabecera de módulo del UI Kit 2026 (`.page-header` de ui-kit-2026.css; CabeceraModulo de flit develop): tarjeta
 * con borde, ícono del módulo de 56 px a la izquierda, miga (empieza en Inicio), una sola h1 y acciones a la
 * derecha. Sin círculo decorativo. ≤640 px: sin ícono y acciones a todo el ancho.
 */
interface PageHeaderCardProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  leading?: ReactNode;
  titleRef?: RefObject<HTMLHeadingElement>;
  /** Clave de módulo (MAPA_ICONO, p. ej. «flito-logistica»): pinta el disco de 56 px. */
  icono?: string;
  /** Niveles anteriores de la miga (Inicio se antepone solo). */
  miga?: PasoMiga[];
  /** Aditivo (Torre #14590, detalle): texto bajo el subtítulo, dentro de la cabecera (p. ej. «Cómo se calcula: …»). */
  detalle?: ReactNode;
}

export default function PageHeaderCard(
  { title, subtitle, actions, leading, titleRef, icono, miga, detalle }: PageHeaderCardProps,
) {
  const conIlus = Boolean(icono);
  return (
    <div className={`page-header${conIlus ? '' : ' kit-header--sin-ilus'}`} data-kit="cabecera">
      {icono && <IconoModulo clave={icono} disco size={56} className="page-header__ilus" />}
      <div className="page-header__texto flex min-w-0 items-center gap-4">
        {leading}
        <div className="min-w-0">
          {miga && <Miga pasos={miga} actual={title} />}
          <h1 ref={titleRef} tabIndex={titleRef ? -1 : undefined} className="outline-none">{title}</h1>
          {subtitle && <p>{subtitle}</p>}
          {detalle}
        </div>
      </div>
      {actions && <div className="page-header__acciones">{actions}</div>}
    </div>
  );
}
