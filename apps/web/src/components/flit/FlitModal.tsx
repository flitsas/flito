import { useRef, type ReactNode, type RefObject } from 'react';
import { useEscape, useBackdropClose, useFocusTrap } from '../../lib/hooks';
import ModalPortal from './ModalPortal';
import { Icono, type NombreIcono } from './kit/Icono';

/**
 * Modal del UI Kit 2026 (`dialog.modal` de la propuesta; Modal de flit develop packages/ui): velo azul al 50 % con
 * desenfoque de 5 px, contenedor blanco con borde y sin sombra, cabecera centrada con ícono de 52 px, título azul
 * de 22 px y la X de 36 px arriba a la derecha. `lateral` es el panel lateral (Drawer) con el mismo estilo.
 */
interface FlitModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  full?: boolean;
  lateral?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  cierreBloqueado?: boolean;
  /** Glifo del kit en disco de 52 px sobre el título (por defecto ninguno). */
  icono?: NombreIcono;
  /** Antetítulo gris pequeño sobre el título (p. ej. «Detalle»). */
  antetitulo?: string;
}

export default function FlitModal(
  { title, onClose: onCloseProp, children, wide = false, full = false, lateral = false, restoreFocusRef, cierreBloqueado = false, icono, antetitulo }: FlitModalProps,
) {
  const onClose = () => { if (!cierreBloqueado) onCloseProp(); };
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Escape cierra solo el modal de más arriba (los modales se apilan en <body> por orden de montaje).
  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) onClose();
  });
  useFocusTrap(dialogRef, true, restoreFocusRef);
  return (
    <ModalPortal>
    <div
      ref={overlayRef}
      data-flit-modal=""
      className={'flit-modal kit-velo ' + (lateral ? 'items-stretch justify-end' : 'items-center justify-center p-3 sm:p-6')}
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
          'kit-modal outline-none '
          + (lateral
            ? 'kit-modal--lateral max-w-[min(30rem,100vw)] overflow-hidden'
            : full
              ? 'my-auto h-[calc(100dvh-3rem)] max-w-[min(96rem,96vw)] overflow-hidden'
              : `my-auto max-h-[min(90vh,calc(100dvh-2rem))] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`)
        }
      >
        <div className="kit-modal__cabeza">
          {icono && <Icono nombre={icono} disco size={52} />}
          <div className="min-w-0">
            {antetitulo && <small className="kit-modal__ante">{antetitulo}</small>}
            <h2 className="kit-modal__titulo">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" disabled={cierreBloqueado} className="kit-modal__cerrar">
            <Icono nombre="cerrar" size={20} />
          </button>
        </div>
        <div className={'kit-modal__cuerpo' + (full || lateral ? ' min-h-0 flex-1 overflow-y-auto' : '')}>{children}</div>
      </div>
    </div>
    </ModalPortal>
  );
}
