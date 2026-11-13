import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { SECTION_LABEL, type NavItem } from '../shell/navItems';
import { useNavSections } from '../shell/useNavSections';
import { useDisclosureNav } from '../shell/useDisclosureNav';
import { groupItems } from '../shell/sectionMeta';
import { ICONO_SECCION, descripcionDeRuta, iconoDeRuta } from '../shell/iconosNav';
import { Icono } from './kit/Icono';
import { IconoGlifo } from './kit/IconoGlifo';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';
import { useDesdeLg } from '../shell/useDesdeLg';

// FlitNavBar — dock inferior flotante del UI Kit 2026 (`.dock` de la propuesta-2; shell.css de flit develop).
//
// ESTRUCTURA = la del menú original; PIEL = la del kit. Un botón por SECCIÓN del catálogo de permisos, en
// SECTION_ORDER (General, Gestión, Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración,
// Ayuda) y con sus nombres (SECTION_LABEL). Dentro de cada panel, los ítems en el orden de NAV_ENTRADAS; Gestión
// y PESV en columnas con sus subgrupos de siempre (`groupItems`). Nada se reagrupa aquí: así lo que el usuario ve
// en el menú es lo que lee en Roles y permisos. Trampas que se conservan (GUIA-DOCK-INFERIOR-FLOTANTE §12):
//   · el filtrado por permisos NO vive aquí: es `useNavSections` (mismo árbol que el buscador);
//   · disclosure APG (button aria-expanded + lista de enlaces), SIN role="menu";
//   · una sección con una sola página es enlace directo con el nombre del ítem, como en el menú original (General → Tablero);
//   · el panel abre HACIA ARRIBA; los paneles anchos (y el del «Más») ≤1100 px el CSS del kit los fija a lo ancho.
//
// Once secciones no caben con nombre en cualquier ancho. Desde 1024 px el dock MIDE cuántas secciones caben CON
// nombre (depende de cuántas ve cada rol y del ancho): esas van en la fila, en SECTION_ORDER; las que no, en un botón
// «Más» al final cuyo panel las lista en el mismo orden. Ya no hay modo solo-íconos. Por debajo de 1024 px no hay
// dock: la navegación es el ☰ del topbar y el menú lateral (FlitSidebar), como en develop (`hidden lg:flex`).

type ClaveDock = NavItem['section'] | 'mas';
const MAS: ClaveDock = 'mas';

/** Margen lateral del dock (16 px por lado) y reserva simétrica del botón de Dr. Flit (16 + 48 + 16 por lado). */
const MARGEN = 32;
const RESERVA_DRFLIT = 160;

/**
 * Cuántas secciones caben con nombre. Mide una fila ESPEJO (fuera de pantalla, `aria-hidden`, siempre con todas las
 * secciones y el «Más»), no la fila real: así la medida no depende de cuántas se muestran y el dock no oscila al
 * recortar (la memoria anti-parpadeo que antes guardaba `anchoDeLaFila` queda implícita en el espejo). Misma suma
 * que `anchoDeLaFila`: anchos de los hijos + gaps + padding + borde.
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
  const panelRef = useRef<HTMLDivElement>(null);
  const espejoRef = useRef<HTMLDivElement>(null);
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav<ClaveDock>('flit-navbar', [panelRef]);
  const reservaDrFlit = useDrFlitVisible();
  const [caben, setCaben] = useState(grouped.length);
  const firma = grouped.map((g) => `${g.section}:${g.items.length}`).join('|');

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

  if (grouped.length === 0) return null;

  const enFila = grouped.slice(0, caben);
  const enMas = grouped.slice(caben);
  const masAbierto = openSection === MAS;
  const rutaEnMas = enMas.some((g) => g.section === routeSection);

  const pintarSeccion = ({ section, items }: (typeof grouped)[number]) => {
    const titulo = SECTION_LABEL[section];
    const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>;
    if (items.length === 1) {
      const unico = items[0];
      return (
        <NavLink key={section} to={unico.to} end={unico.to === '/'} className="dock__item" data-seccion={section}>
          {glifo}<span className="dock__nombre">{unico.label}</span>
        </NavLink>
      );
    }
    const abierto = openSection === section;
    const subgrupos = groupItems(section, items);
    const ancho = subgrupos.length > 1;
    return (
      <div key={section} className="dock__grupo" data-seccion={section}>
        <button type="button" className="dock__item" id={triggerId(section)} aria-expanded={abierto} aria-controls={abierto ? panelId(section) : undefined}
          aria-current={routeSection === section ? 'page' : undefined} onClick={() => toggle(section)}>
          {glifo}<span className="dock__nombre">{titulo}</span>
          <Icono nombre="arriba" className="dock__flecha" size={16} />
        </button>
        {abierto && (
          <div ref={panelRef} id={panelId(section)} className={`dock__menu flit-panel-up${ancho ? ' dock__menu--ancho' : ''}`} data-grupo={section}>
            <div className="dock__cabeza">
              <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>
              <div><strong>{titulo}</strong><small>{items.length} módulos</small></div>
            </div>
            {ancho ? (
              <div className="dock__secciones">
                {subgrupos.map((s) => (
                  <div key={s.title ?? '_'} className="dock__seccion">
                    {s.title && <p>{s.title}</p>}
                    <ListaEntradas items={s.items} />
                  </div>
                ))}
              </div>
            ) : (
              <ListaEntradas items={items} />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <nav ref={navRef} aria-label="Navegación principal" data-vt="floating-nav" className="dock flit-nav-capsule"
        style={reservaDrFlit ? { maxWidth: 'min(calc(100vw - 16px), max(calc(100vw - 180px), 360px))' } : undefined}>
        {enFila.map(pintarSeccion)}
        {enMas.length > 0 && (
          <div className="dock__grupo dock__grupo--mas" data-seccion="mas">
            <button type="button" className="dock__item" id={triggerId(MAS)} aria-expanded={masAbierto} aria-controls={masAbierto ? panelId(MAS) : undefined}
              aria-current={rutaEnMas ? 'page' : undefined} onClick={() => toggle(MAS)}>
              <span className="kico kico--mas" aria-hidden="true"><Icono nombre="puntos" size={22} /></span>
              <span className="dock__nombre">Más</span>
              <Icono nombre="arriba" className="dock__flecha" size={16} />
            </button>
            {masAbierto && (
              <div ref={panelRef} id={panelId(MAS)} className="dock__menu dock__menu--ancho dock__menu--mas flit-panel-up" data-grupo="mas">
                <div className="dock__cabeza">
                  <span className="kico kico--mas" aria-hidden="true"><Icono nombre="puntos" size={22} /></span>
                  <div><strong>Más secciones</strong><small>{enMas.length} {enMas.length === 1 ? 'sección' : 'secciones'}</small></div>
                </div>
                <div className="dock__secciones">
                  {enMas.map(({ section, items }) => (
                    <div key={section} className="dock__seccion" data-seccion={section}>
                      <p>{SECTION_LABEL[section]}</p>
                      <ListaEntradas items={items} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </nav>
      {/* Espejo de medida: todas las secciones con nombre + «Más», invisible e inerte. */}
      <div ref={espejoRef} className="dock dock--medida" aria-hidden="true">
        {grouped.map(({ section, items }) => (
          <span key={section} className="dock__item">
            <span className="kico"><IconoGlifo icono={ICONO_SECCION[section]} /></span>
            <span className="dock__nombre">{items.length === 1 ? items[0].label : SECTION_LABEL[section]}</span>
            {items.length > 1 && <Icono nombre="arriba" className="dock__flecha" size={16} />}
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

function ListaEntradas({ items }: { items: NavItem[] }) {
  return (
    <ul>
      {items.map((item) => {
        const descripcion = descripcionDeRuta(item.to);
        return (
          <li key={item.to}>
            <NavLink to={item.to} end={item.to === '/'} className="dock__entrada">
              <span className="kico" aria-hidden="true"><IconoGlifo icono={iconoDeRuta(item.to)} /></span>
              <span><strong>{item.label}</strong>{descripcion && <small>{descripcion}</small>}</span>
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
