import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
//   · cubo «Más» para las rutas que el reparto no reclama (dockGrupos.ts): nunca se pierde un ítem;
//   · mapa de íconos inyectivo dentro de cada menú;
//   · el panel abre HACIA ARRIBA; en tableta/teléfono el CSS del kit lo fija a lo ancho (sin recorte del scroll).
//
// Reparto (briefing flit-de §3): izquierda Trámites · Impuestos y SOAT · Logística; Inicio al centro (isotipo);
// derecha Flota · Finanzas · Cumplimiento · Administración. Un grupo con una sola página es enlace directo.
//
// Condensado por ANCHO (HU #11900, se conserva la idea): si la fila con nombres no cabe, solo íconos. Se MIDE, no
// es un breakpoint ciego: un rol con tres grupos no pierde los nombres a 1100 px. Histéresis con memoria para no
// oscilar (al condensar la fila encoge y «volvería a caber»). El CSS del kit además oculta nombres ≤1100 px.

function anchoDeLaFila(nav: HTMLElement): number {
  const cs = getComputedStyle(nav);
  const gap = parseFloat(cs.columnGap) || 0;
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const hijos = Array.from(nav.children) as HTMLElement[];
  const suma = hijos.reduce((total, hijo) => total + hijo.getBoundingClientRect().width, 0);
  return suma + gap * Math.max(0, hijos.length - 1) + padX + 2;
}

export default function FlitNavBar() {
  const { visibleItems } = useNavSections();
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav<GrupoDockId>('flit-navbar', [panelRef]);
  const reservaDrFlit = useDrFlitVisible();
  const grupos = useMemo(() => agruparDock(visibleItems), [visibleItems]);
  const activo = grupoDeRuta(pathname, grupos);

  const [condensado, setCondensado] = useState(false);
  const memoria = useRef<{ condensado: boolean; necesario: number | null }>({ condensado: false, necesario: null });
  const medir = () => {
    const nav = navRef.current;
    if (!nav) return;
    const reserva = reservaDrFlit && window.innerWidth >= 1024 ? 160 : 16;
    const disponible = window.innerWidth - reserva;
    if (!memoria.current.condensado) memoria.current.necesario = anchoDeLaFila(nav);
    const necesario = memoria.current.necesario;
    if (necesario == null) return;
    const siguiente = necesario > disponible;
    if (siguiente !== memoria.current.condensado) {
      memoria.current.condensado = siguiente;
      setCondensado(siguiente);
    }
  };
  const medirRef = useRef(medir);
  medirRef.current = medir;
  useLayoutEffect(() => { medirRef.current(); });
  const firma = grupos.map((g) => `${g.id}:${g.total}`).join('·');
  const firmaPrevia = useRef(firma);
  useEffect(() => {
    if (firmaPrevia.current === firma) return;
    firmaPrevia.current = firma;
    memoria.current = { condensado: false, necesario: null };
    setCondensado(false);
  }, [firma]);
  useEffect(() => {
    const onResize = () => medirRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (grupos.length === 0) return null;
  const izq = grupos.filter((g) => g.lado === 'izq');
  const der = grupos.filter((g) => g.lado === 'der');

  const pintarGrupo = (g: GrupoDock) => {
    const unico = g.total === 1 ? g.secciones[0].entradas[0] : null;
    const esActivo = activo === g.id;
    const glifo = <span className="kico" aria-hidden="true"><IconoGlifo icono={g.icono} /></span>;
    const nombre = <span className={condensado ? 'sr-only' : undefined}>{g.titulo}</span>;
    if (unico) {
      return (
        <NavLink key={g.id} to={unico.item.to} end={unico.item.to === '/'} className="dock__item" title={condensado ? unico.item.label : undefined}>
          {glifo}<span className={condensado ? 'sr-only' : undefined}>{unico.item.label}</span>
        </NavLink>
      );
    }
    const abierto = openSection === g.id;
    const ancho = g.secciones.length > 1;
    return (
      <div key={g.id} className="dock__grupo">
        <button type="button" className="dock__item" id={triggerId(g.id)} aria-expanded={abierto} aria-controls={panelId(g.id)}
          aria-current={esActivo ? 'page' : undefined} title={condensado ? g.titulo : undefined} onClick={() => toggle(g.id)}>
          {glifo}{nombre}
          {!condensado && <Icono nombre="arriba" className="dock__flecha" size={16} />}
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
    <nav ref={navRef} aria-label="Navegación principal" data-vt="floating-nav" data-condensado={condensado || undefined}
      className={`dock flit-nav-capsule${condensado ? ' kit-dock--iconos' : ''}`}
      style={reservaDrFlit ? { maxWidth: 'min(calc(100vw - 16px), max(calc(100vw - 160px), 360px))' } : undefined}>
      {izq.map(pintarGrupo)}
      <NavLink to="/" end className="dock__fab" aria-label="Inicio">
        <img src="/kit/isotipo.svg" alt="" aria-hidden="true" />
      </NavLink>
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
