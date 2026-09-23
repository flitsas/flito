import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

export const flitInp =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-flit-card px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-[box-shadow,border-color] hover:border-[color:var(--flit-text-muted)] disabled:cursor-not-allowed disabled:opacity-60 [&[readonly]]:bg-[var(--flit-bg-app)]';

export const flitPillWrap: CSSProperties = {
  background: 'var(--flit-bg-app)',
  border: '1px solid var(--flit-border-soft)',
};

export function flitPillBtn(active: boolean): CSSProperties {
  return active
    // `--flit-blue` es color de SUPERFICIE: como texto sobre el blanco de la pill activa daba 4,49
    // (bug #11604). La variante tinta sube a 5,61 sin mover el azul de marca.
    // `#fff` en línea NO seguía el tema (HU #11899): la pill activa se quedaba blanca sobre el
    // grupo ya oscuro. El token es la misma superficie de tarjeta que usa el resto del kit.
    // HU #12819: la tinta es `--flit-pill-active-ink` (el mismo azul en claro; en oscuro, el azul de
    // texto del tema: el `-ink` sobre la tarjeta oscura daba ~2,4).
    ? { background: 'var(--flit-bg-card)', color: 'var(--flit-pill-active-ink)', boxShadow: 'var(--flit-shadow-card)' }
    : { color: 'var(--flit-text-muted)' };
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
    <div
      className="relative overflow-hidden bg-flit-card"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
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
          style={{ background: 'linear-gradient(to left, var(--flit-shadow-desborde), transparent)' }}
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
export function FlitTh({ children, center, estrecha, className = '' }: { children?: ReactNode; center?: boolean; estrecha?: boolean; className?: string }) {
  return (
    <th
      scope="col"
      className={`${estrecha ? 'px-3' : 'px-4'} py-2.5 ${center ? 'text-center' : 'text-left'} text-[11px] font-semibold uppercase tracking-wide ${className}`}
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}
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
      className={`border-t transition-colors hover:bg-[color:var(--flit-bg-app)] ${marcada ? 'bg-[color:var(--flit-bg-app)] shadow-[inset_3px_0_0_var(--flit-blue-text)]' : ''}`}
      style={{ borderColor: 'var(--flit-border-soft)' }}
      data-marcada={marcada || undefined}
    >
      {children}
    </tr>
  );
}

export function FlitField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
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
const DESHABILITADO_PRIMARIO =
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:shadow-none';
const HOVER_SECUNDARIO =
  'border-[color:var(--flit-border-input)] text-[color:var(--flit-text-secondary)] transition-colors hover:bg-[var(--flit-bg-hover)] hover:text-[color:var(--flit-text-primary)] active:bg-[var(--flit-bg-app)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-flit-card aria-disabled:cursor-not-allowed aria-disabled:hover:bg-flit-card';

export const flitBtnPrimary = `flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] px-5 text-sm font-semibold text-white transition-shadow hover:shadow-[inset_0_0_0_999px_var(--flit-veil-press-hover)] active:shadow-[inset_0_0_0_999px_var(--flit-veil-press-active)] ${DESHABILITADO_PRIMARIO}`;
export const flitBtnPrimaryStyle = { background: 'var(--flit-gradient-primary)' } as const;
export const flitBtnSecondary = `flit-focus inline-flex h-10 items-center gap-2 rounded-[999px] border bg-flit-card px-5 text-sm font-medium ${HOVER_SECUNDARIO}`;
/** Vacío desde la HU #12819: el borde y la tinta van en `flitBtnSecondary` (ver arriba). */
export const flitBtnSecondaryStyle = {} as const;
/**
 * Variante compacta del secundario, para acciones que viven DENTRO de una celda junto a datos.
 *
 * Comparte estilo con `flitBtnSecondary` —mismo borde, mismo color, mismo hover— y solo baja alto,
 * tipografía y relleno: a la altura normal el botón manda más que el dato que acompaña y descuadra
 * el alto de la fila.
 */
export const flitBtnSecondarySm = `flit-focus inline-flex h-7 items-center gap-1.5 rounded-[999px] border bg-flit-card px-3 text-xs font-medium ${HOVER_SECUNDARIO}`;

export function FlitCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-flit-card p-5 ${className}`}
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
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
  { children, role, label }: { children: ReactNode; role?: 'tablist'; label?: string },
) {
  return (
    <div
      className="inline-flex w-fit flex-wrap gap-1 rounded-[999px] p-1"
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
export const flitPillBtnClase =
  'flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-4 py-2 text-xs font-semibold capitalize transition-colors hover:bg-[var(--flit-bg-hover)]';

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
    <div
      className="p-12 text-center text-sm"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-muted)' }}
    >
      {children}
    </div>
  );
}
