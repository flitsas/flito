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

// FlitNavBar — dock inferior flotante del UI Kit 2026 (`.dock` de la propuesta-2; shell.css de flit develop).
//
// ESTRUCTURA = la del menú original; PIEL = la del kit. Un botón por SECCIÓN del catálogo de permisos, en
// SECTION_ORDER (General, Gestión, Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración,
// Ayuda) y con sus nombres (SECTION_LABEL). Dentro de cada panel, los ítems en el orden de NAV_ENTRADAS; Gestión
// y PESV en columnas con sus subgrupos de siempre (`groupItems`). Nada se reagrupa aquí: así lo que el usuario ve
// en el menú es lo que lee en Roles y permisos. Trampas que se conservan (GUIA-DOCK-INFERIOR-FLOTANTE §12):
//   · el filtrado por permisos NO vive aquí: es `useNavSections` (mismo árbol que el buscador);
//   · disclosure APG (button aria-expanded + lista de enlaces), SIN role="menu";
//   · el nombre de la sección sigue en el DOM aunque se condense (sr-only): el nombre accesible no cambia;
//   · una sección con una sola página es enlace directo con el nombre de la sección (General → Tablero);
//   · el panel abre HACIA ARRIBA; en tableta/teléfono el CSS del kit lo fija a lo ancho.
//
// Once secciones no caben con nombre en cualquier ancho. El dock MIDE si la fila con nombres cabe en el hueco
// disponible (depende de cuántas secciones ve cada rol): si cabe, ícono + nombre; si no, solo íconos
// (`dock--compacto`, nombre en sr-only y en `title`). Una sola fila siempre; ≤1100 px el CSS del kit ya condensa.

/** Ancho que ocupa la fila del dock sumando sus hijos (no `scrollWidth`: no depende de que desborde). */
function anchoDeLaFila(nav: HTMLElement): number {
  const cs = getComputedStyle(nav);
  const gap = parseFloat(cs.columnGap) || 0;
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const hijos = Array.from(nav.children) as HTMLElement[];
  const suma = hijos.reduce((total, hijo) => total + hijo.getBoundingClientRect().width, 0);
  return suma + gap * Math.max(0, hijos.length - 1) + padX + (nav.offsetWidth - nav.clientWidth);
}

/** Margen lateral del dock (16 px por lado) y reserva simétrica del botón de Dr. Flit (16 + 48 + 16 por lado). */
const MARGEN = 32;
const RESERVA_DRFLIT = 160;

export default function FlitNavBar() {
  const { grouped, routeSection } = useNavSections();
  const panelRef = useRef<HTMLDivElement>(null);
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav<NavItem['section']>('flit-navbar', [panelRef]);
  const reservaDrFlit = useDrFlitVisible();
  const [compacto, setCompacto] = useState(false);
  // Histéresis con memoria: se mide la fila CON nombres y se guarda; condensado, se decide con esa medida
  // (si se volviera a medir, la fila encogida «cabría» y el dock oscilaría).
  const necesarioRef = useRef<number | null>(null);
  const firma = grouped.map((g) => `${g.section}:${g.items.length}`).join('|');

  useLayoutEffect(() => {
    necesarioRef.current = null;
    setCompacto(false);
  }, [firma]);

  useLayoutEffect(() => {
    const decidir = () => {
      const nav = navRef.current;
      if (!nav) return;
      if (!compacto || necesarioRef.current === null) necesarioRef.current = anchoDeLaFila(nav);
      const disponible = window.innerWidth - MARGEN - (reservaDrFlit ? RESERVA_DRFLIT : 0);
      const siguiente = (necesarioRef.current ?? 0) > disponible;
      if (siguiente !== compacto) setCompacto(siguiente);
    };
    decidir();
    window.addEventListener('resize', decidir);
    return () => window.removeEventListener('resize', decidir);
  }, [compacto, reservaDrFlit, firma, navRef]);

  if (grouped.length === 0) return null;

  const pintarSeccion = ({ section, items }: (typeof grouped)[number]) => {
    const titulo = SECTION_LABEL[section];
    const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>;
    if (items.length === 1) {
      const unico = items[0];
      return (
        <NavLink key={section} to={unico.to} end={unico.to === '/'} className="dock__item" data-seccion={section}
          title={unico.label}>
          {glifo}<span className="dock__nombre">{titulo}</span>
        </NavLink>
      );
    }
    const abierto = openSection === section;
    const subgrupos = groupItems(section, items);
    const ancho = subgrupos.length > 1;
    return (
      <div key={section} className="dock__grupo" data-seccion={section}>
        <button type="button" className="dock__item" id={triggerId(section)} aria-expanded={abierto} aria-controls={abierto ? panelId(section) : undefined}
          aria-current={routeSection === section ? 'page' : undefined} title={compacto ? titulo : undefined} onClick={() => toggle(section)}>
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
    <nav ref={navRef} aria-label="Navegación principal" data-vt="floating-nav"
      className={`dock flit-nav-capsule${compacto ? ' dock--compacto' : ''}`}
      style={reservaDrFlit ? { maxWidth: 'min(calc(100vw - 16px), max(calc(100vw - 180px), 360px))' } : undefined}>
      {grouped.map(pintarSeccion)}
    </nav>
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
