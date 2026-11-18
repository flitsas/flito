// Torre de Control (Épica #14590) — esqueleto común de las 5 páginas (spec UX §7): cabecera con la única primaria,
// pestañas de la Torre (solo las que el rol ve, y solo si ve 2 o más), barra de filtros transversal y la ficha de
// placa. La página crea el estado con `useTorre()` (así su primaria puede depender de lo que muestra).
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { PageSlug } from '../../lib/permissions';
import { hasPage } from '../../lib/permissions';
import { useAuth } from '../../lib/auth';
import type { FiltrosTorre } from '../../lib/torreFiltros';
import PageHeaderCard from '../flit/PageHeaderCard';
import Pestanas from '../flit/Pestanas';
import BarraFiltrosTorre, { useFiltrosTorre } from './BarraFiltrosTorre';
import { useFichaPlaca } from './FichaPlacaDrawer';

export const PAGINAS_TORRE: readonly { slug: PageSlug; to: string; etiqueta: string }[] = [
  { slug: 'torre_360', to: '/flito/torre/resumen', etiqueta: 'Resumen 360°' },
  { slug: 'torre_comercial', to: '/flito/torre/comercial', etiqueta: 'Comercial' },
  { slug: 'torre_operativa', to: '/flito/torre/operativa', etiqueta: 'Operativa' },
  { slug: 'torre_financiera', to: '/flito/torre/financiera', etiqueta: 'Financiera' },
  { slug: 'torre_explorador', to: '/flito/torre/explorador', etiqueta: 'Explorador' },
];

export const rutaTorre = (slug: PageSlug) => PAGINAS_TORRE.find((p) => p.slug === slug)?.to ?? '/flito/torre/explorador';

export interface ContextoTorre {
  filtros: FiltrosTorre;
  setFiltros: (f: FiltrosTorre) => void;
  limpiar: () => void;
  restablecer: () => void;
  abrirFicha: (placa: string) => void;
  /** Desde > Hasta o una fecha incompleta en la barra: no se consulta y queda el último resultado válido (spec §3). */
  rangoInvalido: boolean;
  setRangoInvalido: (v: boolean) => void;
  /** Interno de `PaginaTorre`: contenedor del buscador (el foco vuelve aquí al cerrar la ficha) y el Drawer. */
  buscadorRef: RefObject<HTMLDivElement>;
  drawer: ReactNode;
}

/** Estado de la Torre para una página: filtros compartidos (sessionStorage) y ficha de placa. */
export function useTorre(): ContextoTorre {
  const { filtros, setFiltros, limpiar, restablecer } = useFiltrosTorre();
  const buscadorRef = useRef<HTMLDivElement>(null);
  const ficha = useFichaPlaca(buscadorRef);
  const [rangoInvalido, setRangoInvalido] = useState(false);
  return {
    filtros, setFiltros, limpiar, restablecer, abrirFicha: ficha.abrir, rangoInvalido, setRangoInvalido,
    buscadorRef, drawer: ficha.drawer,
  };
}

export default function PaginaTorre({ torre, titulo, subtitulo, acciones, children }: {
  torre: ContextoTorre;
  titulo: string;
  subtitulo: string;
  acciones?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const visibles = PAGINAS_TORRE.filter((p) => hasPage(user, p.slug));

  return (
    <div className="flex flex-col gap-4" data-torre="pagina">
      <PageHeaderCard title={titulo} subtitle={subtitulo} miga={[{ etiqueta: 'Torre de Control' }]} actions={acciones} />
      {visibles.length >= 2 && (
        <Pestanas etiqueta="Páginas de la Torre de Control" pestanas={visibles.map((p) => ({ id: p.slug, etiqueta: p.etiqueta, to: p.to }))} />
      )}
      <BarraFiltrosTorre filtros={torre.filtros} onCambio={torre.setFiltros} onLimpiar={torre.limpiar}
        onBuscarPlaca={torre.abrirFicha} buscadorRef={torre.buscadorRef} onRangoInvalido={torre.setRangoInvalido} />
      {children}
      {torre.drawer}
    </div>
  );
}

/** Tarjeta de bloque del molde (`card` + `card__cabeza`): h2, qué mide y qué filtro ignora. */
export function BloqueTorre({ titulo, subtitulo, accion, ancho = false, children, idPrueba }: {
  titulo: string; subtitulo?: string; accion?: ReactNode; ancho?: boolean; children: ReactNode; idPrueba?: string;
}) {
  return (
    <section className={`card min-w-0${ancho ? ' lg:col-span-2' : ''}`} aria-label={titulo} data-torre={idPrueba}>
      <div className="card__cabeza flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2>{titulo}</h2>
          {subtitulo && <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>{subtitulo}</p>}
        </div>
        {accion && <div className="flex flex-wrap items-center gap-2">{accion}</div>}
      </div>
      {children}
    </section>
  );
}

/** Rejillas del molde: cifras con auto-fit de 220 px, bloques a 2 columnas desde `lg`. */
export const REJILLA_KPI = 'grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-4';
export const REJILLA_2 = 'grid grid-cols-1 gap-4 lg:grid-cols-2';
