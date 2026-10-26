// Menú ⋮ de acciones de una fila (HU #13949). Diseño: `docs/ux/clientes-menu-estado-13949-slim.md`.
//
// Genérico y sin dominio: Clientes lo estrena y Proveedores (#13961/#13962) y Eliminar (#13956) lo
// reutilizan tal cual. Calca el aspecto del menú de usuario de `FlitTopbar` (tarjeta, radio md,
// borde suave, sombra de tarjeta, ítems `px-3 py-2 text-sm` con hover `--flit-bg-hover`), pero no
// lo clona: aquel no tiene flechas ni foco itinerante, y este los necesita (AC8).
//
// El panel cuelga de <body> (portal) con `position: fixed`: dentro del scroll horizontal de
// `FlitTable` quedaría recortado. Se coloca alineado al borde derecho del ⋮, hacia abajo; si no
// cabe, hacia arriba; y nunca se sale del viewport en 360 px.
//
// Teclado (patrón «menu button» de WAI-ARIA):
//   ⋮ cerrado — Enter / Espacio / ↓ abren y enfocan el primer ítem; ↑ abre y enfoca el último.
//   Abierto   — ↑/↓ circulares, Inicio/Fin, Enter/Espacio eligen, Esc cierra y devuelve el foco al
//               ⋮, Tab cierra y sigue el orden normal; clic fuera cierra.
// Al elegir, el foco vuelve al ⋮ ANTES de ejecutar la opción: así el diálogo que abra la opción
// (FlitModal) toma el ⋮ como disparador y le devuelve el foco al cerrarse.

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface OpcionMenuFila {
  id: string;
  /** «Desactivar», «Activar», «Eliminar». */
  texto: string;
  onElegir: () => void;
  /** `peligro`: tinta `--flit-danger-text` (par oscuro definido) y separada por un divisor arriba. */
  tono?: 'normal' | 'peligro';
  /**
   * HU #13956: la opción se ve y se ENFOCA, pero no se elige (`aria-disabled`, no `disabled`
   * nativo: un ítem `disabled` no recibe foco y su motivo no se alcanzaría con teclado).
   */
  deshabilitada?: boolean;
  /**
   * Texto secundario bajo la opción («Primero debe desactivarlo.»). Visible —no un `title`, que no
   * llega ni al teclado ni al tacto— y asociado a la opción por `aria-describedby` (AC6 de #13956).
   */
  motivo?: string;
  /** `false`: elegirla no cierra el menú (p. ej. reintentar una comprobación). Por defecto `true`. */
  cierra?: boolean;
}

interface Props {
  /** `aria-label` del ⋮: «Acciones de Acme S.A.S.». */
  etiqueta: string;
  /** Vacío → no se pinta nada (nunca un ⋮ que abre un menú vacío). */
  opciones: OpcionMenuFila[];
  /** Al abrir el menú (HU #13956: Clientes pide ahí si el cliente se puede eliminar). */
  onAbrir?: () => void;
}

const ANCHO_PANEL = 192; // px; coincide con `w-48`.
const MARGEN = 8;

interface Posicion { top: number; left: number }

export function MenuFila({ etiqueta, opciones, onAbrir }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(0);
  const [pos, setPos] = useState<Posicion | null>(null);
  const refBoton = useRef<HTMLButtonElement>(null);
  const refPanel = useRef<HTMLDivElement>(null);
  const refItems = useRef<(HTMLButtonElement | null)[]>([]);
  const idPanel = useId();

  const cerrar = (devolverFoco: boolean) => {
    setAbierto(false);
    setPos(null);
    if (devolverFoco) refBoton.current?.focus();
  };

  const abrir = (indice: number) => {
    setActivo(indice);
    setAbierto(true);
    onAbrir?.();
  };

  // Si el contenido cambia con el menú abierto (llega un motivo), se vuelve a colocar.
  const firma = opciones.map((o) => `${o.id}|${o.motivo ?? ''}`).join('·');

  // Posición: alineado al borde derecho del ⋮, abajo; arriba si no cabe. Se mide tras pintar el panel.
  useLayoutEffect(() => {
    if (!abierto) return;
    const colocar = () => {
      const b = refBoton.current?.getBoundingClientRect();
      const alto = refPanel.current?.offsetHeight ?? 0;
      if (!b) return;
      const ancho = Math.min(ANCHO_PANEL, window.innerWidth - 2 * MARGEN);
      let left = b.right - ancho;
      left = Math.max(MARGEN, Math.min(left, window.innerWidth - ancho - MARGEN));
      let top = b.bottom + 4;
      if (top + alto > window.innerHeight - MARGEN && b.top - alto - 4 >= MARGEN) top = b.top - alto - 4;
      setPos({ top, left });
    };
    colocar();
    // Si la página o la tabla se desplazan, el ⋮ se mueve y el panel lo sigue (captura: el scroll
    // horizontal de `FlitTable` no burbujea hasta `window`).
    window.addEventListener('resize', colocar);
    window.addEventListener('scroll', colocar, true);
    return () => {
      window.removeEventListener('resize', colocar);
      window.removeEventListener('scroll', colocar, true);
    };
  }, [abierto, firma]);

  // Foco itinerante: el ítem activo recibe el foco real.
  useEffect(() => {
    if (abierto && pos) refItems.current[activo]?.focus();
  }, [abierto, pos, activo]);

  // Clic fuera cierra (sin robar el foco a lo que se pulsó).
  useEffect(() => {
    if (!abierto) return;
    const alPulsar = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refPanel.current?.contains(t) || refBoton.current?.contains(t)) return;
      cerrar(false);
    };
    document.addEventListener('mousedown', alPulsar);
    return () => document.removeEventListener('mousedown', alPulsar);
  }, [abierto]);

  if (opciones.length === 0) return null;

  const elegir = (o: OpcionMenuFila) => {
    if (o.deshabilitada) return;
    if (o.cierra !== false) cerrar(true);
    o.onElegir();
  };

  const teclaBoton = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (abierto) cerrar(true); else abrir(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      abrir(opciones.length - 1);
    }
  };

  const teclaPanel = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = opciones.length;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActivo((i) => (i + 1) % n); break;
      case 'ArrowUp': e.preventDefault(); setActivo((i) => (i - 1 + n) % n); break;
      case 'Home': e.preventDefault(); setActivo(0); break;
      case 'End': e.preventDefault(); setActivo(n - 1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); cerrar(true); break;
      case 'Tab':
        // Tab sigue el orden normal desde el ⋮: se le devuelve el foco y el navegador avanza.
        cerrar(false);
        refBoton.current?.focus();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        elegir(opciones[activo]);
        break;
      default: break;
    }
  };

  return (
    <>
      <button
        ref={refBoton}
        type="button"
        aria-label={etiqueta}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls={abierto ? idPanel : undefined}
        onClick={() => (abierto ? cerrar(true) : abrir(0))}
        onKeyDown={teclaBoton}
        className="flit-focus inline-grid h-10 w-10 shrink-0 place-items-center rounded-[999px] border bg-flit-card transition-colors hover:bg-[var(--flit-bg-hover)]"
        style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
      >
        <MoreVertical size={18} aria-hidden="true" />
      </button>
      {abierto && createPortal(
        <div
          ref={refPanel}
          id={idPanel}
          role="menu"
          aria-label={etiqueta}
          onKeyDown={teclaPanel}
          // Hasta medir, invisible: así no parpadea en (0,0).
          className="fixed z-[55] w-48 max-w-[calc(100vw-2rem)] overflow-hidden bg-flit-card p-1"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
            borderRadius: 'var(--flit-radius-md)',
            border: '1px solid var(--flit-border-soft)',
            boxShadow: 'var(--flit-shadow-card)',
          }}
        >
          {opciones.map((o, i) => {
            const idTexto = `${idPanel}-${o.id}-texto`;
            const idMotivo = `${idPanel}-${o.id}-motivo`;
            const tinta = o.deshabilitada
              ? 'var(--flit-text-muted)'
              : o.tono === 'peligro' ? 'var(--flit-danger-text)' : 'var(--flit-text-primary)';
            return (
            <Fragment key={o.id}>
              {o.tono === 'peligro' && i > 0 && (
                <div role="separator" className="my-1 border-t" style={{ borderColor: 'var(--flit-border-soft)' }} />
              )}
              <button
                ref={(el) => { refItems.current[i] = el; }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={o.deshabilitada ? true : undefined}
                aria-labelledby={idTexto}
                aria-describedby={o.motivo ? idMotivo : undefined}
                onClick={() => elegir(o)}
                onMouseEnter={() => setActivo(i)}
                className={
                  'flit-focus flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--flit-bg-hover)]'
                  + (i === activo ? ' bg-[var(--flit-bg-hover)]' : '')
                  + (o.deshabilitada ? ' cursor-not-allowed' : '')
                }
                style={{ color: tinta }}
              >
                <span id={idTexto}>{o.texto}</span>
                {o.motivo && (
                  <span id={idMotivo} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{o.motivo}</span>
                )}
              </button>
            </Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

export default MenuFila;
