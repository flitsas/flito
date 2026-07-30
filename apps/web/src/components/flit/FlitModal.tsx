import { useRef, type ReactNode } from 'react';
import { useEscape, useBackdropClose, useFocusTrap } from '../../lib/hooks';
import { IconClose } from './icons';
import ModalPortal from './ModalPortal';

// FlitModal — modal del prototipo FLIT (p.9): overlay azulado desenfocado,
// contenedor claro `#EEF5FF`, radio amplio, cierre X arriba a la derecha.
// Conserva el comportamiento previo (Esc + click backdrop) vía hooks compartidos.
// Reutilizable en Fases 4+ (trámites, etc.).
interface FlitModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Modal ancho (pasaporte, tablas). Default compacto. */
  wide?: boolean;
  /**
   * Casi toda la pantalla, para contenido que se lee mal en poco espacio: un PDF a 448 px de ancho
   * no se puede leer sin hacer zoom. El cuerpo pierde el scroll propio y lo gestiona el hijo, que
   * es quien sabe cuánto mide. Gana sobre `wide`.
   */
  full?: boolean;
}

export default function FlitModal({ title, onClose, children, wide = false, full = false }: FlitModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  // A11y (WCAG 2.4.3): foco entra al diálogo, se atrapa y se restaura al cerrar.
  useFocusTrap(dialogRef);
  return (
    // Colgado de <body>: dentro de `<main>` —que es un item flex— ningún z-index basta para pasar
    // por encima de la barra de navegación, y la cabecera con el botón de cerrar quedaba tapada en
    // cuanto el modal crecía. Ver ModalPortal.
    <ModalPortal>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto p-4 sm:p-6"
      style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }}
      {...useBackdropClose(onClose)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={
          'flit-focus my-auto flex w-full flex-col '
          + (full
            ? 'h-[calc(100dvh-3rem)] max-w-[min(96rem,96vw)] overflow-hidden'
            : `max-h-[min(90vh,calc(100dvh-2rem))] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`)
        }
        style={{
          background: 'var(--flit-bg-modal)',
          borderRadius: 'var(--flit-radius-xl)',
          boxShadow: 'var(--flit-shadow-modal)',
          border: '1px solid var(--flit-border-soft)',
        }}
      >
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
          <h2 className="text-lg font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-white"
            style={{ color: 'var(--flit-text-muted)' }}
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>
        <div className={full ? 'min-h-0 flex-1 px-6 py-4' : 'px-6 py-5'}>{children}</div>
      </div>
    </div>
    </ModalPortal>
  );
}
