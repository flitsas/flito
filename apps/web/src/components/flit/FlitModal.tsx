import { useRef, type ReactNode } from 'react';
import { useEscape, useBackdropClose, useFocusTrap } from '../../lib/hooks';
import { IconClose } from './icons';

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
}

export default function FlitModal({ title, onClose, children, wide = false }: FlitModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  // A11y (WCAG 2.4.3): foco entra al diálogo, se atrapa y se restaura al cerrar.
  useFocusTrap(dialogRef);
  return (
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
        className={`flit-focus my-auto w-full max-h-[min(90vh,calc(100dvh-2rem))] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`}
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
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
