import { forwardRef } from 'react';
import { MessageCircleQuestion } from 'lucide-react';

// Botón flotante «Abrir Dr. Flit» (HU #13764). Familia del dock (tarjeta, borde suave, sombra de
// tarjeta), sin gradiente para no competir con la primaria de la página. No conmuta: con el panel
// abierto lleva el foco al panel, así el nombre «Abrir Dr. Flit» nunca miente (spec UX).

export interface DrFlitBotonProps {
  abierto: boolean;
  panelId: string;
  onAbrir: () => void;
}

const DrFlitBoton = forwardRef<HTMLButtonElement, DrFlitBotonProps>(function DrFlitBoton(
  { abierto, panelId, onAbrir },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Abrir Dr. Flit"
      title="Abrir Dr. Flit"
      aria-expanded={abierto}
      aria-controls={panelId}
      onClick={onAbrir}
      className={[
        'flit-focus fixed bottom-[calc(1rem+env(safe-area-inset-bottom)+var(--flit-fab-offset,0px))] right-4 z-30',
        'lg:bottom-5 lg:right-6',
        'inline-flex h-12 w-12 items-center justify-center rounded-full border border-flit-soft',
        'transition-[color,background-color,box-shadow]',
        abierto
          // Abierto: velo «activo» sobre la tarjeta (con `bg-flit-app` el botón se veía transparente).
          ? 'bg-flit-card text-flit-ink shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)] max-lg:hidden'
          : 'bg-flit-card text-[color:var(--flit-blue-text)] shadow-[var(--flit-shadow-card)] hover:shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)] active:shadow-[inset_0_0_0_999px_var(--flit-bg-hover),var(--flit-shadow-card)]',
      ].join(' ')}
    >
      <MessageCircleQuestion size={22} aria-hidden="true" />
    </button>
  );
});

export default DrFlitBoton;
