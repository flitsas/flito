import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { SECTION_LABEL, type NavItem } from '../shell/navItems';
import { useNavSections, type SectionGroup } from '../shell/useNavSections';
import { finExacto, groupItems, groupOf } from '../shell/sectionMeta';
import { ICONO_SECCION, iconoDeRuta } from '../shell/iconosNav';
import { COPY_MENU_ERROR, COPY_MENU_VACIO, useEstadoMenu, type EstadoDelMenu } from '../shell/useEstadoMenu';
import { useEscape, useFocusTrap } from '../../lib/hooks';
import ModalPortal from './ModalPortal';
import { Icono } from './kit/Icono';
import { IconoGlifo } from './kit/IconoGlifo';

// FlitSidebar — menú lateral de navegación por debajo de 1024 px (Épica #14560), donde no hay dock. Lo abre el ☰ del
// topbar. ESTRUCTURA = la del dock: las opciones de `useNavSections` en SECTION_ORDER y sus entradas en el orden de
// NAV_ITEMS; una opción con una sola entrada es enlace directo con el nombre de la entrada.
// Épica #14678 (spec UX §3): acordeón con VARIAS opciones abiertas a la vez; de entrada, la de la página actual. Los
// subgrupos (Kyverum: siete; Gerencial: Torre de Control) son plegables con su cantidad, y se abre el de la página
// actual; las entradas sin subgrupo (Tablero) van sueltas. Lo cerrado usa `visibility: hidden` (fuera de Tab y del
// árbol de accesibilidad) y la altura se anima con `grid-template-rows`.
// PIEL = la del modal del kit (`kit-velo` + `kit-modal--lateral`), anclado a la izquierda, junto al ☰.
// Comportamiento: diálogo modal con trampa de foco (la de FlitModal, `useFocusTrap`); Escape y «Cerrar» lo cierran y
// el foco vuelve al ☰; pulsar el velo lo cierra (es navegación, no un formulario); navegar lo cierra (AppShell).
// El filtrado por permisos NO vive aquí: es `useNavSections`, el mismo árbol que el dock y el buscador.

export const MENU_LATERAL_ID = 'flit-menu-lateral';

interface FlitSidebarProps {
  open: boolean;
  onClose: () => void;
  /** El ☰: respaldo del foco si el elemento que abrió el menú ya no existe. */
  botonRef?: RefObject<HTMLButtonElement>;
}

export default function FlitSidebar({ open, onClose, botonRef }: FlitSidebarProps) {
  if (!open) return null;
  return <MenuLateral onClose={onClose} botonRef={botonRef} />;
}

/** Clave de un subgrupo plegable dentro de una opción. */
const claveSub = (section: NavItem['section'], titulo: string) => `${section}::${titulo}`;

function MenuLateral({ onClose, botonRef }: Omit<FlitSidebarProps, 'open'>) {
  const { grouped, routeSection, visibleItems } = useNavSections();
  const menu = useEstadoMenu(grouped);
  const { pathname } = useLocation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Abiertos de entrada: la opción de la página actual y, dentro, su subgrupo.
  const [abiertas, setAbiertas] = useState<Set<string>>(() => {
    const inicial = new Set<string>();
    if (routeSection) inicial.add(routeSection);
    const actual = visibleItems
      .filter((it) => (it.to === '/' ? pathname === '/' : pathname === it.to || pathname.startsWith(`${it.to}/`)))
      .sort((a, b) => b.to.length - a.to.length)[0];
    const sub = actual ? groupOf(actual) : null;
    if (actual && sub) inicial.add(claveSub(actual.section, sub));
    return inicial;
  });

  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) onClose();
  });
  useFocusTrap(dialogRef, true, botonRef);

  const alternar = (clave: string) => setAbiertas((prev) => {
    const next = new Set(prev);
    if (next.has(clave)) next.delete(clave);
    else next.add(clave);
    return next;
  });

  return (
    <ModalPortal>
      <div ref={overlayRef} data-flit-modal="" className="flit-modal kit-velo menu-lateral__velo"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={dialogRef} id={MENU_LATERAL_ID} role="dialog" aria-modal="true" aria-label="Menú de navegación" tabIndex={-1}
          className="kit-modal kit-modal--lateral menu-lateral outline-none">
          <div className="kit-modal__cabeza">
            <h2 className="kit-modal__titulo">Menú</h2>
            <button type="button" onClick={onClose} aria-label="Cerrar menú" className="kit-modal__cerrar">
              <Icono nombre="cerrar" size={20} />
            </button>
          </div>
          <nav aria-label="Navegación principal" className="menu-lateral__cuerpo">
            {menu.estado === 'lleno'
              ? (
                <ul className="menu-lateral__secciones">
                  {grouped.map((g) => (
                    <Opcion key={g.section} grupo={g} activa={routeSection === g.section} abiertas={abiertas} alternar={alternar} onClose={onClose} />
                  ))}
                </ul>
              )
              : <EstadoLateral menu={menu} ayuda={grouped.find((g) => g.section === 'ayuda')} onClose={onClose} />}
          </nav>
        </div>
      </div>
    </ModalPortal>
  );
}

/** Cargando, error y vacío del menú lateral (spec §4): mismo mensaje que el dock, arriba del cajón. */
function EstadoLateral({ menu, ayuda, onClose }: { menu: EstadoDelMenu; ayuda?: SectionGroup; onClose: () => void }) {
  const [giro, setGiro] = useState(0);
  if (menu.estado === 'cargando') {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando menú" data-kit="esqueleto" className="menu-lateral__esqueleto">
        {[0, 1, 2, 3, 4].map((i) => <span key={i} className="kit-esqueleto menu-lateral__esqueleto-fila" />)}
      </div>
    );
  }
  if (menu.estado === 'error') {
    return (
      <div className="menu-lateral__estado">
        <p className="dock-aviso menu-lateral__aviso" data-tono="danger" role="alert">
          <img src="/kit/aviso-error.svg" alt="" aria-hidden="true" className="dock-aviso__icono" />
          <span>{COPY_MENU_ERROR}</span>
        </p>
        <button type="button" className="menu-lateral__fila dock-reintentar" aria-busy={menu.reintentando || undefined}
          onClick={() => { setGiro((g) => g + 1); menu.reintentar(); }}>
          <span key={giro} className={`kico${giro > 0 ? ' dock-reintentar__giro' : ''}`} aria-hidden="true"><IconoGlifo icono="reintento" /></span>
          <span className="menu-lateral__nombre">Reintentar</span>
        </button>
      </div>
    );
  }
  const unico = ayuda?.items[0];
  return (
    <div className="menu-lateral__estado">
      <p className="dock-aviso menu-lateral__aviso" data-tono="info" role="status">
        <img src="/kit/aviso-info.svg" alt="" aria-hidden="true" className="dock-aviso__icono" />
        <span>{COPY_MENU_VACIO}</span>
      </p>
      {unico && (
        <NavLink to={unico.to} onClick={onClose} className="menu-lateral__fila" data-seccion="ayuda">
          <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION.ayuda} /></span>
          <span className="menu-lateral__nombre">{unico.label}</span>
        </NavLink>
      )}
    </div>
  );
}

function Opcion({ grupo, activa, abiertas, alternar, onClose }: {
  grupo: SectionGroup; activa: boolean; abiertas: ReadonlySet<string>; alternar: (clave: string) => void; onClose: () => void;
}) {
  const { section, items } = grupo;
  const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>;
  if (items.length === 1) {
    const unico = items[0];
    return (
      <li data-seccion={section}>
        <NavLink to={unico.to} end={finExacto(unico.to)} onClick={onClose} className="menu-lateral__fila">
          {glifo}<span className="menu-lateral__nombre">{unico.label}</span>
        </NavLink>
      </li>
    );
  }
  const abierta = abiertas.has(section);
  const panelId = `${MENU_LATERAL_ID}-${section}`;
  const subgrupos = groupItems(section, items);
  return (
    <li data-seccion={section}>
      <button type="button" className="menu-lateral__fila" id={`${panelId}-boton`} aria-expanded={abierta} aria-controls={panelId}
        aria-current={activa ? 'true' : undefined} onClick={() => alternar(section)}>
        {glifo}<span className="menu-lateral__nombre">{SECTION_LABEL[section]}</span>
        <span className="menu-lateral__cuenta" aria-hidden="true">{items.length}</span>
        <Icono nombre="abajo" className="menu-lateral__flecha" size={16} />
      </button>
      <Acordeon id={panelId} abierto={abierta}>
        <ul className="menu-lateral__entradas">
          {subgrupos.map((s, i) => {
            if (!s.title) return <Entradas key={`_${i}`} items={s.items} onClose={onClose} />;
            const clave = claveSub(section, s.title);
            const subId = `${panelId}-${i}`;
            const subAbierto = abiertas.has(clave);
            return (
              <li key={s.title}>
                <button type="button" className="menu-lateral__entrada menu-lateral__sub" aria-expanded={subAbierto} aria-controls={subId}
                  onClick={() => alternar(clave)}>
                  <span className="menu-lateral__nombre">{s.title}</span>
                  <span className="menu-lateral__cuenta" aria-hidden="true">{s.items.length}</span>
                  <Icono nombre="abajo" className="menu-lateral__flecha" size={16} />
                </button>
                <Acordeon id={subId} abierto={subAbierto}>
                  <ul className="menu-lateral__entradas menu-lateral__entradas--sub"><Entradas items={s.items} onClose={onClose} /></ul>
                </Acordeon>
              </li>
            );
          })}
        </ul>
      </Acordeon>
    </li>
  );
}

/** Contenido plegable con altura animada (`grid-template-rows` 0fr → 1fr); cerrado = `visibility: hidden`. */
function Acordeon({ id, abierto, children }: { id: string; abierto: boolean; children: ReactNode }) {
  return (
    <div id={id} className="menu-lateral__plegable" data-abierto={abierto ? 'true' : 'false'}>
      <div className="menu-lateral__plegable-interior">{children}</div>
    </div>
  );
}

function Entradas({ items, onClose }: { items: NavItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink to={item.to} end={finExacto(item.to)} onClick={onClose} className="menu-lateral__entrada">
            <span className="kico" aria-hidden="true"><IconoGlifo icono={iconoDeRuta(item.to)} /></span>
            <span>{item.label}</span>
          </NavLink>
        </li>
      ))}
    </>
  );
}
