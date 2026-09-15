import { useRef, type ReactNode, type RefObject } from 'react';
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
  /**
   * Panel LATERAL: mismo diálogo modal (portal, velo, Esc del de más arriba, trampa y restauración
   * de foco), pegado al borde derecho y a alto completo. Lo único que cambia es la COLOCACIÓN.
   *
   * Es una variante de sitio, no un motor de diálogos nuevo (HU #12548, `docs/ux/
   * finanzas-reporte-costos-servicios-adicionales.md` §3.1): un panel propio duplicaría la trampa
   * de foco y sería la segunda de la app que hay que mantener en pareja. Por defecto `false`, así
   * que los ~90 ficheros que ya usan `FlitModal` pintan exactamente igual.
   *
   * Gana sobre `wide` y sobre `full`. Como en `full`, el cuerpo pierde el scroll propio: lo
   * gestiona el hijo, que es quien sabe qué parte suya desplaza (aquí la lista, no el pie).
   */
  lateral?: boolean;
  /**
   * Dónde dejar el foco al cerrar si el elemento que abrió el modal **ya no está en el DOM**
   * (HU #11562, AC8). Opcional: sin él, el comportamiento es el de siempre.
   *
   * Lo necesita cualquier modal que cambie la lista que hay debajo — gestionar un comparendo puede
   * sacar su fila del filtro puesto, y `.focus()` sobre esa fila desmontada no hace nada y deja el
   * foco en `<body>`. Apunta al encabezado de la lista (`tabIndex={-1}`).
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export default function FlitModal(
  { title, onClose, children, wide = false, full = false, lateral = false, restoreFocusRef }: FlitModalProps,
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Con un modal abierto encima de otro —el visor de documentos sobre el detalle de un SOAT—, Esc
  // cerraba LOS DOS: el listener está en `window`, así que llegaba a todos los modales montados.
  // Solo lo atiende el de más arriba, que se decide por el orden en el DOM: los portales se cuelgan
  // de <body> en el orden en que se abren, y con el mismo z-index gana el último, que es también el
  // que se ve encima. Cerrar el visor devuelve al detalle, que es lo que espera quien pulsa Esc.
  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) onClose();
  });
  // A11y (WCAG 2.4.3): foco entra al diálogo, se atrapa y se restaura al cerrar — al disparador si
  // sigue ahí, y si no al respaldo que le pasen (nunca a <body>).
  useFocusTrap(dialogRef, true, restoreFocusRef);
  return (
    // Colgado de <body>: dentro de `<main>` —que es un item flex— ningún z-index basta para pasar
    // por encima de la barra de navegación, y la cabecera con el botón de cerrar quedaba tapada en
    // cuanto el modal crecía. Ver ModalPortal.
    <ModalPortal>
    <div
      ref={overlayRef}
      // Marca de «hay un modal abierto aquí», para que Esc solo cierre el de más arriba.
      data-flit-modal=""
      // `flit-modal` repone el color de tinta que se pierde al colgar del <body>: fuera de
      // `.flit-app` el texto sin color propio heredaba el del tema Aura, que en oscuro es casi
      // blanco, sobre un modal cuyo fondo es claro pase lo que pase.
      className={
        'flit-modal fixed inset-0 z-[60] flex overflow-y-auto '
        + (lateral ? 'items-stretch justify-end' : 'items-center justify-center p-4 sm:p-6')
      }
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
          'flit-focus flex w-full flex-col '
          + (lateral
            ? 'h-[100dvh] max-w-[min(30rem,100vw)] overflow-hidden'
            : full
              ? 'my-auto h-[calc(100dvh-3rem)] max-w-[min(96rem,96vw)] overflow-hidden'
              : `my-auto max-h-[min(90vh,calc(100dvh-2rem))] overflow-y-auto ${wide ? 'max-w-2xl' : 'max-w-md'}`)
        }
        style={{
          background: 'var(--flit-bg-modal)',
          // Pegado al borde derecho, las esquinas de ese lado no existen: redondearlas dejaría dos
          // medias lunas de velo contra el borde de la ventana.
          borderRadius: lateral ? 'var(--flit-radius-xl) 0 0 var(--flit-radius-xl)' : 'var(--flit-radius-xl)',
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
            className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-flit-card"
            style={{ color: 'var(--flit-text-muted)' }}
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>
        <div className={full || lateral ? 'min-h-0 flex-1 px-6 py-4' : 'px-6 py-5'}>{children}</div>
      </div>
    </div>
    </ModalPortal>
  );
}
