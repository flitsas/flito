import { useRef, useState, type RefObject } from 'react';
import { NavLink } from 'react-router-dom';
import { SECTION_LABEL, type NavItem } from '../shell/navItems';
import { useNavSections } from '../shell/useNavSections';
import { ICONO_SECCION, iconoDeRuta } from '../shell/iconosNav';
import { useEscape, useFocusTrap } from '../../lib/hooks';
import ModalPortal from './ModalPortal';
import { Icono } from './kit/Icono';
import { IconoGlifo } from './kit/IconoGlifo';

// FlitSidebar — menú lateral de navegación por debajo de 1024 px (Épica #14560), donde no hay dock. Lo abre el ☰ del
// topbar. ESTRUCTURA = la del dock: las secciones de `useNavSections` en SECTION_ORDER y sus ítems en el orden de
// NAV_ENTRADAS; una sección con una sola página es enlace directo con el nombre del ítem (General → Tablero).
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

function MenuLateral({ onClose, botonRef }: Omit<FlitSidebarProps, 'open'>) {
  const { grouped, routeSection } = useNavSections();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Abierta de entrada solo la sección de la página actual: once secciones desplegadas no caben en un teléfono.
  const [abiertas, setAbiertas] = useState<Set<NavItem['section']>>(() => new Set(routeSection ? [routeSection] : []));

  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) onClose();
  });
  useFocusTrap(dialogRef, true, botonRef);

  const alternar = (section: NavItem['section']) => setAbiertas((prev) => {
    const next = new Set(prev);
    if (next.has(section)) next.delete(section);
    else next.add(section);
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
            <ul className="menu-lateral__secciones">
              {grouped.map(({ section, items }) => {
                const titulo = SECTION_LABEL[section];
                const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={ICONO_SECCION[section]} /></span>;
                if (items.length === 1) {
                  const unico = items[0];
                  return (
                    <li key={section} data-seccion={section}>
                      <NavLink to={unico.to} end={unico.to === '/'} onClick={onClose} className="menu-lateral__fila">
                        {glifo}<span className="menu-lateral__nombre">{unico.label}</span>
                      </NavLink>
                    </li>
                  );
                }
                const abierta = abiertas.has(section);
                const panelId = `${MENU_LATERAL_ID}-${section}`;
                return (
                  <li key={section} data-seccion={section}>
                    <button type="button" className="menu-lateral__fila" id={`${panelId}-boton`} aria-expanded={abierta} aria-controls={panelId}
                      aria-current={routeSection === section ? 'true' : undefined} onClick={() => alternar(section)}>
                      {glifo}<span className="menu-lateral__nombre">{titulo}</span>
                      <span className="menu-lateral__cuenta" aria-hidden="true">{items.length}</span>
                      <Icono nombre="abajo" className="menu-lateral__flecha" size={16} />
                    </button>
                    <ul id={panelId} className="menu-lateral__entradas" hidden={!abierta}>
                      {items.map((item) => (
                        <li key={item.to}>
                          <NavLink to={item.to} end={item.to === '/'} onClick={onClose} className="menu-lateral__entrada">
                            <span className="kico" aria-hidden="true"><IconoGlifo icono={iconoDeRuta(item.to)} /></span>
                            <span>{item.label}</span>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </div>
    </ModalPortal>
  );
}
