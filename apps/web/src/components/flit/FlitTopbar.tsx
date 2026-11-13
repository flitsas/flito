import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { startViewTransition } from '../../lib/viewTransitions';
import { useNavSections } from '../shell/useNavSections';
import { entradasAdministracion } from '../shell/dockGrupos';
import { IconoGlifo } from './kit/IconoGlifo';
import { Icono, type NombreIcono } from './kit/Icono';

/**
 * Barra superior del UI Kit 2026 (`header.barra` de index.html de la propuesta-2; SuiteShell de flit develop):
 * marca por tema + «FLITO» · buscador «Buscar placa, trámite o módulo» (Ctrl K) · rejilla de productos ·
 * notificaciones · interruptor de tema del kit · usuario (nombre, avatar con aro turquesa, puntos y menú).
 * Solo presentación: la sesión, el perfil y la salida son los de siempre.
 */
interface FlitTopbarProps {
  onOpenPalette: () => void;
  /** Ya no hay cajón lateral (el dock cubre el teléfono); se acepta por compatibilidad. */
  onOpenSidebar?: () => void;
}

/** URL de la suite FLIT para la rejilla de productos (configurable por ambiente). */
const URL_SUITE = (import.meta.env.VITE_URL_SUITE_FLIT as string | undefined) ?? 'https://app.flitsas.com';

const PRODUCTOS: Array<{ id: string; nombre: string; detalle: string; icono: NombreIcono; href?: string }> = [
  { id: 'tramites', nombre: 'FLIT Trámites', detalle: 'Traspasos y matrículas', icono: 'tramites', href: URL_SUITE },
  { id: 'comparendos', nombre: 'FLIT Comparendos', detalle: 'Multas de tu flota', icono: 'comparendos', href: URL_SUITE },
  { id: 'diagnostico', nombre: 'FLIT Diagnóstico', detalle: 'Estado de cada vehículo', icono: 'consulta', href: URL_SUITE },
  { id: 'flito', nombre: 'FLITO', detalle: 'Operación y logística', icono: 'ruta' },
];

type MenuId = 'productos' | 'avisos' | 'usuario' | null;

function iniciales(nombre: string | undefined): string {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '·';
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

export default function FlitTopbar({ onOpenPalette }: FlitTopbarProps) {
  const { user, logout, hasFuncion } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const { visibleItems } = useNavSections();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<MenuId>(null);
  const barraRef = useRef<HTMLElement>(null);

  const isMac = useMemo(() => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''), []);

  // Un menú a la vez; se cierra al pulsar fuera o con Escape (y devuelve el foco a su botón).
  useEffect(() => {
    if (!menu) return undefined;
    const fuera = (e: MouseEvent) => { if (!barraRef.current?.contains(e.target as Node)) setMenu(null); };
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const boton = barraRef.current?.querySelector<HTMLButtonElement>(`[data-menu="${menu}"]`);
      setMenu(null);
      boton?.focus();
    };
    window.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', tecla);
    return () => { window.removeEventListener('mousedown', fuera); window.removeEventListener('keydown', tecla); };
  }, [menu]);

  const alternar = (id: Exclude<MenuId, null>) => setMenu((m) => (m === id ? null : id));
  const puedeVerPerfil = hasFuncion('perfil.datos.ver');
  const puedeVerAyuda = visibleItems.some((it) => it.to === '/flito/ayuda');
  const administracion = useMemo(() => entradasAdministracion(visibleItems), [visibleItems]);
  const oscuro = resolvedTheme === 'dark';
  const nombre = user?.name ?? 'Sesión';
  // Rol · empresa: /auth/me no trae la empresa del usuario; se muestra el nombre de negocio del rol.
  const rol = user?.rolNombre ?? user?.role ?? '—';

  const ir = (to: string) => { setMenu(null); startViewTransition(() => navigate(to)); };
  const salir = () => { setMenu(null); startViewTransition(() => navigate('/login')); logout(); };

  return (
    <header ref={barraRef} className="barra flit-app" role="banner" data-kit="barra">
      <Link className="barra__marca" to="/" aria-label="FLITO, ir al inicio">
        <img className="logo logo--claro" src="/kit/logo-claro.svg" alt="FLIT" />
        <img className="logo logo--oscuro" src="/kit/logo-oscuro.svg" alt="FLIT" />
        <span className="barra__producto">FLITO</span>
      </Link>
      <div className="barra__acciones">
        <button type="button" className="buscar" onClick={onOpenPalette} aria-label={`Buscar placa, trámite o módulo (${isMac ? 'Command' : 'Control'} K)`}>
          <Icono nombre="buscar" size={20} />
          <span>Buscar placa, trámite o módulo</span>
          <kbd aria-hidden="true">{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>

        <MenuAncla clase="menu-ancla--productos" abierto={menu === 'productos'}
          boton={
            <button type="button" className="icono-btn" data-menu="productos" aria-expanded={menu === 'productos'} aria-controls="flit-productos-menu"
              aria-label="Productos de FLIT" data-tip="Productos de FLIT" onClick={() => alternar('productos')}>
              <span className="kico" aria-hidden="true"><Icono nombre="rejilla" /></span>
            </button>
          }>
          <div className="menu-flotante menu-flotante--productos" id="flit-productos-menu">
            <ul>
              {PRODUCTOS.map((p) => (
                <li key={p.id}>
                  {p.href ? (
                    <a href={p.href} rel="noopener"><span className="kico" aria-hidden="true"><Icono nombre={p.icono} /></span><span><strong>{p.nombre}</strong><small>{p.detalle}</small></span></a>
                  ) : (
                    <Link to="/" aria-current="page" onClick={() => setMenu(null)}><span className="kico" aria-hidden="true"><Icono nombre={p.icono} /></span><span><strong>{p.nombre}</strong><small>{p.detalle}</small></span></Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </MenuAncla>

        <MenuAncla abierto={menu === 'avisos'}
          boton={
            <button type="button" className="icono-btn" data-menu="avisos" aria-expanded={menu === 'avisos'} aria-controls="flit-avisos-menu"
              aria-label="Notificaciones (próximamente)" data-tip="Notificaciones" onClick={() => alternar('avisos')}>
              <span className="kico" aria-hidden="true"><Icono nombre="campana" /></span>
            </button>
          }>
          <div className="menu-flotante menu-avisos" id="flit-avisos-menu">
            <p className="m-0 px-3 py-2 text-[0.8125rem] text-[color:var(--color-text-tertiary)]">Aún no hay notificaciones. Aquí verás los avisos de tus trámites.</p>
          </div>
        </MenuAncla>

        <button type="button" className="tema-kit" aria-pressed={oscuro} aria-label="Tema oscuro" data-tip="Preferencias de visualización"
          onClick={() => setTheme(oscuro ? 'light' : 'dark')} />

        <MenuAncla abierto={menu === 'usuario'}
          boton={
            <button type="button" className="usuario" data-menu="usuario" aria-expanded={menu === 'usuario'} aria-controls="flit-usuario-menu"
              aria-haspopup="menu" aria-label={`Menú de usuario · ${user?.name ?? 'sesión'}`} onClick={() => alternar('usuario')}>
              <span className="usuario__avatar" aria-hidden="true">{iniciales(user?.name)}</span>
              <span className="usuario__texto"><strong className="max-w-[18ch] truncate">{nombre}</strong><small className="max-w-[22ch] truncate">{rol}</small></span>
              <span className="usuario__puntos" aria-hidden="true"><Icono nombre="puntos" /></span>
            </button>
          }>
          <div className="menu-flotante menu-usuario" id="flit-usuario-menu" role="menu" aria-label="Opciones de usuario">
            <div className="menu-usuario__cabeza">
              <span className="menu-usuario__avatar" aria-hidden="true">{iniciales(user?.name)}</span>
              <div><strong className="truncate">{user?.name ?? 'Sin nombre'}</strong><small>{rol}</small></div>
            </div>
            <ul>
              {/* (2) Productos: solo en teléfono (≤640 px la rejilla de la barra se oculta). */}
              {PRODUCTOS.map((p) => (
                <li key={p.id} className="solo-movil">
                  {p.href ? (
                    <a role="menuitem" className="menu-usuario__entrada" href={p.href} rel="noopener">
                      <span className="kico" aria-hidden="true"><Icono nombre={p.icono} /></span><span><strong>{p.nombre}</strong><small>{p.detalle}</small></span>
                    </a>
                  ) : (
                    <Link role="menuitem" className="menu-usuario__entrada" to="/" aria-current="page" onClick={() => setMenu(null)}>
                      <span className="kico" aria-hidden="true"><Icono nombre={p.icono} /></span><span><strong>{p.nombre}</strong><small>{p.detalle}</small></span>
                    </Link>
                  )}
                </li>
              ))}
              {/* (3) Administración: solo con permiso (mismo árbol que el dock: useNavSections). */}
              {administracion.length > 0 && (
                <li className="menu-usuario__seccion" role="presentation"><p>Administración</p></li>
              )}
              {administracion.map(({ item, icono, descripcion }) => (
                <li key={item.to}><button type="button" role="menuitem" className="menu-usuario__entrada" onClick={() => ir(item.to)}>
                  <span className="kico" aria-hidden="true"><IconoGlifo icono={icono} /></span><span><strong>{item.label}</strong>{descripcion && <small>{descripcion}</small>}</span>
                </button></li>
              ))}
              {/* (4) Cuenta. */}
              {puedeVerPerfil && (
                <li><button type="button" role="menuitem" className="menu-usuario__entrada" onClick={() => ir('/perfil')}>
                  <span className="kico" aria-hidden="true"><Icono nombre="persona" /></span><span><strong>Mi perfil</strong><small>Tus datos y preferencias</small></span>
                </button></li>
              )}
              {puedeVerAyuda && (
                <li><button type="button" role="menuitem" className="menu-usuario__entrada" onClick={() => ir('/flito/ayuda')}>
                  <span className="kico" aria-hidden="true"><Icono nombre="ayuda" /></span><span><strong>Ayuda</strong><small>Manual y preguntas frecuentes</small></span>
                </button></li>
              )}
              {puedeVerPerfil && (
                <li><button type="button" role="menuitem" className="menu-usuario__entrada" onClick={() => ir('/perfil?accion=contrasena')}>
                  <span className="kico" aria-hidden="true"><Icono nombre="ojo" /></span><span><strong>Cambiar contraseña</strong><small>Actualiza tu clave de acceso</small></span>
                </button></li>
              )}
            </ul>
            {/* (5) Salir en naranja (ui-kit-2026.css pinta así el .btn del pie). */}
            <div className="menu-usuario__pie">
              <button type="button" role="menuitem" className="btn sm secondary" data-variante="alerta" onClick={salir}>Salir</button>
            </div>
          </div>
        </MenuAncla>
      </div>
    </header>
  );
}

function MenuAncla({ boton, abierto, children, clase = '' }: { boton: ReactNode; abierto: boolean; children: ReactNode; clase?: string }) {
  return (
    <div className={`menu-ancla ${clase}`}>
      {boton}
      {abierto && children}
    </div>
  );
}
