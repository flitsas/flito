import { Icono } from './kit/Icono';

/**
 * Paginador del UI Kit 2026: texto gris, flechas del kit y página actual en círculo azul.
 * Modo cursor (`total` y `totalPaginas` omitidos): solo anterior/siguiente, con `hayAnterior`/`haySiguiente`.
 */
export default function Paginacion({
  total, page, totalPaginas, onPrev, onNext, sustantivo = 'registros', singular, hayAnterior, haySiguiente,
}: {
  total?: number; page: number; totalPaginas?: number;
  onPrev: () => void; onNext: () => void;
  sustantivo?: string;
  singular?: string;
  hayAnterior?: boolean;
  haySiguiente?: boolean;
}) {
  const cursor = total === undefined || totalPaginas === undefined;
  const puedeAtras = hayAnterior ?? page > 1;
  const puedeAdelante = haySiguiente ?? (!cursor && page < (totalPaginas ?? 1));
  return (
    <div className="kit-paginacion paginador" data-kit="paginacion">
      <span className="paginador__texto text-sm">
        {cursor ? (
          <>Página {page}</>
        ) : (
          <>
            <strong className="text-[color:var(--color-text-primary)]">{total.toLocaleString('es-CO')}</strong>{' '}
            {total === 1 && singular ? singular : sustantivo} · página {page} de {totalPaginas}
          </>
        )}
      </span>
      <div className="flex items-center gap-1">
        <button type="button" className="paginador__flecha grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-[var(--kit-hover)]" disabled={!puedeAtras} onClick={onPrev} aria-label="Página anterior">
          <Icono nombre="izquierda" size={18} />
        </button>
        <span className="paginador__num grid h-9 min-w-9 place-items-center rounded-full px-2 text-sm font-semibold" aria-current="page">{page}</span>
        <button type="button" className="paginador__flecha grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-[var(--kit-hover)]" disabled={!puedeAdelante} onClick={onNext} aria-label="Página siguiente">
          <Icono nombre="derecha" size={18} />
        </button>
      </div>
    </div>
  );
}
