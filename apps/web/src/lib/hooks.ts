import { useEffect, useRef, type RefObject } from 'react';

/**
 * Cierra un modal/diálogo cuando el usuario presiona ESC.
 * Solo se aplica si `enabled` es true (típicamente cuando el modal está abierto).
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  // Usamos ref para evitar re-suscribir el listener si el handler cambia entre renders.
  const handlerRef = useRef(onEscape);
  useEffect(() => { handlerRef.current = onEscape; }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handlerRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}

/**
 * Hook deshabilitado a propósito: los modales del sistema ya no se cierran
 * al hacer click en el backdrop. El usuario reportó cierres accidentales
 * que perdían datos. Solo se cierra con botón ✕ o tecla ESC.
 *
 * Se mantiene la firma para no tocar los call sites; retorna un objeto vacío.
 */
export function useBackdropClose(_onClose: () => void): Record<string, never> {
  void _onClose;
  return {};
}

/**
 * Cuántos fotogramas se vigila el foco tras cerrar un diálogo (ver la limpieza de `useFocusTrap`).
 *
 * No es un número mágico de conveniencia: el árbol que había detrás del diálogo puede seguir
 * cambiando durante uno o dos fotogramas después de que el diálogo se desmonte, y el foco se pierde
 * en ese hueco. Tres deja margen para el caso medido —el disparador desaparece en el segundo— sin
 * dejar abierta una ventana que se note.
 */
const FOTOGRAMAS_DE_GRACIA = 3;

/**
 * Plazo máximo, en milisegundos, desde que se cierra el diálogo hasta que la vigilancia deja de
 * tener derecho a mover el foco.
 *
 * Tres fotogramas son ~48 ms con la pestaña a la vista, así que 250 ms sobran de largo para una
 * máquina lenta y siguen estando dentro del mismo gesto. Su razón de ser es la pestaña OCULTA, donde
 * los fotogramas no llegan nunca: ahí lo que acota la ventana es el reloj, no el contador.
 */
const MS_DE_GRACIA = 250;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Atrapa el foco dentro de `containerRef` mientras `enabled` (WCAG 2.4.3 / 2.1.2):
 * - Al activarse, mueve el foco al contenedor (que debe tener `tabIndex={-1}`),
 *   para que el lector de pantalla anuncie el diálogo y el Tab empiece arriba.
 * - Cicla el foco con Tab/Shift+Tab sin salir del contenedor.
 * - Al desmontarse/desactivarse, restaura el foco al elemento previo (el disparador) y, si ese
 *   elemento ya no está en el DOM, al `respaldoRef` que le pasen.
 *
 * Pensado para FlitModal y cualquier diálogo compartido. No cierra con backdrop
 * (decisión de producto en useBackdropClose) — el cierre es ✕ o Esc.
 *
 * ── Sobre `enabled`, que es donde esto se rompe (HU #11562) ──────────────────────────────────────
 * NO lo condiciones a que los datos del diálogo hayan cargado. Es tentador —el esqueleto no tiene
 * nada enfocable— pero el efecto se vuelve a ejecutar cuando `enabled` pasa a `true`, y para
 * entonces el foco ya está DENTRO del diálogo: `previouslyFocused` captura el propio contenedor y
 * al cerrar el foco se queda en un nodo desmontado, es decir en `<body>`. El diálogo se monta con
 * la trampa puesta desde el primer render, cargando o no.
 *
 * ── Sobre `respaldoRef` (nota QA #63 de `docs/ux/flito-comparendos-visor.md`) ────────────────────
 * `.focus()` sobre un nodo que ya no está en el documento es un **no-op silencioso**: no lanza, no
 * avisa, y el foco se queda donde estaba —en `<body>` tras desmontar el diálogo—, que es el peor
 * sitio posible: quien navega con teclado vuelve a empezar por el principio de la página. Pasa de
 * verdad en cuanto el diálogo cambia la lista que hay detrás: la fila que lo abrió puede haberse
 * ido con un filtro, con una recarga o con un 404. El respaldo es el encabezado de esa lista.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled = true,
  respaldoRef?: RefObject<HTMLElement | null>,
): void {
  // El respaldo se lee por ref y no como dependencia del efecto: el elemento al que apunta cambia
  // de identidad cuando la tabla se vuelve a pintar, y re-suscribir la trampa por eso reabriría el
  // agujero de `enabled` (un `previouslyFocused` nuevo capturado con el foco ya dentro).
  const respaldo = useRef(respaldoRef);
  useEffect(() => { respaldo.current = respaldoRef; }, [respaldoRef]);

  // Handle del `requestAnimationFrame` de la vigilancia de respaldo. Vive en el ámbito del HOOK y
  // no dentro del efecto porque se encola en la LIMPIEZA: para entonces el efecto ya no tiene dónde
  // guardarlo ni quién lo cancele. Lo cancela quien vuelve a armar la trampa, abajo.
  const vigilancia = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    // Armar la trampa invalida cualquier vigilancia pendiente del cierre anterior: o el diálogo se
    // reabrió, o es la segunda pasada de `StrictMode`. En los dos casos el foco lo manda este
    // montaje, no un gesto que ya terminó.
    if (vigilancia.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(vigilancia.current);
      vigilancia.current = null;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const getFocusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Foco inicial en el contenedor (anuncia aria-label del diálogo).
    container.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = getFocusables();
      if (items.length === 0) { e.preventDefault(); container.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || active === container || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      const destino = respaldo.current?.current ?? null;
      previouslyFocused?.focus?.();

      // Sin respaldo no hay nada que asegurar: se restaura el foco como toda la vida y se sale.
      //
      // Este `return` es lo que hace ESTRUCTURAL —y no una casualidad del encadenamiento de
      // opcionales— que para los modales que no pasan `respaldoRef` (todos los del producto menos el
      // panel de comparendos) esta función siga siendo exactamente la de antes: ni una comprobación
      // de más, ni un `requestAnimationFrame` encolado. También es la línea que impide que un
      // cambio futuro dentro de `asegurar` se propague sin querer a todos ellos.
      if (!destino) return;

      // ¿Se quedó el foco en la nada? Se comprueba el RESULTADO y no `isConnected`: además del nodo
      // desmontado, un disparador `disabled`, oculto o dentro de un `inert` tampoco toma el foco, y
      // los tres fallan igual de callados.
      const asegurar = () => {
        const activo = document.activeElement;
        if (activo && activo !== document.body && activo !== document.documentElement) return;
        destino.focus?.();
      };
      asegurar();

      // Y se vuelve a mirar durante unos fotogramas, que es la mitad que de verdad hacía falta.
      //
      // El disparador puede seguir montado EN ESTE INSTANTE y desmontarse un tick después, dentro
      // del mismo gesto: cerrar el panel de un comparendo con «Cerrar y actualizar la lista» apaga
      // el modal y recarga la lista a la vez, pero el vaciado de la tabla llega en el efecto de la
      // recarga —es decir, DESPUÉS de esta limpieza—. Medido en Chromium: al primer fotograma el
      // foco está todavía en la fila y al segundo ya está en <body>. Con una sola pasada, el foco
      // se devuelve con éxito a una fila que deja de existir medio milisegundo más tarde y acaba
      // en <body> igualmente: el fallo original, solo que más difícil de ver.
      //
      // Qué hace exactamente, sin adornos: `asegurar` **solo actúa si el foco está en `<body>`**.
      // Eso deja fuera casi todo, pero NO todo — un clic del usuario sobre una zona no enfocable
      // dentro de la ventana de gracia deja el foco en `<body>` de forma legítima, y esta vigilancia
      // se lo llevaría al respaldo. Es un caso estrecho (hace falta clicar en el hueco justo, en los
      // ~48 ms siguientes a cerrar un diálogo) y por eso se acepta, pero se escribe tal cual: la
      // ventana está acotada por `FOTOGRAMAS_DE_GRACIA` y por `MS_DE_GRACIA`, no es inofensiva por
      // definición.
      if (typeof requestAnimationFrame !== 'function') return;

      let fotogramas = FOTOGRAMAS_DE_GRACIA;
      // `Date.now` y no `performance.now`: aquí solo se necesita saber si pasó MUCHO tiempo.
      const inicio = Date.now();
      const vigilar = () => {
        vigilancia.current = null;
        // El plazo es el que cierra el agujero de la pestaña OCULTA: los `rAF` se congelan al
        // esconder la pestaña, así que una vigilancia encolada justo antes de cambiar de pestaña se
        // ejecuta AL VOLVER, que pueden ser minutos. Comprobar `visibilityState` dentro del callback
        // no sirve para nada —cuando por fin corre, la pestaña YA está visible otra vez—: lo que
        // hay que mirar es cuánto ha pasado desde el gesto. Sin esto, quien cierra el panel, se va a
        // otra pestaña y vuelve al rato se encuentra el foco saltando al encabezado de respaldo,
        // que además es `focus:not-sr-only` y se hace visible: un salto de maquetación sin ninguna
        // causa a la vista.
        if (Date.now() - inicio > MS_DE_GRACIA) return;
        // Y, por si acaso, tampoco se mueve el foco con la pestaña escondida: hay navegadores que
        // siguen ejecutando `rAF` a baja frecuencia en segundo plano en vez de congelarlos del todo.
        // Es defensa en profundidad y no la comprobación principal —cuando un `rAF` congelado por
        // fin corre, la pestaña YA está visible otra vez y esta línea no lo vería—: quien cierra ese
        // agujero es el plazo de arriba.
        if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return;
        asegurar();
        fotogramas -= 1;
        if (fotogramas > 0) vigilancia.current = requestAnimationFrame(vigilar);
      };
      vigilancia.current = requestAnimationFrame(vigilar);
    };
  }, [enabled, containerRef]);
}
