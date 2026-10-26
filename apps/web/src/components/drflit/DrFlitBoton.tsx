import { forwardRef } from 'react';
import { DR_FLIT_ASSETS } from './drFlitAssets';

// Botón flotante «Abrir Dr. Flit» (HU #13764). Familia del dock (tarjeta, borde suave, sombra de
// tarjeta), sin gradiente para no competir con la primaria de la página. Lleva el avatar oficial
// (robot saludando, mismo asset que FLIT 2) como imagen decorativa: el nombre accesible es el
// `aria-label`. Conmuta (retrabajo #13764): con el panel abierto lo cierra; el estado lo comunica
// `aria-expanded`. El `aria-label` no cambia —E2E y otras sesiones dependen de él—; el `title`
// sí («Cerrar Dr. Flit») para quien usa el ratón. <lg se oculta con el panel abierto (F3).

export interface DrFlitBotonProps {
  abierto: boolean;
  panelId: string;
  /** Con el panel cerrado, lo abre; abierto, lo cierra. */
  onAlternar: () => void;
}

const DrFlitBoton = forwardRef<HTMLButtonElement, DrFlitBotonProps>(function DrFlitBoton(
  { abierto, panelId, onAlternar },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Abrir Dr. Flit"
      title={abierto ? 'Cerrar Dr. Flit' : 'Abrir Dr. Flit'}
      aria-expanded={abierto}
      aria-controls={panelId}
      onClick={onAlternar}
      className={[
        'flit-focus fixed bottom-[calc(1rem+env(safe-area-inset-bottom)+var(--flit-fab-offset,0px))] right-4 z-30',
        'lg:bottom-5 lg:right-6',
        'inline-flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-flit-soft p-1',
        'transition-[color,background-color,box-shadow]',
        abierto
          // Abierto: velo «activo» sobre la tarjeta (con `bg-flit-app` el botón se veía transparente).
          ? 'bg-flit-card text-flit-ink shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)] max-lg:hidden'
          : 'bg-flit-card text-[color:var(--flit-blue-text)] shadow-[var(--flit-shadow-card)] hover:shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)] active:shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)]',
      ].join(' ')}
    >
      <img
        src={DR_FLIT_ASSETS.fab}
        alt=""
        aria-hidden="true"
        width={245}
        height={256}
        draggable={false}
        className="h-full w-full object-contain"
      />
    </button>
  );
});

export default DrFlitBoton;
