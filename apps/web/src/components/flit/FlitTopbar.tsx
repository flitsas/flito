import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useTheme, type ThemeMode } from '../../lib/theme';
import { startViewTransition } from '../../lib/viewTransitions';
import { FLIT_PRODUCT_NAME } from '../../lib/flitBrand';
import { IconBell, IconSearch, IconMenu, IconLogout, IconChevronDown, IconShield } from './icons';

// FlitTopbar — topbar FLIT: marca a la izquierda (antes vivía en el sidebar,
// eliminado por decisión PO 2026-06-12), trigger ⌘K al centro y a la derecha
// toggle (tema), campana y dropdown de sesión. En mobile, hamburguesa que abre
// el drawer de navegación (FlitSidebar).
interface FlitTopbarProps {
  onOpenPalette: () => void;
  onOpenSidebar: () => void;
}

export default function FlitTopbar({ onOpenPalette, onOpenSidebar }: FlitTopbarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const initial = user?.name?.charAt(0).toUpperCase() ?? '·';

  const handleLogout = (): void => {
    setMenuOpen(false);
    startViewTransition(() => navigate('/login'));
    logout();
  };

  return (
    <header
      className="flit-app sticky top-0 z-30 flex items-center gap-3 border-b px-4 sm:px-6"
      role="banner"
      style={{
        height: 'var(--flit-topbar-height)',
        background: 'rgba(234, 242, 255, 0.85)',
        backdropFilter: 'blur(8px)',
        borderColor: 'var(--flit-border-soft)',
      }}
    >
      {/* Hamburguesa — abre sidebar drawer (solo mobile) */}
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Abrir menú de navegación"
        className="flit-focus grid h-10 w-10 place-items-center rounded-xl lg:hidden"
        style={{ color: 'var(--flit-text-secondary)' }}
      >
        <IconMenu className="h-5 w-5" />
      </button>

      {/* Marca FLIT (antes en el sidebar) */}
      <div className="flex items-center gap-2.5 pr-1 sm:pr-3">
        <span
          className="grid h-9 w-9 place-items-center rounded-xl text-white"
          style={{ background: 'var(--flit-gradient-primary)' }}
          aria-hidden="true"
        >
          <IconShield className="h-[18px] w-[18px]" />
        </span>
        <span
          className="hidden whitespace-nowrap text-sm font-semibold tracking-tight md:block"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          {FLIT_PRODUCT_NAME}
        </span>
      </div>

      {/* Trigger ⌘K — botón con look de input */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={`Buscar o ir a sección (${isMac ? 'Command' : 'Control'} K)`}
        className="flit-focus group flex h-10 max-w-xl flex-1 items-center gap-3 bg-white px-3 text-left text-sm transition-colors sm:px-4"
        style={{
          borderRadius: 'var(--flit-radius-input)',
          border: '1px solid var(--flit-border-input)',
          color: 'var(--flit-text-muted)',
        }}
      >
        <IconSearch className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Buscar o ir a sección…</span>
        <kbd
          aria-hidden="true"
          className="hidden items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex"
          style={{ border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-muted)' }}
        >
          <span>{isMac ? '⌘' : 'Ctrl'}</span><span>K</span>
        </kbd>
      </button>

      <div className="hidden flex-1 lg:block" aria-hidden="true" />

      {/* Grupo derecho: toggle tema, campana, usuario */}
      <div className="flex items-center gap-1 sm:gap-2">
        <ThemeCycleButton />

        <button
          type="button"
          aria-label="Notificaciones (próximamente)"
          className="flit-focus grid h-10 w-10 place-items-center rounded-xl transition-colors hover:bg-white"
          style={{ color: 'var(--flit-text-secondary)' }}
        >
          <IconBell className="h-[18px] w-[18px]" />
        </button>

        {/* Usuario: avatar + rol + menú ⋮ */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`Menú de usuario · ${user?.name ?? 'sesión'}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flit-focus flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 transition-colors hover:bg-white"
          >
            <span
              className="grid h-9 w-9 place-items-center rounded-lg text-[11px] font-semibold text-white"
              style={{ background: 'var(--flit-gradient-primary)' }}
              aria-hidden="true"
            >
              {initial}
            </span>
            <span className="hidden text-left sm:block">
              <span className="block max-w-[14ch] truncate text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                {user?.name ?? 'Sesión'}
              </span>
              <span className="block text-[11px] capitalize" style={{ color: 'var(--flit-text-muted)' }}>
                {user?.role ?? '—'}
              </span>
            </span>
            <IconChevronDown className="hidden h-4 w-4 sm:block" style={{ color: 'var(--flit-text-muted)' }} />
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="Opciones de usuario"
              className="absolute right-0 top-full mt-2 w-64 overflow-hidden bg-white"
              style={{
                borderRadius: 'var(--flit-radius-md)',
                border: '1px solid var(--flit-border-soft)',
                boxShadow: 'var(--flit-shadow-card)',
              }}
            >
              <div className="border-b px-4 pt-3 pb-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--flit-text-muted)' }}>Sesión</p>
                <p className="mt-1 truncate text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{user?.name ?? 'Sin nombre'}</p>
                <p className="text-[11px] capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{user?.role ?? '—'}</p>
              </div>
              <div className="p-1.5">
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[rgba(228,61,48,0.08)]"
                  style={{ color: 'var(--flit-text-secondary)' }}
                >
                  <IconLogout className="h-4 w-4" />
                  Cerrar sesión
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

/* Theme toggle — conserva la lógica existente (useTheme.cycleTheme). */
function ThemeCycleButton() {
  const { theme, cycleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const labels: Record<ThemeMode, { aria: string; title: string }> = {
    light: { aria: 'Cambiar a tema oscuro', title: 'Tema claro' },
    dark: { aria: 'Cambiar a tema del sistema', title: 'Tema oscuro' },
    system: { aria: 'Cambiar a tema claro', title: 'Tema del sistema' },
  };
  const current = mounted ? theme : 'light';
  const { aria, title } = labels[current];

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={aria}
      title={title}
      className="flit-focus relative grid h-10 w-10 place-items-center overflow-hidden rounded-xl transition-colors hover:bg-white"
      style={{ color: 'var(--flit-text-secondary)' }}
    >
      <ThemeIcon mode="light" active={current === 'light'} />
      <ThemeIcon mode="dark" active={current === 'dark'} />
      <ThemeIcon mode="system" active={current === 'system'} />
    </button>
  );
}

function ThemeIcon({ mode, active }: { mode: ThemeMode; active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute inset-0 grid place-items-center transition-all duration-200 ${active ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`}
    >
      {mode === 'light' && <SunIcon />}
      {mode === 'dark' && <MoonIcon />}
      {mode === 'system' && <MonitorIcon />}
    </span>
  );
}

const sw = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const SunIcon = () => (<svg {...sw} className="h-[18px] w-[18px]"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>);
const MoonIcon = () => (<svg {...sw} className="h-[18px] w-[18px]"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>);
const MonitorIcon = () => (<svg {...sw} className="h-[18px] w-[18px]"><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>);
