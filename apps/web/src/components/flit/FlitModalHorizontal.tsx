import { useRef, type ReactNode, type RefObject, type UIEvent } from 'react';
import { useBackdropClose, useEscape, useFocusTrap } from '../../lib/hooks';
import ModalPortal from './ModalPortal';
import { Icono } from './kit/Icono';

/**
 * Modal de detalle APAISADO del UI Kit 2026 (`kit-modal--horizontal`; UX `docs/ux/flito-tramites-rediseno.md` §8,
 * maqueta aprobada `docs/ux/mockups/flito-tramites-rediseno.html`). Siempre más ancho que alto desde `lg`:
 * cabecera en fila (antetítulo · título · chips · navegación · ✕, SIN placa), un lateral de contexto en texto y
 * enlaces (+ índice opcional) y el contenido, cada columna con su scroll. Por debajo de `lg`, pantalla completa
 * con un solo scroll en el orden lateral → índice sticky → contenido.
 *
 * NO pinta pie de acciones: las acciones viven en el `bloque-cabeza` / `acciones-fila` del bloque principal, que
 * pinta quien lo usa. Los submodales siguen en `FlitModal`, que no cambia.
 *
 * Nombre accesible: `nombreAccesible` (aria-label; p. ej. «SOAT · MNB22F», que usan los E2E aunque el título visible
 * sea «SOAT») o, si no se da, `aria-labelledby` sobre el título (`tituloId`).
 */
export interface FlitModalHorizontalProps {
  nombreAccesible?: string;
  titulo: ReactNode;
  /** Id del `h2` del título. Obligatorio si no hay `nombreAccesible`. */
  tituloId?: string;
  /** Texto pequeño sobre el título (p. ej. «Gestión Trámites · 4 de 128»), anunciado con `aria-live="polite"`. */
  antetitulo?: ReactNode;
  /** Chips de estado de la zona 1, en la línea del título. */
  chips?: ReactNode;
  /** ‹ Anterior / Siguiente › (botones `ghost sm`). */
  navegacion?: ReactNode;
  lateral: ReactNode;
  etiquetaLateral: string;
  /** `nav` de secciones, debajo del lateral (sticky arriba por debajo de `lg`). */
  indice?: ReactNode;
  children: ReactNode;
  etiquetaContenido: string;
  contenidoRef?: RefObject<HTMLElement | null>;
  /** Se llama con el elemento que desplaza: `.kit-modal__contenido` desde `lg`, `.kit-modal__columnas` por debajo. */
  onScrollContenido?: (desplaza: HTMLElement) => void;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  cierreBloqueado?: boolean;
  /** Falso mientras otro diálogo está encima: la trampa de foco se le cede. */
  trampaActiva?: boolean;
}

export default function FlitModalHorizontal({
  nombreAccesible, titulo, tituloId, antetitulo, chips, navegacion, lateral, etiquetaLateral, indice, children,
  etiquetaContenido, contenidoRef, onScrollContenido, onClose: onCloseProp, restoreFocusRef, cierreBloqueado = false,
  trampaActiva = true,
}: FlitModalHorizontalProps) {
  const onClose = () => { if (!cierreBloqueado) onCloseProp(); };
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Escape cierra solo el modal de más arriba (los modales se apilan en <body> por orden de montaje).
  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) onClose();
  });
  useFocusTrap(dialogRef, trampaActiva, restoreFocusRef);
  const alDesplazar = onScrollContenido ? (e: UIEvent<HTMLElement>) => onScrollContenido(e.currentTarget) : undefined;
  return (
    <ModalPortal>
      <div ref={overlayRef} data-flit-modal="" className="flit-modal kit-velo items-center justify-center p-0 lg:p-6"
        {...useBackdropClose(onClose)}>
        <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}
          aria-label={nombreAccesible} aria-labelledby={nombreAccesible ? undefined : tituloId}
          onClick={(e) => e.stopPropagation()}
          className="kit-modal kit-modal--horizontal my-auto outline-none">
          <div className="kit-modal__cabeza">
            <div className="kit-modal__cabeza-texto">
              {antetitulo && <small className="kit-modal__ante" aria-live="polite">{antetitulo}</small>}
              <div className="kit-modal__cabeza-linea">
                <h2 id={tituloId} className="kit-modal__titulo tabular-nums">{titulo}</h2>
                {chips}
              </div>
            </div>
            {navegacion && <div className="kit-modal__cabeza-nav">{navegacion}</div>}
            <button type="button" onClick={onClose} aria-label="Cerrar" disabled={cierreBloqueado} className="kit-modal__cerrar flit-focus">
              <Icono nombre="cerrar" size={20} />
            </button>
          </div>
          {/* Columnas con scroll propio = regiones enfocables (`scrollable-region-focusable`), foco del kit. */}
          <div className="kit-modal__columnas" onScroll={alDesplazar}>
            <section className="kit-modal__lateral flit-focus-inset" role="region" tabIndex={0} aria-label={etiquetaLateral}>
              {lateral}
            </section>
            {indice}
            <section ref={contenidoRef as RefObject<HTMLElement>} className="kit-modal__contenido flit-focus-inset" role="region"
              tabIndex={0} aria-label={etiquetaContenido} onScroll={alDesplazar}>
              {children}
            </section>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
