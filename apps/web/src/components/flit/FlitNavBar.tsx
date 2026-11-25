import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { SECTION_LABEL, type NavItem } from '../shell/navItems';
import { useNavSections, type SectionGroup } from '../shell/useNavSections';
import { useDisclosureNav } from '../shell/useDisclosureNav';
import {
  COPY_PROXIMAMENTE, COPY_PROXIMAMENTE_TEXTO, COPY_PROXIMAMENTE_TITULO, finExacto, groupItems, groupOf, usaRiel, type ItemGroup,
} from '../shell/sectionMeta';
import { ICONO_SECCION, descripcionDeRuta, iconoDeRuta } from '../shell/iconosNav';
import { COPY_MENU_ERROR, COPY_MENU_VACIO, useEstadoMenu, type EstadoDelMenu } from '../shell/useEstadoMenu';
import { Icono } from './kit/Icono';
import { IconoGlifo } from './kit/IconoGlifo';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';
import { useDesdeLg } from '../shell/useDesdeLg';

// FlitNavBar — dock inferior flotante del UI Kit 2026 (`.dock` de la propuesta-2; shell.css de flit develop).
//
// Épica #14678 (ADR-0048, spec `docs/ux/epica-14678-menu-por-areas.md`): un botón por OPCIÓN del menú — las áreas de
// la empresa con entradas, Kyverum y Administración —, en SECTION_ORDER y con sus nombres (SECTION_LABEL); Ayuda,
// la última. Cada panel abre HACIA ARRIBA con sus entradas en rejilla de 3 columnas, sin scroll; Gerencial con el
// subencabezado «Torre de Control» y Kyverum (más de 24 entradas) con un riel vertical de subgrupos (tablist APG).
// Los subgrupos son solo presentación (`sectionMeta.ts`). Trampas que se conservan (GUIA-DOCK-INFERIOR-FLOTANTE §12):
//   · el filtrado por permisos NO vive aquí: es `useNavSections` (mismo árbol que el buscador y el menú lateral);
//   · disclosure APG (button aria-expanded + lista de enlaces), SIN role="menu"; no abre al pasar el puntero;
//   · una opción con una sola entrada es enlace directo con el nombre de la entrada (p. ej. solo Tablero);
//   · un área sin pantallas activada para el usuario (PR 4) abre un panel angosto «Próximamente», sin enlaces;
//   · los estados (cargando, error, vacío) van DENTRO de la cápsula, sin caja propia (spec §4).
//
// Desde 1024 px el dock MIDE cuántas opciones caben con nombre (fila espejo). Con las seis del admin caben siempre;
// el «Más» queda como red por si un rol llegara a tener más opciones de las que caben (spec §7, regla sin decidir).
// Por debajo de 1024 px no hay dock: la navegación es el ☰ del topbar y el menú lateral (FlitSidebar).

type ClaveDock = NavItem['section'] | 'mas';
const MAS: ClaveDock = 'mas';

/** Margen lateral del dock (16 px por lado) y reserva simétrica del botón de Dr. Flit (16 + 48 + 16 por lado). */
const MARGEN = 32;
/** Margen mínimo entre un panel del dock y el borde de la ventana al desplazarlo para que quepa. */
const MARGEN_PANEL = 12;
const RESERVA_DRFLIT = 160;
/** Duración del fundido de cierre del panel (`--motion-fast`). */
const SALIDA_MS = 120;
/** Tope del escalonado de las entradas (spec §8): a partir de la 12 entran a la vez. */
const TOPE_ESCALON = 12;

const sinMovimiento = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
/** La entrada que corresponde a la ruta actual (prefijo más largo), como `activeSectionForPath`. */
function entradaDeRuta(pathname: string, items: readonly NavItem[]): NavItem | undefined {
  return items
    .filter((it) => (it.to === '/' ? pathname === '/' : pathname === it.to || pathname.startsWith(`${it.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

const escalon = (i: number) => ({ '--i': Math.min(i, TOPE_ESCALON) }) as CSSProperties;

/**
 * Cuántas opciones caben con nombre. Mide una fila ESPEJO (fuera de pantalla, `aria-hidden`, siempre con todas las
 * opciones y el «Más»), no la fila real: así la medida no depende de cuántas se muestran y el dock no oscila.
 */
function seccionesQueCaben(espejo: HTMLElement, disponible: number): number {
  const cs = getComputedStyle(espejo);
  const gap = parseFloat(cs.columnGap) || 0;
  const fijo = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + (espejo.offsetWidth - espejo.clientWidth);
  const hijos = Array.from(espejo.children) as HTMLElement[];
  const mas = hijos.pop();
  const anchos = hijos.map((h) => h.getBoundingClientRect().width);
  const anchoMas = mas?.getBoundingClientRect().width ?? 0;
  const fila = (n: number, conMas: boolean) => {
    const piezas = anchos.slice(0, n).reduce((t, w) => t + w, 0) + (conMas ? anchoMas : 0);
    const cuantas = n + (conMas ? 1 : 0);
    return piezas + gap * Math.max(0, cuantas - 1) + fijo;
  };
  if (fila(anchos.length, false) <= disponible) return anchos.length;
  let n = anchos.length - 1;
  while (n > 0 && fila(n, true) > disponible) n -= 1;
  return n;
}

export default function FlitNavBar() {
  const desdeLg = useDesdeLg();
  if (!desdeLg) return null;
  return <Dock />;
}

function Dock() {
  const { grouped, routeSection } = useNavSections();
  const menu = useEstadoMenu(grouped);
  if (menu.estado !== 'lleno') return <DockEstado menu={menu} ayuda={grouped.find((g) => g.section === 'ayuda')} />;
  return <DockLleno grouped={grouped} routeSection={routeSection} />;
}

/** Cargando, error y vacío: dentro de la cápsula del dock, con su misma silueta (spec §4). */
function DockEstado({ menu, ayuda }: { menu: EstadoDelMenu; ayuda?: SectionGroup }) {
  const [giro, setGiro] = useState(0);
  if (menu.estado === 'cargando') {
    return (
      <nav aria-label="Navegación principal" className="dock flit-nav-capsule dock--entra" data-estado="cargando">
        <span role="status" aria-busy="true" aria-label="Cargando menú" data-kit="esqueleto" className="dock-esqueleto">
          <span className="kit-esqueleto dock-esqueleto__pastilla" />
          <span className="kit-esqueleto dock-esqueleto__pastilla" />
          <span className="kit-esqueleto dock-esqueleto__pastilla" />
        </span>
      </nav>
    );
  }
  if (menu.estado === 'error') {
    return (
      <nav aria-label="Navegación principal" className="dock flit-nav-capsule dock--entra" data-estado="error">
        <span className="dock-aviso" data-tono="danger" role="alert">
          <img src="/kit/aviso-error.svg" alt="" aria-hidden="true" className="dock-aviso__icono" />
          <span>{COPY_MENU_ERROR}</span>
        </span>
        <button type="button" className="dock__item dock-reintentar" aria-busy={menu.reintentando || undefined}
          onClick={() => { setGiro((g) => g + 1); menu.reintentar(); }}>
          <span key={giro} className={`kico${giro > 0 ? ' dock-reintentar__giro' : ''}`} aria-hidden="true"><IconoGlifo icono="reintento" /></span>
          <span className="dock__nombre">Reintentar</span>
        </button>
      </nav>
    );
  }
  const unico = ayuda?.items[0];
  return (
    <nav aria-label="Navegación principal" className="dock flit-nav-capsule dock--entra" data-estado="vacio">
      <span className="dock-aviso" data-tono="info" role="status">
        <img src="/kit/aviso-info.svg" alt="" aria-hidden="true" className="dock-aviso__icono" />
        <span>{COPY_MENU_VACIO}</span>
      </span>
      {unico && (
        <NavLink to={unico.to} className="dock__item" data-seccion="ayuda">
          <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION.ayuda} /></span>
          <span className="dock__nombre">{unico.label}</span>
        </NavLink>
      )}
    </nav>
  );
}

function DockLleno({ grouped, routeSection }: { grouped: SectionGroup[]; routeSection: NavItem['section'] | null }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const espejoRef = useRef<HTMLDivElement>(null);
  const indicadorRef = useRef<HTMLSpanElement>(null);
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav<ClaveDock>('flit-navbar', [panelRef]);
  const reservaDrFlit = useDrFlitVisible();
  const [caben, setCaben] = useState(grouped.length);
  const [saliendo, setSaliendo] = useState<ClaveDock | null>(null);
  const [abiertaAntes, setAbiertaAntes] = useState<ClaveDock | null>(openSection);
  const firma = grouped.map((g) => `${g.section}:${g.items.length}`).join('|');

  // El panel sale centrado sobre su botón. Si ese centro lo sacaría de la pantalla (las opciones de los extremos),
  // se desplaza lo justo para que quede dentro del margen. La medida va en `--dock-desp` y CSS la suma al centrado.
  useLayoutEffect(() => {
    if (!openSection) return;
    const ajustar = () => {
      const panel = panelRef.current;
      const disparador = document.getElementById(triggerId(openSection));
      if (!panel || !disparador) return;
      const cx = disparador.getBoundingClientRect().left + disparador.getBoundingClientRect().width / 2;
      const ancho = panel.offsetWidth;
      const izq = Math.min(Math.max(cx - ancho / 2, MARGEN_PANEL), window.innerWidth - MARGEN_PANEL - ancho);
      panel.style.setProperty('--dock-desp', `${Math.round(izq - (cx - ancho / 2))}px`);
    };
    ajustar();
    window.addEventListener('resize', ajustar);
    return () => window.removeEventListener('resize', ajustar);
  }, [openSection, triggerId]);

  useLayoutEffect(() => {
    const decidir = () => {
      const espejo = espejoRef.current;
      if (!espejo) return;
      const disponible = window.innerWidth - MARGEN - (reservaDrFlit ? RESERVA_DRFLIT : 0);
      setCaben(seccionesQueCaben(espejo, disponible));
    };
    decidir();
    window.addEventListener('resize', decidir);
    // Las fuentes web cambian el ancho de los nombres al terminar de cargar.
    void document.fonts?.ready.then(decidir);
    return () => window.removeEventListener('resize', decidir);
  }, [reservaDrFlit, firma]);

  // Indicador (spec §8): la píldora `--kit-hover` se desliza al botón abierto y se desvanece al cerrar. La primera
  // aparición no se desliza: se coloca en su sitio sin transición.
  useLayoutEffect(() => {
    const ind = indicadorRef.current;
    const nav = navRef.current;
    if (!ind || !nav) return;
    const colocar = () => {
      const boton = openSection ? document.getElementById(triggerId(openSection)) : null;
      if (!boton) { ind.style.opacity = '0'; return; }
      const r = boton.getBoundingClientRect();
      const rd = nav.getBoundingClientRect();
      const primera = ind.style.opacity !== '1';
      if (primera) ind.style.transition = 'none';
      ind.style.width = `${r.width}px`;
      ind.style.height = `${r.height}px`;
      ind.style.transform = `translate(${r.left - rd.left - nav.clientLeft + nav.scrollLeft}px, ${r.top - rd.top - nav.clientTop}px)`;
      if (primera) { void ind.offsetWidth; ind.style.transition = ''; }
      ind.style.opacity = '1';
    };
    colocar();
    window.addEventListener('resize', colocar);
    return () => window.removeEventListener('resize', colocar);
  }, [openSection, triggerId, navRef, caben]);

  // Cierre (spec §8): el panel que se cierra se funde en `--motion-fast` antes de desmontarse. Con reduced-motion,
  // se oculta al instante. PR 4 (arquitectura 4.7): `saliendo` se deriva EN EL RENDER (patrón prevProp), no en un
  // efecto: React vuelve a renderizar antes de confirmar, así que el MISMO nodo del panel sigue montado y solo cambia
  // su clase. Con el efecto, el panel se desmontaba un fotograma y volvía como nodo nuevo, con el fundido desde cero.
  // Si se abre otro panel mientras el anterior se funde, el fundido sigue: solo se limpia si se reabre el que salía.
  if (openSection !== abiertaAntes) {
    setAbiertaAntes(openSection);
    if (abiertaAntes && !sinMovimiento()) setSaliendo(abiertaAntes);
    else if (saliendo === openSection || sinMovimiento()) setSaliendo(null);
  }
  useEffect(() => {
    if (!saliendo) return;
    const t = window.setTimeout(() => setSaliendo((s) => (s === saliendo ? null : s)), SALIDA_MS);
    return () => window.clearTimeout(t);
  }, [saliendo]);

  const enFila = grouped.slice(0, caben);
  const enMas = grouped.slice(caben);
  const masAbierto = openSection === MAS;
  const rutaEnMas = enMas.some((g) => g.section === routeSection);

  /** Props del contenedor del panel: el abierto lleva la ref; el que se cierra, el fundido y queda inerte. */
  const propsPanel = (clave: ClaveDock) => {
    const abierto = openSection === clave;
    return {
      ref: abierto ? panelRef : undefined,
      id: panelId(clave),
      'aria-hidden': abierto ? undefined : true,
      'data-saliendo': abierto ? undefined : 'true',
    };
  };

  const pintarSeccion = ({ section, items, proximamente }: SectionGroup) => {
    const titulo = SECTION_LABEL[section];
    const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>;
    if (items.length === 1) {
      const unico = items[0];
      return (
        <NavLink key={section} to={unico.to} end={finExacto(unico.to)} className="dock__item" data-seccion={section}>
          {glifo}<span className="dock__nombre">{unico.label}</span>
        </NavLink>
      );
    }
    const abierto = openSection === section;
    const visible = abierto || saliendo === section;
    // Área «Próximamente» (PR 4): el botón se describe con el aviso. Con el panel montado, la descripción es su cuerpo;
    // cerrado, un texto `hidden` con el mismo id (aria-describedby lo lee aunque esté oculto).
    const idAviso = `flit-navbar-proximamente-${section}`;
    const clasePanel = proximamente ? 'dock__menu' : 'dock__menu dock__menu--ancho dock__menu--area';
    return (
      <div key={section} className="dock__grupo" data-seccion={section} data-proximamente={proximamente ? 'true' : undefined}>
        <button type="button" className="dock__item" id={triggerId(section)} aria-expanded={abierto} aria-controls={abierto ? panelId(section) : undefined}
          aria-describedby={proximamente ? idAviso : undefined}
          aria-current={routeSection === section ? 'page' : undefined} onClick={() => toggle(section)}>
          {glifo}<span className="dock__nombre">{titulo}</span>
          <Icono nombre="arriba" className="dock__flecha" size={16} />
        </button>
        {proximamente && !visible && <span id={idAviso} hidden>{COPY_PROXIMAMENTE_TITULO} {COPY_PROXIMAMENTE_TEXTO}</span>}
        {visible && (
          <div {...propsPanel(section)} className={`${clasePanel} flit-panel-up${abierto ? '' : ' dock__menu--saliendo'}`} data-grupo={section}>
            <div className="dock__cabeza">
              <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>
              <div><strong>{titulo}</strong><small>{proximamente ? COPY_PROXIMAMENTE : `${items.length} módulos`}</small></div>
            </div>
            {proximamente
              ? <AvisoProximamente id={idAviso} />
              : <ContenidoPanel section={section} items={items} panelId={panelId(section)} />}
          </div>
        )}
      </div>
    );
  };

  const masVisible = masAbierto || saliendo === MAS;
  return (
    <>
      <nav ref={navRef} aria-label="Navegación principal" data-vt="floating-nav" className="dock flit-nav-capsule dock--indicador dock--entra"
        style={reservaDrFlit ? { maxWidth: 'min(calc(100vw - 16px), max(calc(100vw - 180px), 360px))' } : undefined}>
        <span ref={indicadorRef} className="dock__indicador" aria-hidden="true" />
        {enFila.map(pintarSeccion)}
        {enMas.length > 0 && (
          <div className="dock__grupo dock__grupo--mas" data-seccion="mas">
            <button type="button" className="dock__item" id={triggerId(MAS)} aria-expanded={masAbierto} aria-controls={masAbierto ? panelId(MAS) : undefined}
              aria-current={rutaEnMas ? 'page' : undefined} onClick={() => toggle(MAS)}>
              <span className="kico kico--mas" aria-hidden="true"><Icono nombre="puntos" size={22} /></span>
              <span className="dock__nombre">Más</span>
              <Icono nombre="arriba" className="dock__flecha" size={16} />
            </button>
            {masVisible && (
              <div {...propsPanel(MAS)} className={`dock__menu dock__menu--ancho dock__menu--area dock__menu--mas flit-panel-up${masAbierto ? '' : ' dock__menu--saliendo'}`} data-grupo="mas">
                <div className="dock__cabeza">
                  <span className="kico kico--mas" aria-hidden="true"><Icono nombre="puntos" size={22} /></span>
                  <div><strong>Más opciones</strong><small>{enMas.length} {enMas.length === 1 ? 'opción' : 'opciones'}</small></div>
                </div>
                <div className="rejilla-area">
                  {enMas.map(({ section, items, proximamente }) => (
                    <div key={section} className="dock__seccion" data-seccion={section}>
                      <p className="rejilla-sub">{SECTION_LABEL[section]}</p>
                      {proximamente
                        ? <p className="dock-proximamente-sub">{COPY_PROXIMAMENTE}</p>
                        : <RejillaEntradas items={items} />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </nav>
      {/* Espejo de medida: todas las opciones con nombre + «Más», invisible e inerte. */}
      <div ref={espejoRef} className="dock dock--medida" aria-hidden="true">
        {grouped.map(({ section, items }) => (
          <span key={section} className="dock__item">
            <span className="kico"><IconoGlifo icono={ICONO_SECCION[section]} /></span>
            <span className="dock__nombre">{items.length === 1 ? items[0].label : SECTION_LABEL[section]}</span>
            {items.length !== 1 && <Icono nombre="arriba" className="dock__flecha" size={16} />}
          </span>
        ))}
        <span className="dock__item">
          <span className="kico kico--mas"><Icono nombre="puntos" size={22} /></span>
          <span className="dock__nombre">Más</span>
          <Icono nombre="arriba" className="dock__flecha" size={16} />
        </span>
      </div>
    </>
  );
}

/** Cuerpo del panel de un área sin pantallas (PR 4): dos líneas, sin enlaces ni `role="status"` (lo abrió el usuario). */
function AvisoProximamente({ id }: { id: string }) {
  return (
    <div className="dock-proximamente" id={id}>
      <p className="dock-proximamente__titulo">{COPY_PROXIMAMENTE_TITULO}</p>
      <p className="dock-proximamente__texto">{COPY_PROXIMAMENTE_TEXTO}</p>
    </div>
  );
}

/** Rejilla plana (con subencabezados si la opción los tiene) o riel de subgrupos si pasa de 24 entradas. */
function ContenidoPanel({ section, items, panelId }: { section: NavItem['section']; items: NavItem[]; panelId: string }) {
  const grupos = groupItems(section, items);
  if (usaRiel(section, items) && grupos.length > 1) return <RielSubgrupos grupos={grupos} items={items} idBase={panelId} etiqueta={SECTION_LABEL[section]} />;
  return (
    <div className="rejilla-area">
      {grupos.map((g) => (
        <div key={g.title ?? '_'} className="dock__seccion">
          {g.title && <p className="rejilla-sub">{g.title}</p>}
          <RejillaEntradas items={g.items} />
        </div>
      ))}
    </div>
  );
}

/**
 * Riel vertical de subgrupos (spec §2 y §10): tablist APG con roving tabindex; ↑/↓ cambian con selección automática,
 * Inicio/Fin van al primero y al último. Arranca en el subgrupo de la página actual o, si no hay, en el primero.
 */
function RielSubgrupos({ grupos, items, idBase, etiqueta }: { grupos: ItemGroup[]; items: NavItem[]; idBase: string; etiqueta: string }) {
  const { pathname } = useLocation();
  const [sel, setSel] = useState(() => {
    const actual = entradaDeRuta(pathname, items);
    const i = actual ? grupos.findIndex((g) => g.title === groupOf(actual)) : -1;
    return i >= 0 ? i : 0;
  });
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const marcaRef = useRef<HTMLSpanElement>(null);

  // La barra azul se desliza hasta el subgrupo elegido (spec §8).
  useLayoutEffect(() => {
    const t = tabs.current[sel];
    const m = marcaRef.current;
    if (!t || !m) return;
    m.style.height = `${t.offsetHeight}px`;
    m.style.transform = `translateY(${t.offsetTop}px)`;
  }, [sel]);

  const tabId = (i: number) => `${idBase}-sub-${i}-tab`;
  const tabpanelId = (i: number) => `${idBase}-sub-${i}`;
  const elegir = (i: number) => {
    const j = (i + grupos.length) % grupos.length;
    setSel(j);
    tabs.current[j]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const destino = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: grupos.length - 1 }[e.key];
    if (destino === undefined) return;
    e.preventDefault();
    elegir(destino);
  };

  return (
    <div className="panel-riel">
      <div className="riel" role="tablist" aria-orientation="vertical" aria-label={`Subgrupos de ${etiqueta}`}>
        <span ref={marcaRef} className="riel__marca" aria-hidden="true" />
        {grupos.map((g, i) => (
          <button key={g.title ?? '_'} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab" className="riel__tab" style={escalon(i)}
            id={tabId(i)} aria-selected={i === sel} aria-controls={tabpanelId(i)} tabIndex={i === sel ? 0 : -1}
            onClick={() => setSel(i)} onKeyDown={(e) => onKeyDown(e, i)}>
            <span className="riel__nombre">{g.title ?? 'Otros'}</span>
            <span className="riel__cuenta" aria-hidden="true">{g.items.length}</span>
          </button>
        ))}
      </div>
      {grupos.map((g, i) => (
        <div key={g.title ?? '_'} role="tabpanel" className="riel__panel" id={tabpanelId(i)} aria-labelledby={tabId(i)} hidden={i !== sel}>
          {i === sel && <RejillaEntradas items={g.items} />}
        </div>
      ))}
    </div>
  );
}

function RejillaEntradas({ items }: { items: NavItem[] }) {
  return (
    <ul className="rejilla-entradas">
      {items.map((item, i) => (
        <li key={item.to} style={escalon(i)}>
          <NavLink to={item.to} end={finExacto(item.to)} className="dock__entrada entrada-compacta" title={descripcionDeRuta(item.to)}>
            <span className="kico" aria-hidden="true"><IconoGlifo icono={iconoDeRuta(item.to)} /></span>
            <span className="entrada-compacta__nombre">{item.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
