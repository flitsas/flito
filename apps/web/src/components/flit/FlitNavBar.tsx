import { useMemo, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useNavSections } from '../shell/useNavSections';
import { useDisclosureNav } from '../shell/useDisclosureNav';
import { agruparDock, grupoDeRuta, type GrupoDock, type GrupoDockId } from '../shell/dockGrupos';
import { Icono } from './kit/Icono';
import { IconoGlifo } from './kit/IconoGlifo';
import { useDrFlitVisible } from '../drflit/useDrFlitVisible';

// FlitNavBar — dock inferior flotante del UI Kit 2026 (`.dock` de la propuesta-2; shell.css de flit develop).
//
// Es la implementación de referencia del dock de la suite (GUIA-DOCK-INFERIOR-FLOTANTE §13): se REVISTE, no se
// reemplaza. Se conservan sus trampas (§12):
//   · el filtrado por permisos NO vive aquí: es `useNavSections` (mismo árbol que el buscador);
//   · disclosure APG (button aria-expanded + lista de enlaces), SIN role="menu";
//   · el nombre del grupo sigue en el DOM aunque se condense (sr-only): el nombre accesible no cambia;
//   · red de seguridad «Más» (dockGrupos.ts): solo aparece si una ruta nueva queda sin grupo (hoy ninguna);
//   · mapa de íconos inyectivo dentro de cada menú;
//   · el panel abre HACIA ARRIBA; en tableta/teléfono el CSS del kit lo fija a lo ancho (sin recorte del scroll).
//
// Reparto (briefing flit-de §3): izquierda Trámites · Impuestos y SOAT · Logística; Inicio al centro (isotipo);
// derecha Flota · Finanzas · Cumplimiento. Un grupo con una sola página es enlace directo.
//
// Nombres visibles en todo el rango >1100 px para todos los roles (dock 3 + 3, decisión de diseño, ronda 2); ≤1100 px
// solo íconos, por el CSS del kit (el nombre sigue en el DOM para lectores de pantalla). Administración no va
// en el dock: vive en el menú de usuario (FlitTopbar).

export default function FlitNavBar() {
  const { visibleItems } = useNavSections();
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav<GrupoDockId>('flit-navbar', [panelRef]);
  const reservaDrFlit = useDrFlitVisible();
  const grupos = useMemo(() => agruparDock(visibleItems), [visibleItems]);
  const activo = grupoDeRuta(pathname, grupos);

  // «Inicio» (el Tablero, `/`) es el isotipo del centro: solo con permiso de la página, como el resto del dock.
  const conInicio = visibleItems.some((it) => it.to === '/');
  if (grupos.length === 0 && !conInicio) return null;
  const izq = grupos.filter((g) => g.lado === 'izq');
  const der = grupos.filter((g) => g.lado === 'der');

  const pintarGrupo = (g: GrupoDock) => {
    const unico = g.total === 1 ? g.secciones[0].entradas[0] : null;
    const esActivo = activo === g.id;
    const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={g.icono} /></span>;
    const nombre = <span>{g.titulo}</span>;
    if (unico) {
      return (
        <NavLink key={g.id} to={unico.item.to} end={unico.item.to === '/'} className="dock__item">
          {glifo}<span>{unico.item.label}</span>
        </NavLink>
      );
    }
    const abierto = openSection === g.id;
    const ancho = g.secciones.length > 1;
    return (
      <div key={g.id} className="dock__grupo">
        <button type="button" className="dock__item" id={triggerId(g.id)} aria-expanded={abierto} aria-controls={abierto ? panelId(g.id) : undefined}
          aria-current={esActivo ? 'page' : undefined} onClick={() => toggle(g.id)}>
          {glifo}{nombre}
          <Icono nombre="arriba" className="dock__flecha" size={16} />
        </button>
        {abierto && (
          <div ref={panelRef} id={panelId(g.id)} className={`dock__menu flit-panel-up${ancho ? ' dock__menu--ancho' : ''}`} data-grupo={g.id}>
            <div className="dock__cabeza">
              <span className="kico" aria-hidden="true"><IconoGlifo icono={g.icono} /></span>
              <div><strong>{g.titulo}</strong><small>{g.total} módulos</small></div>
            </div>
            {ancho ? (
              <div className="dock__secciones">
                {g.secciones.map((s) => (
                  <div key={s.titulo || '_'} className="dock__seccion">
                    {s.titulo && <p>{s.titulo}</p>}
                    <ListaEntradas entradas={s.entradas} />
                  </div>
                ))}
              </div>
            ) : (
              <ListaEntradas entradas={g.secciones[0].entradas} />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav ref={navRef} aria-label="Navegación principal" data-vt="floating-nav"
      className="dock flit-nav-capsule"
      style={reservaDrFlit ? { maxWidth: 'min(calc(100vw - 16px), max(calc(100vw - 180px), 360px))' } : undefined}>
      {izq.map(pintarGrupo)}
      {conInicio && (
        <NavLink to="/" end className="dock__fab" aria-label="Inicio">
          <img src="/kit/isotipo.svg" alt="" aria-hidden="true" />
        </NavLink>
      )}
      {der.map(pintarGrupo)}
    </nav>
  );
}

function ListaEntradas({ entradas }: { entradas: GrupoDock['secciones'][number]['entradas'] }) {
  return (
    <ul>
      {entradas.map(({ item, icono, descripcion }) => (
        <li key={item.to}>
          <NavLink to={item.to} end={item.to === '/'} className="dock__entrada">
            <span className="kico" aria-hidden="true"><IconoGlifo icono={icono} /></span>
            <span><strong>{item.label}</strong>{descripcion && <small>{descripcion}</small>}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
