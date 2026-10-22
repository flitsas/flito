import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import { DRFLIT_ACCIONES_ID } from './DrFlitMarco';

// Dr. Flit — «Terminar chat» (HU #13767 AC2; spec UX «Conversación restaurada y Terminar chat»).
// El botón va en la cabecera del marco (eager) mediante un portal al hueco `DRFLIT_ACCIONES_ID`: así
// el orden de tabulación es Terminar chat → Cerrar → conversación, sin subir el estado al montaje.
// La confirmación es EN LÍNEA bajo la cabecera (no modal: el panel tampoco lo es), con foco en
// «Cancelar» (la opción segura) y Esc = Cancelar antes de que el marco cierre el panel.

const CONFIRMAR_TITULO_ID = 'drflit-terminar-titulo';

export function DrFlitBotonTerminar({ onPedir, expandido, botonRef }: {
  onPedir: () => void;
  expandido: boolean;
  botonRef: RefObject<HTMLButtonElement>;
}) {
  const [hueco, setHueco] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHueco(document.getElementById(DRFLIT_ACCIONES_ID));
  }, []);
  if (!hueco) return null;
  return createPortal(
    <button
      ref={botonRef}
      type="button"
      onClick={onPedir}
      aria-expanded={expandido}
      className={flitBtnSecondarySm}
    >
      Terminar chat
    </button>,
    hueco,
  );
}

export function DrFlitConfirmarTerminar({ onConfirmar, onCancelar, conBorrador = false }: {
  onConfirmar: () => void;
  onCancelar: () => void;
  /** HU #13806: hay un caso de soporte sin enviar; también se borra (anexo UX F5.11). */
  conBorrador?: boolean;
}) {
  const cancelarRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelarRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // El marco cierra el panel con Esc solo si nadie lo consumió antes.
    e.preventDefault();
    onCancelar();
  };

  return (
    <div
      role="group"
      aria-labelledby={CONFIRMAR_TITULO_ID}
      onKeyDown={onKeyDown}
      className="border-b border-flit-soft bg-flit-app px-4 py-3 text-sm text-flit-ink"
    >
      <p id={CONFIRMAR_TITULO_ID} className="font-semibold">¿Terminar el chat?</p>
      <p className="mt-1 text-flit-secondary">
        {conBorrador
          ? 'Se borrarán esta conversación y el caso que no ha enviado, y no podrá recuperarlos.'
          : 'Se borrará esta conversación y no podrá recuperarla.'}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onConfirmar}
          className={flitBtnSecondarySm}
          // Color en línea a propósito (patrón del kit para «peligro»): una clase de texto empataría
          // con la tinta secundaria del kit. El hover sigue dando fondo.
          style={{ color: 'var(--flit-danger-ink)' }}
        >
          Sí, terminar
        </button>
        <button ref={cancelarRef} type="button" onClick={onCancelar} className={flitBtnSecondarySm}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
