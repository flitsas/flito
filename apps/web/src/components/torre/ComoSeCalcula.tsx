// Torre de Control (Épica #14590, spec UX §4.1 y §10) — «¿Cómo se calcula?»: disclosure DENTRO de la tarjeta (no un
// popover, como en la maqueta aprobada `torre-kpi-explicable.html`). Botón con `aria-expanded`/`aria-controls`; la región
// desplegada lleva `id` sin `role` extra. Esc (con el foco en la tarjeta) lo cierra y el foco vuelve al botón.
// El texto viene del API (`explicaciones[…].definicion` = `CONJUNTOS_TORRE[c].definicion`): aquí no se escribe ninguno.
import { useId, useRef, useState, type KeyboardEvent } from 'react';

/** Clase de los controles con peso de enlace de la KPI (tamaño pequeño, ninguno es primaria). */
export const ENLACE_KPI = 'flit-focus inline-flex items-center gap-1 rounded-md px-1.5 py-1 -mx-1.5 -my-1 text-xs font-semibold '
  + 'no-underline transition-colors hover:bg-[var(--kit-hover)] hover:underline hover:underline-offset-[3px]';

export function useComoSeCalcula() {
  const id = `def-${useId().replace(/:/g, '')}`;
  const [abierto, setAbierto] = useState(false);
  const botonRef = useRef<HTMLButtonElement>(null);
  /** Para la tarjeta que contiene botón y región: Esc cierra y devuelve el foco. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && abierto) {
      e.stopPropagation();
      setAbierto(false);
      botonRef.current?.focus();
    }
  };
  return { id, abierto, alternar: () => setAbierto((v) => !v), botonRef, onKeyDown };
}

export function BotonComoSeCalcula({ id, abierto, alternar, botonRef }: Pick<ReturnType<typeof useComoSeCalcula>, 'id' | 'abierto' | 'alternar' | 'botonRef'>) {
  return (
    <button ref={botonRef} type="button" aria-expanded={abierto} aria-controls={id} onClick={alternar} data-torre="como-se-calcula"
      className={`${ENLACE_KPI} font-medium text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-action)]`}>
      ¿Cómo se calcula? <span aria-hidden="true">{abierto ? '▴' : '▾'}</span>
    </button>
  );
}

export function DefinicionCalculo({ id, abierto, definicion }: { id: string; abierto: boolean; definicion: string }) {
  return (
    <p id={id} hidden={!abierto} data-torre="definicion"
      className="m-0 mt-1 border-t border-[color:var(--color-divider)] pt-2.5 text-xs leading-normal text-[color:var(--color-text-secondary)]">
      {definicion}
    </p>
  );
}
