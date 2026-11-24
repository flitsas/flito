import { forwardRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icono } from '../flit/kit/Icono';
import { Cargador } from '../flit/Cargador';
import GradientButton from '../flit/GradientButton';

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
        // Menú flotante del kit: superficie elevada, borde 1 px, radio 9 y la sombra del kit.
        'overflow-hidden border-t border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] text-flit-ink shadow-[var(--kit-sombra)]',
        // ≥lg: entre la barra y el botón flotante, que queda sobre el dock (alto dock + 1rem + 56 px + 0,75rem).
        'lg:left-auto lg:right-6 lg:top-[calc(var(--flit-topbar-height)+1rem)] lg:bottom-[calc(var(--kit-alto-dock)+1.75rem+3.5rem)] lg:w-[25rem]',
        'lg:rounded-[9px] lg:border',
        // `hidden` del atributo debe ganarle a `flex`.
        '[&[hidden]]:hidden',
      ].join(' ')}
    >
      <header className="dock__cabeza mb-0 shrink-0 flex-wrap justify-between gap-2 sm:flex-nowrap">
        <div className="flex min-w-0 items-center gap-3 sm:flex-1">
          <span className="kico" aria-hidden="true"><Icono nombre="asistente" /></span>
          <div className="min-w-0">
            <h2
              ref={tituloRef}
              id={DRFLIT_TITULO_ID}
              tabIndex={-1}
              className="flit-focus-light rounded-md text-base font-semibold text-inherit"
            >
              Dr. Flit
            </h2>
            <p className="text-xs opacity-85">Le respondo con la Ayuda FLITO.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div id={DRFLIT_ACCIONES_ID} className="contents" />
          <button
            type="button"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onCerrar}
            className="flit-focus-light inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-inherit transition-colors hover:bg-[color-mix(in_srgb,var(--kit-tinta-fija)_30%,transparent)] lg:h-9 lg:w-9"
          >
            <Icono nombre="cerrar" size={18} />
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
    <div className="flex flex-1 items-center justify-center px-4 py-4">
      <Cargador texto="Abriendo Dr. Flit…" />
    </div>
  );
}

/** Estado de error del contenido: falla la descarga del código del panel. */
export function DrFlitErrorCarga({ onReintentar }: { onReintentar: () => void }) {
  return (
    <div className="flex-1 px-4 py-4">
      <div role="status" className="rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="flex items-start gap-2 font-semibold text-[color:var(--kit-rojo-texto)]">
          <Icono nombre="alerta" size={16} className="mt-0.5 shrink-0" />
          No se pudo abrir Dr. Flit.
        </p>
        <p className="mt-1 text-flit-ink">Revise su conexión e intente de nuevo.</p>
        <GradientButton type="button" variant="secondary" size="sm" onClick={onReintentar} className="mt-3">
          Reintentar
        </GradientButton>
      </div>
    </div>
  );
}
