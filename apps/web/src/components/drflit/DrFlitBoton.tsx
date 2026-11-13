import { forwardRef } from 'react';
import { Icono } from '../flit/kit/Icono';

// Botón flotante «Abrir Dr. Flit» (HU #13764). UI Kit 2026: disco azul relleno con el glifo
// `asistente` en blanco y la sombra del kit (flota como el dock). El glifo es decorativo: el nombre
// accesible es el `aria-label`. Conmuta (retrabajo #13764): con el panel abierto lo cierra; el estado lo comunica
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
        // Sobre el dock inferior del kit: nunca por debajo de su alto reservado, aunque una página fije
        // `--flit-fab-offset` con el alto de su barra (useFabOffset).
        'flit-focus fixed bottom-[calc(1rem+env(safe-area-inset-bottom)+max(var(--kit-alto-dock),var(--flit-fab-offset,0px)))] right-4 z-30',
        'lg:right-6',
        'inline-flex h-14 w-14 items-center justify-center rounded-full text-white shadow-[var(--kit-sombra)]',
        'transition-[background-color,filter]',
        abierto
          // Abierto: tinta del kit (estado activo del conmutador).
          ? 'bg-[var(--kit-tinta-fija)] hover:brightness-110 max-lg:hidden'
          : 'bg-[var(--kit-azul-relleno)] hover:brightness-90 active:brightness-90',
      ].join(' ')}
    >
      <Icono nombre="asistente" size={28} />
    </button>
  );
});

export default DrFlitBoton;
