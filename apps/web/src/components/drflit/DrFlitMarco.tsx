import { forwardRef, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

// Marco del panel de Dr. Flit (HU #13764). Va EAGER en el chunk del Layout junto al botón: así la
// cabecera, «Cerrar» y los estados de carga y error del contenido están disponibles desde el
// primer clic (spec UX, AC9). El contenido (`DrFlitPanel`) llega por `lazy()` (AC8).
//
// No modal (AC3/AC7): `<aside>` complementario, sin `role="dialog"`, sin `aria-modal`, sin trampa
// de foco ni bloqueo del fondo. Esc se maneja AQUÍ y no en `window` (AC4): con un diálogo de página
// abierto el foco está dentro de él, así que Esc lo cierra a él y no al panel.

export const DRFLIT_PANEL_ID = 'drflit-panel';
export const DRFLIT_TITULO_ID = 'drflit-titulo';
/** Hueco de la cabecera donde el panel (lazy) monta «Terminar chat» con un portal (HU #13767). */
export const DRFLIT_ACCIONES_ID = 'drflit-acciones';

export interface DrFlitMarcoProps {
  abierto: boolean;
  onCerrar: () => void;
  children: ReactNode;
}

const DrFlitMarco = forwardRef<HTMLHeadingElement, DrFlitMarcoProps>(function DrFlitMarco(
  { abierto, onCerrar, children },
  tituloRef,
) {
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onCerrar();
  };

  return (
    <aside
      id={DRFLIT_PANEL_ID}
      aria-labelledby={DRFLIT_TITULO_ID}
      hidden={!abierto}
      onKeyDown={onKeyDown}
      className={[
        'fixed inset-x-0 bottom-0 top-[var(--flit-topbar-height)] z-20 flex min-w-0 flex-col',
        'border-t border-flit-soft bg-flit-card text-flit-ink shadow-[var(--flit-shadow-modal)]',
        'lg:left-auto lg:right-6 lg:top-[calc(var(--flit-topbar-height)+1rem)] lg:bottom-[5.5rem] lg:w-[25rem]',
        'lg:rounded-flit-lg lg:border',
        // `hidden` del atributo debe ganarle a `flex`.
        '[&[hidden]]:hidden',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-flit-soft px-4 py-3">
        <div className="min-w-0">
          <h2
            ref={tituloRef}
            id={DRFLIT_TITULO_ID}
            tabIndex={-1}
            className="flit-focus rounded-md text-base font-semibold text-flit-ink"
          >
            Dr. Flit
          </h2>
          <p className="text-xs text-flit-secondary">Le respondo con la Ayuda FLITO.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div id={DRFLIT_ACCIONES_ID} className="contents" />
          <button
            type="button"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onCerrar}
            className="flit-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-flit-secondary transition-colors hover:bg-[var(--flit-bg-hover)] hover:text-flit-ink lg:h-8 lg:w-8"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {children}
    </aside>
  );
});

export default DrFlitMarco;

/** Estado de carga del contenido (Suspense fallback). */
export function DrFlitCargando() {
  return (
    <div className="flex-1 px-4 py-4">
      <p role="status" className="text-sm text-flit-secondary">Abriendo Dr. Flit…</p>
    </div>
  );
}

/** Estado de error del contenido: falla la descarga del código del panel. */
export function DrFlitErrorCarga({ onReintentar }: { onReintentar: () => void }) {
  return (
    <div className="flex-1 px-4 py-4">
      <div role="status" className="rounded-flit-lg border border-flit-soft bg-flit-app p-4 text-sm">
        <p className="font-semibold text-[color:var(--flit-danger-ink)]">No se pudo abrir Dr. Flit.</p>
        <p className="mt-1 text-flit-ink">Revise su conexión e intente de nuevo.</p>
        <button
          type="button"
          onClick={onReintentar}
          className="flit-focus mt-3 inline-flex h-10 items-center gap-2 rounded-[999px] border bg-flit-card px-5 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
