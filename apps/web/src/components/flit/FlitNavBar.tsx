import { useEffect, useRef, useState } from 'react';
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

/** Scroll bajo el cual el dock está siempre expandido. */
const EXPAND_ZONE = 96;

export default function FlitNavBar() {
  const { grouped, routeSection } = useNavSections();
  const { openSection, toggle, navRef, triggerId, panelId } = useDisclosureNav('flit-navbar');
  const [condensed, setCondensed] = useState(false);
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
            setCondensed(next);
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
  useEffect(() => {
    if (!openSection) return;
    condensedRef.current = false;
    setCondensed(false);
  }, [openSection]);

  if (grouped.length === 0) return null;

  const pillH = condensed ? 'h-9' : 'h-11';

  return (
    // El contenedor cubre todo el ancho para poder centrar, pero deja pasar los
    // clics: solo el dock y sus paneles son interactivos.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 hidden justify-center px-4 pb-5 lg:flex">
      <nav
        ref={navRef}
        aria-label="Navegación principal"
        data-vt="floating-nav"
        // gap y padding ajustados para que los 10 módulos de un admin quepan en
        // UNA fila a 1440px: el dock pierde su gracia partido en dos.
        className="flit-nav-capsule flit-shell-nav pointer-events-auto relative inline-flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-flit-pill p-1.5 transition-[height,padding] duration-200 ease-out motion-reduce:transition-none"
      >
        {grouped.map(({ section, items }) => {
          const SectionIcon = SECTION_ICON[section];
          const isRouteSection = routeSection === section;
          const isOpen = openSection === section;
          const lit = isRouteSection || isOpen;

          const shared = `flit-focus group relative flex ${pillH} items-center gap-2 whitespace-nowrap rounded-flit-pill px-3 text-sm transition-all duration-200 ease-out motion-reduce:transition-none`;
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
