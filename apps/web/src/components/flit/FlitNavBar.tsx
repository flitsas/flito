import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { SECTION_LABEL } from '../shell/navItems';
import { useNavSections } from '../shell/useNavSections';
import { useDisclosureNav } from '../shell/useDisclosureNav';
import { useEdgeClamp } from '../shell/useEdgeClamp';
import { SECTION_ICON, SECTION_ACCENT, groupItems } from '../shell/sectionMeta';
import { IconChevronDown } from './icons';

// FlitNavBar — navegación principal de escritorio: un dock flotante centrado al
// PIE de la pantalla, por encima del contenido. Sustituye a la barra horizontal
// que colgaba del topbar (HU #11143); el menú lateral sigue descartado como
// patrón (decisión PO 2026-06-12) y solo vive como drawer en <lg.
//
// Cada módulo es una píldora con icono + nombre; el módulo de la ruta actual se
// rellena con el gradiente de marca. Los módulos con varios ítems son un
// disclosure APG (button aria-expanded + lista de links, SIN role="menu"); los
// de un solo ítem, un link directo. El filtrado por permisos y el contrato de
// teclado no viven aquí: son `useNavSections` y `useDisclosureNav`, compartidos
// con el drawer, para que las tres navegaciones no puedan divergir.
//
// Dos piezas del proyecto que estaban escritas y sin consumidor entran en uso:
//   · `.flit-shell-nav` (index.css) — superficie de tarjeta + blur + shadow-card.
//     Fue vidrio blanco al 94 % con un override aparte para el tema oscuro hasta
//     la HU #11899: hoy es `var(--flit-bg-card)`, que trae los dos temas, y el
//     override se borró para no dejar dos fuentes de verdad del mismo fondo;
//   · el view-transition name `floating-nav`.
//
// Al bajar por la página el dock se condensa a solo iconos; al subir se
// reexpande. Los paneles abren HACIA ARRIBA, único sentido posible desde el pie.
//
// ── HU #11900 · el dock también se condensa por ANCHO ────────────────────────
// Hasta esta HU el condensado dependía SOLO del scroll, y el resultado a 1366 o
// a 1100 px era un dock de DOS filas —medido: 58 px de alto contra 104— que
// tapa el main. Ahora hay dos condensados y se SUMAN (spec §3): el de scroll
// sigue igual (a 1920 con scroll abajo también son iconos) y encima está el de
// ancho, que es el que hace cierta la promesa de «una fila SIEMPRE».
//
// El de ancho NO es un breakpoint de Tailwind: se MIDE. Un `xl:` ciego dejaría
// a un proveedor con tres píldoras viendo solo iconos a 1100 px, donde le
// sobran 800. Lo que decide es si la fila EXPANDIDA cabe en el hueco
// disponible, así que la cota depende de cuántos módulos ve cada rol — los
// ~1440 px de la spec son la del admin con sus diez (medido: 1381 px de fila).

/** Scroll bajo el cual el dock está siempre expandido. */
const EXPAND_ZONE = 96;

/**
 * Ancho que ocupa la fila del dock si NADIE la parte, medido sobre el DOM.
 *
 * Se suman los hijos en vez de leer `scrollWidth` porque la cápsula lleva
 * `flex-wrap` —y con `flex-wrap` el contenido nunca desborda: se reparte en dos
 * filas y `scrollWidth` vuelve a ser igual a `clientWidth`—. La suma, en cambio,
 * da el mismo número esté la fila entera o partida (comprobado: 1381 px a 1920
 * y a 1024), que es justo lo que hace falta para decidir si cabe.
 *
 * El `flex-wrap` se conserva a propósito: es la red de seguridad si algún día
 * ni los iconos caben, y es lo que hace OBSERVABLE el fallo —dos coordenadas
 * `y` distintas— si este cálculo dejara de condensar.
 */
function anchoDeLaFila(nav: HTMLElement): number {
  const cs = getComputedStyle(nav);
  const gap = parseFloat(cs.columnGap) || 0;
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const hijos = Array.from(nav.children) as HTMLElement[];
  const suma = hijos.reduce((total, hijo) => total + hijo.getBoundingClientRect().width, 0);
  const bordes = nav.offsetWidth - nav.clientWidth;
  return suma + gap * Math.max(0, hijos.length - 1) + padX + bordes;
}

export default function FlitNavBar() {
  const { grouped, routeSection } = useNavSections();
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav('flit-navbar');
  const [condensadoPorScroll, setCondensadoPorScroll] = useState(false);
  const [condensadoPorAncho, setCondensadoPorAncho] = useState(false);
  const contenedorRef = useRef<HTMLDivElement>(null);
  // El panel de PESV (4 columnas) se sale del viewport si el módulo queda a la
  // derecha del dock.
  const { ref: panelRef, shift } = useEdgeClamp<HTMLDivElement>(openSection);

  // Condensa al bajar, expande al subir. rAF para no leer scroll en cada evento.
  //
  // El LOCKOUT no es decorativo: al condensarse cambia el layout, el navegador
  // ajusta el scroll para compensar y eso llega como un "scroll hacia arriba"
  // que volvería a expandir el dock — y otra vez, en bucle. Tras cada cambio de
  // estado ignoramos el scroll un instante, que es justo el rebote inducido.
  const condensedRef = useRef(false);
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    let lockUntil = 0;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const now = performance.now();
        if (now >= lockUntil) {
          let next: boolean | null = null;
          if (y <= EXPAND_ZONE) next = false;
          else if (y > lastY + 4) next = true;
          else if (y < lastY - 8) next = false;
          if (next !== null && next !== condensedRef.current) {
            condensedRef.current = next;
            lockUntil = now + 250;
            setCondensadoPorScroll(next);
          }
        }
        lastY = y;
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Un panel abierto fuerza la expansión: navegar entre iconos sueltos es
  // desorientador.
  //
  // Fuerza el condensado por SCROLL, no el de ancho (HU #11900). Si también
  // deshiciera el de ancho, abrir un módulo a 1100 px devolvería los nombres a
  // una fila que no los admite y el dock volvería a partirse en dos justo con
  // un panel abierto encima — que es el defecto que esta HU cierra. «Una fila
  // siempre» (spec §3) manda sobre la expansión de cortesía, y a cambio el
  // panel abierto ya enseña los nombres de sus ítems.
  useEffect(() => {
    if (!openSection) return;
    condensedRef.current = false;
    setCondensadoPorScroll(false);
  }, [openSection]);

  // ── Condensado por ancho ───────────────────────────────────────────────────
  // Histéresis con memoria: mientras el dock está EXPANDIDO se remide lo que
  // ocupa la fila; mientras está condensado se conserva la última medida. Sin
  // esa memoria el cálculo oscilaría —al condensarse la fila encoge, volvería a
  // caber, se expandiría, dejaría de caber…—, que es el mismo bucle que el
  // lockout del scroll evita por su lado.
  const anchoRef = useRef<{ condensado: boolean; necesario: number | null }>({
    condensado: false,
    necesario: null,
  });

  const medir = () => {
    const nav = navRef.current;
    const contenedor = contenedorRef.current;
    if (!nav || !contenedor) return;
    // El contenedor es `fixed inset-x-0`: su `clientWidth` ya descuenta la barra
    // de desplazamiento, y su padding es el margen que el dock no puede invadir.
    const cs = getComputedStyle(contenedor);
    const disponible = contenedor.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // Sin hueco que repartir no hay nada que decidir Y NO SE MIDE, que es lo que
    // importa del orden de estas dos líneas: por debajo de `lg` el contenedor es
    // `hidden`, todas las píldoras miden cero y guardar ESE número como «lo que
    // ocupa la fila» dejaría el dock creyendo que le sobra sitio al volver a
    // escritorio — expandido y partido en dos a 1100 px, justo el defecto que
    // esta HU cierra. Se conserva la última medida buena.
    if (disponible <= 0) return;
    if (!anchoRef.current.condensado) anchoRef.current.necesario = anchoDeLaFila(nav);
    const necesario = anchoRef.current.necesario;
    if (necesario == null) return;
    const siguiente = necesario > disponible;
    if (siguiente !== anchoRef.current.condensado) {
      anchoRef.current.condensado = siguiente;
      setCondensadoPorAncho(siguiente);
    }
  };

  // La medida se rehace en cada render (el dock re-renderiza en cuatro
  // ocasiones contadas: ruta, permisos, panel y el propio condensado) y en cada
  // cambio de tamaño del contenedor. `useLayoutEffect` para que el cambio de
  // estado entre en el MISMO frame: con `useEffect` el usuario llega a ver la
  // fila partida antes de que se condense.
  const medirRef = useRef(medir);
  medirRef.current = medir;
  useLayoutEffect(() => { medirRef.current(); });

  // Un rol con otros módulos cambia el ancho que hace falta: la medida guardada
  // deja de valer y hay que volver a tomarla con el dock expandido. La
  // dependencia es la LISTA de módulos por valor, no la referencia de `grouped`:
  // una identidad nueva del mismo menú tiraría la medida en cada render.
  //
  // El guardia contra la PRIMERA ejecución no es estilo, y se pagó midiendo:
  // React corre todo efecto al montar, así que sin él la invalidación saltaba
  // justo después del primer pintado, cuando la medida buena acababa de
  // tomarse. La secuencia registrada a 1024 px era 1381 → condensar; invalidar
  // → medir 452 (¡el ancho de la fila YA condensada!) → expandir → medir 1381 →
  // condensar. El dock se estrenaba con un rebote visible de unos 80 ms, y de
  // paso el `ref` quedaba diciendo lo contrario que el estado de React.
  const firmaDeModulos = grouped.map((g) => g.section).join('·');
  const firmaPrevia = useRef(firmaDeModulos);
  useEffect(() => {
    if (firmaPrevia.current === firmaDeModulos) return;
    firmaPrevia.current = firmaDeModulos;
    anchoRef.current = { condensado: false, necesario: null };
    setCondensadoPorAncho(false);
  }, [firmaDeModulos]);

  useEffect(() => {
    const contenedor = contenedorRef.current;
    if (!contenedor) return undefined;
    const ro = new ResizeObserver(() => medirRef.current());
    ro.observe(contenedor);
    return () => ro.disconnect();
  }, []);

  // Ver `transicionCapsula` más abajo: el primer estado se pinta sin animación
  // y las transiciones se reponen en el frame siguiente.
  const [animable, setAnimable] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimable(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // El PRIMER estado del dock no se anima, y esto es la mitad del arreglo del
  // rebote de arriba (la otra mitad es el guardia de la firma).
  //
  // Medir obliga a resolver estilos (`getComputedStyle`), y esa resolución fija
  // como «valor de partida» la píldora todavía expandida: cuando el condensado
  // por ancho entra —en el mismo frame, antes de pintar— el navegador ya tiene
  // los dos extremos y anima los 200 ms de `transition-all`. Se veía como un
  // dock que se encoge solo al entrar a la página en un portátil, y dejaba el
  // alto del dock indeterminado durante ese tramo, que es justo lo que el AC2b
  // manda medir. Sin `transition-*` en el estilo de llegada no hay transición
  // que arrancar; se repone en el frame siguiente, ya con el dock asentado, y
  // condensar por scroll o expandir por panel vuelve a animarse como siempre.
  const transicionCapsula = animable
    ? 'transition-[height,padding] duration-200 ease-out motion-reduce:transition-none'
    : '';
  const transicionPildora = animable
    ? 'transition-all duration-200 ease-out motion-reduce:transition-none'
    : '';

  if (grouped.length === 0) return null;

  const condensed = condensadoPorScroll || condensadoPorAncho;
  const pillH = condensed ? 'h-9' : 'h-11';

  return (
    // El contenedor cubre todo el ancho para poder centrar, pero deja pasar los
    // clics: solo el dock y sus paneles son interactivos.
    <div
      ref={contenedorRef}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 hidden justify-center px-4 pb-5 lg:flex"
    >
      <nav
        ref={navRef}
        aria-label="Navegación principal"
        data-vt="floating-nav"
        // gap y padding ajustados para que los 10 módulos de un admin quepan en
        // UNA fila a 1440px: el dock pierde su gracia partido en dos.
        //
        // El `flex-wrap` SIGUE aquí y no es un descuido (HU #11900). Quitarlo
        // haría que un fallo del condensado por ancho se pintara como píldoras
        // saliéndose de la cápsula —misma coordenada `y`, o sea invisible para
        // la medida del AC2b—; con `flex-wrap`, ese mismo fallo parte la fila y
        // la medida lo delata. La red de seguridad es también el oráculo.
        className={`flit-nav-capsule flit-shell-nav pointer-events-auto relative inline-flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-flit-pill p-1.5 ${transicionCapsula}`}
      >
        {grouped.map(({ section, items }) => {
          const SectionIcon = SECTION_ICON[section];
          const isRouteSection = routeSection === section;
          const isOpen = openSection === section;
          const lit = isRouteSection || isOpen;

          const shared = `flit-focus group relative flex ${pillH} items-center gap-2 whitespace-nowrap rounded-flit-pill px-3 text-sm ${transicionPildora}`;
          // `flit-nav-pill` existía para que un parche `[data-theme='dark']` de
          // index.css pudiera repintar estos textos, porque los tokens FLIT no
          // tenían par oscuro. Desde la HU #11899 lo tienen: `text-flit-secondary`
          // y `hover:bg-flit-app` ya siguen el tema y el parche se borró. La clase
          // se conserva como gancho —sin regla propia— porque nombrar la pill
          // sigue siendo útil para alcanzarla desde CSS o desde un test.
          // El módulo activo va sobre gradiente y ya es blanco en ambos temas.
          const tone = lit
            ? 'font-semibold text-white'
            : 'flit-nav-pill font-medium text-flit-secondary hover:bg-flit-app hover:text-flit-ink';
          const litStyle = lit
            ? { background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }
            : undefined;

          // En condensado el label sigue en el DOM (sr-only): el nombre
          // accesible del trigger no cambia, solo deja de verse.
          //
          // El `title` es para quien VE el icono y no sabe qué módulo es; el
          // nombre accesible NO depende de él —lo da el `sr-only`—, así que un
          // navegador que no pinte tooltips no deja a nadie sin el dato. Solo
          // en condensado: con el nombre a la vista, un tooltip que repite el
          // texto de al lado es ruido.
          const tooltip = (text: string) => (condensed ? text : undefined);
          const label = (text: string) => (
            <span className={condensed ? 'sr-only' : 'truncate'}>{text}</span>
          );

          if (items.length === 1) {
            const it = items[0];
            return (
              <NavLink
                key={section}
                to={it.to}
                end={it.to === '/'}
                title={tooltip(it.label)}
                className={`${shared} ${tone}`}
                style={litStyle}
              >
                <SectionIcon
                  className="h-[18px] w-[18px] shrink-0 transition-colors"
                  style={{ color: lit ? '#FFFFFF' : SECTION_ACCENT[section] }}
                />
                {label(it.label)}
              </NavLink>
            );
          }

          const groups = groupItems(section, items);
          const multiColumn = groups.length > 1;

          return (
            <div key={section} className="relative flex">
              <button
                type="button"
                id={triggerId(section)}
                aria-expanded={isOpen}
                aria-controls={panelId(section)}
                title={tooltip(SECTION_LABEL[section])}
                onClick={() => toggle(section)}
                className={`${shared} ${tone}`}
                style={litStyle}
              >
                <SectionIcon
                  className="h-[18px] w-[18px] shrink-0 transition-colors"
                  style={{ color: lit ? '#FFFFFF' : SECTION_ACCENT[section] }}
                />
                {label(SECTION_LABEL[section])}
                {!condensed && (
                  <IconChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${isOpen ? 'rotate-0' : 'rotate-180'} ${lit ? 'text-white/80' : 'text-flit-muted'}`}
                  />
                )}
              </button>

              {isOpen && (
                <div
                  ref={panelRef}
                  id={panelId(section)}
                  // bottom-full: desde el pie, el panel solo puede abrir hacia
                  // arriba. max-height + scroll para que un módulo grande no se
                  // salga por el techo en pantallas bajas.
                  className="flit-panel-up absolute bottom-full left-0 z-30 mb-2.5 overflow-y-auto rounded-flit-lg border border-flit-soft bg-flit-card p-2"
                  style={{
                    boxShadow: 'var(--flit-shadow-modal)',
                    minWidth: multiColumn ? undefined : '16rem',
                    maxHeight: 'min(70vh, 32rem)',
                    left: shift ? `${shift}px` : undefined,
                    ['--flit-acc' as string]: SECTION_ACCENT[section],
                  } as React.CSSProperties}
                >
                  <div className={multiColumn ? 'flex gap-1' : undefined}>
                    {groups.map((g) => (
                      <div key={g.title ?? '_'} className={multiColumn ? 'min-w-[13.5rem] flex-1' : undefined}>
                        {g.title && multiColumn && (
                          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-flit-muted">
                            {g.title}
                          </p>
                        )}
                        <ul className="flex flex-col gap-0.5">
                          {g.items.map((it) => (
                            <li key={it.to}>
                              <NavLink
                                to={it.to}
                                end={it.to === '/'}
                                className="flit-focus group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-flit-secondary transition-colors hover:bg-flit-app hover:text-flit-ink aria-[current=page]:bg-flit-app aria-[current=page]:font-semibold aria-[current=page]:text-flit-ink"
                              >
                                <span
                                  aria-hidden="true"
                                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-flit-soft transition-colors group-hover:bg-[var(--flit-acc)] group-aria-[current=page]:bg-[var(--flit-acc)]"
                                />
                                <span className="truncate">{it.label}</span>
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
