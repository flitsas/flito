import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { startViewTransition } from '../../lib/viewTransitions';
import { useNavSections } from '../shell/useNavSections';
import { Icono } from './kit/Icono';

/**
 * Barra superior del UI Kit 2026 (`header.barra` de index.html de la propuesta-2; SuiteShell de flit develop):
 * marca por tema + «FLITO» · buscador «Buscar placa, trámite o módulo» (Ctrl K) · interruptor de tema del kit ·
 * usuario (nombre, avatar con aro turquesa, puntos y menú: perfil, ayuda, contraseña y salir).
 * Solo presentación: la sesión, el perfil y la salida son los de siempre. Administración vive en el dock, como
 * sección del menú (SECTION_ORDER), no aquí.
 */
interface FlitTopbarProps {
  onOpenPalette: () => void;
  /** Ya no hay cajón lateral (el dock cubre el teléfono); se acepta por compatibilidad. */
  onOpenSidebar?: () => void;
}

type MenuId = 'usuario' | null;

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

        <button type="button" className="tema-kit" aria-pressed={oscuro} aria-label="Tema oscuro" data-tip="Preferencias de visualización"
          onClick={() => setTheme(oscuro ? 'light' : 'dark')} />

        <MenuAncla abierto={menu === 'usuario'}
          boton={
            <button type="button" className="usuario" data-menu="usuario" aria-expanded={menu === 'usuario'} aria-controls={menu === 'usuario' ? 'flit-usuario-menu' : undefined}
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
              {/* Cuenta. */}
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
            {/* Salir en naranja (ui-kit-2026.css pinta así el .btn del pie). */}
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
