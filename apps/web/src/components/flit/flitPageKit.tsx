import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Icono } from './kit/Icono';
import { useDesbordeScroll } from './kit/useDesbordeScroll';

export const flitInp =
  // Campo del UI Kit 2026 (`.control`): borde línea 1 px, radio 9, foco borde azul + sombra del kit, inválido naranja.
  'w-full rounded-[9px] border border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] px-3.5 py-2.5 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--kit-gris)] outline-none transition-[box-shadow,border-color] hover:border-[color:var(--kit-azul)] focus:border-[color:var(--kit-azul)] focus:shadow-[var(--kit-sombra)] aria-[invalid=true]:border-[color:var(--kit-naranja)] disabled:cursor-not-allowed disabled:bg-[var(--kit-hover)] disabled:text-[color:var(--kit-gris)] [&[readonly]]:bg-[var(--kit-hover)]';

// Segmentado del UI Kit 2026 (`.segmentado`): contenedor con borde; la opción activa va en relleno azul.
export const flitPillWrap: CSSProperties = {
  background: 'var(--color-surface-elevated)',
  border: '1px solid var(--color-border)',
};

export function flitPillBtn(active: boolean): CSSProperties {
  return active
    ? { background: 'var(--kit-azul-relleno)', color: 'var(--kit-sobre-relleno)' }
    : { color: 'var(--color-text-primary)' };
}

/**
 * ¿El contenedor desborda en horizontal? Sirve para dar `tabindex` SOLO cuando hay algo que
 * desplazar: un `tabindex="0"` fijo mete una parada de tabulador en cada tabla del producto,
 * incluidas las que caben enteras en pantalla, que es justo la molestia que el arreglo de
 * `scrollable-region-focusable` no debe crear.
 *
 * Desde la HU #11900 la misma medida gobierna una segunda cosa, y por eso importa que siga siendo
 * UNA: la affordance VISIBLE de «hay más a la derecha». Hasta esta HU el desborde solo se traducía
 * en un anillo de foco de teclado, o sea que la tabla que desborda se anunciaba únicamente a quien
 * ya había tabulado hasta ella; quien mira la pantalla no tenía forma de saber que faltaban
 * columnas a la derecha. Con una sola fuente de verdad, el aviso visible y la parada de tabulador
 * no pueden discrepar: o los dos o ninguno.
 */
function useDesbordaX(ref: RefObject<HTMLElement | null>): boolean {
  const [desborda, setDesborda] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // +1px de tolerancia: con zoom o anchos fraccionarios `scrollWidth` supera a `clientWidth` por
    // redondeo sin que haya nada que desplazar.
    const medir = () => setDesborda(el.scrollWidth > el.clientWidth + 1);
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    // También la <table>: cambia de ancho al pintar filas nuevas sin que el contenedor se mueva.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [ref]);
  return desborda;
}

/**
 * Tabla FLIT. El `div` interno desplaza en horizontal, y hasta #11604 no era alcanzable con el
 * teclado: en una tabla de 13 columnas, quien no usa ratón no llegaba a las de la derecha
 * (`scrollable-region-focusable`). Ahora recibe foco —solo cuando desborda de verdad— y se
 * anuncia como región con nombre si el llamador le pasa uno.
 *
 * El anillo de foco es `.flit-focus-inset` y no el `.flit-focus` de siempre porque el contenedor
 * exterior tiene `overflow: hidden` para redondear las esquinas: un anillo hacia fuera quedaría
 * recortado e invisible.
 *
 * ── HU #11900 · el borde derecho dice si hay más ────────────────────────────────────────────────
 * Cuando la tabla NO cabe entera se pinta un degradado contra el borde derecho. Cinco decisiones,
 * todas comprobables:
 *
 *   · **Solo al desbordar.** Es el AC7 entero: una tabla que cabe no lleva franja, o el indicador
 *     deja de indicar. Sale del mismo `useDesbordaX` que ya decide el `tabindex`.
 *   · **`aria-hidden` y `pointer-events-none`.** No es un control ni un dato: es la sombra de lo
 *     que hay detrás. Anunciarlo aparte sería una segunda voz para lo que la región desplazable
 *     ya nombra, y capturar el puntero encima del borde rompería el arrastre del scroll.
 *   · **Hermano del `div` que desplaza, no hijo.** Dentro se movería con el contenido y se iría
 *     del borde en cuanto alguien desplazara; fuera se queda pegado a la tarjeta, que es donde el
 *     ojo lo busca. Por eso el contenedor exterior gana `relative` — su `overflow: hidden` de
 *     siempre es además lo que recorta el degradado a las esquinas redondeadas.
 *   · **Un solo color, del token, y MEDIDO a 3:1.** Aquí decía que un degradado «no tiene un borde
 *     contra el que medir un ratio» y era FALSO: el gate de QA lo midió y lo tumbó. El píxel del
 *     extremo derecho vale exactamente `opaco(--flit-shadow-desborde, superficie)`, y contra esa
 *     superficie se mide como cualquier otro indicador gráfico (SC 1.4.11, y la spec se lo asigna
 *     por su nombre). Con el valor inicial —alfa 0,26— daba 1,70 en claro y 1,36 en oscuro: un
 *     aviso que no avisaba. Hoy `npm run check:contraste` lo mide con umbral contra las DOS
 *     superficies que la franja cruza, tarjeta y cabecera de tabla, en los dos temas: 3,88 · 3,79
 *     en claro y 3,66 · 3,86 en oscuro. Escrito a mano aquí, un rgba() no tendría par oscuro ni
 *     nadie que lo remidiera.
 *   · **`w-10` y no `w-8`.** La parada opaca subió de 0,26 a 0,58 de alfa para llegar al 3:1, y en
 *     32 px esa rampa se lee como una BARRA pegada al borde. Con 40 px el mismo color entra
 *     gradualmente: el ancho es lo que convierte un tope en un desvanecido. Ensanchar es, junto a
 *     oscurecer, la otra manera de pagar el 3:1 sin perder el gesto.
 *
 * `data-desborde` es el asidero de QA: el degradado no tiene texto que buscar y su presencia es
 * justo lo que el AC7 pide medir en los dos sentidos.
 */
export function FlitTable({ children, label }: { children: ReactNode; label?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const desborda = useDesbordaX(scrollRef);
  return (
    <div className="kit-tabla-flit relative overflow-hidden" data-kit="tabla">
      <div
        ref={scrollRef}
        className="flit-focus-inset overflow-x-auto"
        tabIndex={desborda ? 0 : undefined}
        role={label ? 'region' : undefined}
        aria-label={label}
      >
        <table className="w-full">{children}</table>
      </div>
      {desborda && (
        <div
          aria-hidden="true"
          data-desborde="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10"
          style={{ background: 'linear-gradient(to left, color-mix(in srgb, var(--kit-azul) 18%, transparent), transparent)' }}
        />
      )}
    </div>
  );
}

/**
 * `estrecha` baja el relleno horizontal a `px-3`, para tablas que tienen que caber en un portátil
 * (reporte de costos, HU #12539). Es prop y no `className="px-3"` porque en el orden de Tailwind
 * `px-3` no vence a `px-4`: las dos utilidades pesan igual y gana la que va después en la hoja,
 * no en el atributo.
 */
export function FlitTh({ children, center, estrecha, className = '', ariaSort }: { children?: ReactNode; center?: boolean; estrecha?: boolean; className?: string; ariaSort?: 'ascending' | 'descending' | 'none' }) {
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`kit-th ${estrecha ? 'px-3' : 'px-3.5'} py-2.5 ${center ? 'text-center' : 'text-left'} ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * Fila del kit. `marcada` (HU #12819) distingue la fila SELECCIONADA de las demás con el mismo fondo
 * del hover más un filete izquierdo en `--flit-blue-text`: sin ella, marcar veinte filas de una cola
 * larga no dejaba rastro visible salvo la casilla. Opcional y compatible hacia atrás.
 */
export function FlitTr({ children, marcada = false }: { children: ReactNode; marcada?: boolean }) {
  return (
    <tr
      className={`kit-tr transition-colors ${marcada ? 'bg-[var(--kit-hover)] shadow-[inset_3px_0_0_var(--kit-azul)]' : ''}`}
      data-marcada={marcada || undefined}
    >
      {children}
    </tr>
  );
}

export function FlitField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.8125rem] font-semibold text-[color:var(--color-text-primary)]">{label}</span>
      {children}
    </label>
  );
}

/*
 * Botones del kit con hover, activo y deshabilitado (HU #12819). Hasta esta HU ninguno de los tres
 * reaccionaba al puntero: parecían deshabilitados hasta pulsarlos, y el parche `hoverSecundario` /
 * `hoverPrimario` solo llegaba a unos pocos. Ahora el affordance vive AQUÍ y llega a toda la app.
 *
 *  · Primaria: velo OSCURO por `box-shadow` inset (`--flit-veil-press-*`, mismo valor en los dos
 *    temas). El degradado va en línea (`flitBtnPrimaryStyle`) y el `box-shadow` no se pelea con él;
 *    oscurecer sube el contraste del texto blanco. `opacity` o `brightness` lo bajarían.
 *  · Secundaria: el borde y la tinta de reposo pasaron de `style` a CLASES — un color en línea gana a
 *    cualquier `hover:` de clase, y con ellos en línea el hover de color era imposible. Por eso
 *    `flitBtnSecondaryStyle` queda vacío: se conserva el export para no romper a los llamadores, y quien
 *    sobrescribe el color en línea a propósito (peligro, comprobante no pagado) lo sigue haciendo.
 *  · Sin escalas, sin desplazamientos, sin sombras exteriores: affordance, no adorno.
 */
// Botones del UI Kit 2026: píldoras planas, sin degradado ni sombra. Hover brightness .9, activo .78 + 1 px abajo,
// deshabilitado gris con texto blanco. Primario = azul (avanza), secundario = tinta (navega), peligro = naranja
// (cancelar, anular, eliminar). Los `Sm` son el «Acciones» de fila del kit: contorno línea y texto azul.
const RELLENO =
  'hover:brightness-90 active:brightness-[.78] active:translate-y-px disabled:cursor-not-allowed disabled:!bg-[var(--kit-gris)] disabled:!text-white disabled:hover:brightness-100 disabled:active:translate-y-0 aria-disabled:cursor-not-allowed aria-disabled:!bg-[var(--kit-gris)] aria-disabled:hover:brightness-100';
const PILDORA = 'inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full border-0 px-6 text-sm font-semibold transition-[filter,transform,background-color]';
const CONTORNO =
  'border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] text-[color:var(--color-action)] transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[var(--kit-hover)] aria-pressed:border-[color:var(--kit-azul)] aria-pressed:bg-[var(--kit-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--color-surface-elevated)] aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

export const flitBtnPrimary = `${PILDORA} bg-[var(--kit-azul-relleno)] text-white ${RELLENO}`;
export const flitBtnPrimaryStyle = {} as const;
export const flitBtnSecondary = `${PILDORA} bg-[var(--kit-tinta-fija)] text-white dark:shadow-[inset_0_0_0_1px_var(--kit-linea)] ${RELLENO}`;
export const flitBtnSecondaryStyle = {} as const;
export const flitBtnDanger = `${PILDORA} bg-[var(--kit-naranja-boton)] text-white ${RELLENO}`;
export const flitBtnSecondarySm = `inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[0.8125rem] font-normal ${CONTORNO}`;
export const flitBtnSecondarySmToggle = flitBtnSecondarySm;
export const flitBtnIconoSm = `inline-grid h-8 w-8 shrink-0 place-items-center rounded-full ${CONTORNO}`;

export function FlitCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`card ${className}`}>
      {children}
    </div>
  );
}

/**
 * El grupo de pills. `role` y `label` existen para el caso en el que las pills no son un filtro
 * sino una NAVEGACIÓN por pestañas (`role="tablist"`, HU #11633): el patrón ARIA exige que el
 * contenedor lleve el rol y un nombre, y sin estas dos props el llamador tendría que envolver el
 * grupo en otro `div` —perdiendo el `flex` que separa las pills— o duplicar la caja entera.
 * Omitidas, se comporta exactamente igual que antes.
 */
export function FlitPillGroup(
  { children, role, label }: {
    children: ReactNode; role?: 'tablist'; label?: string;
    /**
     * Opcional (Épica #13763): en vez de envolver en varias líneas —que en móvil deja una «mancha»
     * redondeada—, el grupo se queda en una línea y se desplaza a lo ancho dentro de su caja, sin
     * scroll de página. Las pills hijas deben llevar `shrink-0`. Sin él, el grupo es el de siempre.
     */
    desplazable?: boolean;
  },
) {
  // V1 (Épica #14560): el grupo NUNCA envuelve. Envolviendo, la caja `rounded-[999px]` quedaba como un
  // óvalo deforme o cortaba la última pill; ahora es siempre una fila con scroll táctil propio y el
  // desvanecido de `.kit-segmentado` (kit-responsive.css) mientras quede algo oculto a la derecha.
  // `desplazable` se conserva en el tipo por compatibilidad: ya es el comportamiento de todos.
  const grupoRef = useDesbordeScroll<HTMLDivElement>();
  return (
    <div
      ref={grupoRef}
      className="kit-segmentado inline-flex w-fit max-w-full flex-nowrap gap-1 overflow-x-auto rounded-[999px] p-1"
      style={flitPillWrap}
      role={role}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * La clase de una pill, aparte del componente.
 *
 * Se exporta porque una pill que además es una PESTAÑA (`role="tab"`, `aria-selected`, `tabIndex`
 * itinerante y flechas del teclado) no cabe como props de `FlitPillButton` sin convertirlo en un
 * `<button>` genérico; y si esa pestaña copiara la clase a mano, el día que esta cambie habría dos
 * pills distintas en el producto. Compartir la clase es lo que garantiza que no haya deriva visual.
 */
//
// La transición es SOLO del hover (`hover:transition-colors`), no del cambio de pill activa: con
// `transition-colors` fijo el fondo de tarjeta se desvanecía 150 ms en la pill que dejaba de estar
// puesta, y en una pestaña sin cuadros (captura, segundo plano) la cara de activa se quedaba en la
// anterior mientras la lista ya era la nueva — HU #12997, retrabajo. Cambiar de pill es instantáneo.
export const flitPillBtnClase =
  'inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[0.8125rem] font-semibold transition-colors hover:bg-[var(--kit-hover)] aria-pressed:hover:brightness-95';

export function FlitPillButton(
  { active, onClick, children, pressed }:
  { active: boolean; onClick: () => void; children: ReactNode;
    /** `aria-pressed`. Sin él, un lector anuncia varios botones idénticos sin decir cuál está puesto. */
    pressed?: boolean },
) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={flitPillBtnClase}
      style={flitPillBtn(active)}
    >
      {children}
    </button>
  );
}

export function FlitEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="card kit-vacio" data-kit="vacio">
      <Icono nombre="carpeta" disco size={72} />
      <div className="text-sm">{children}</div>
    </div>
  );
}
