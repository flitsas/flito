import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'aura-theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

/**
 * Escribe en <html> el tema YA RESUELTO. Nunca quita el atributo.
 *
 * Hasta la HU #11899 el modo `system` hacía `removeAttribute('data-theme')` y confiaba en que
 * `prefers-color-scheme` resolviera por CSS. Para Aura funcionaba —`tokens.css` tiene un gemelo
 * `@media` de su bloque oscuro—, pero NADA de lo que se selecciona por `[data-theme='dark']`
 * llegaba a dispararse: el dock, la ⌘K y, desde esta HU, todas las superficies del kit FLIT. Como
 * `system` es además el valor por defecto de quien nunca tocó el toggle, el resultado era el
 * síntoma que se reportaba como «en algunos dispositivos el tema no cambia»: SO en oscuro,
 * preferencia sin tocar, atributo ausente, kit en claro (AC2 de la #11899).
 *
 * Quitar el atributo tampoco era gratis al revés: sin él no hay forma de distinguir «claro
 * elegido» de «sin preferencia», que es lo que el gate de contraste y los e2e necesitan leer.
 *
 * El mismo cálculo vive en el bootstrap inline de `apps/web/index.html`, que corre antes del
 * primer paint. Están duplicados a propósito (uno no puede importar al otro sin bloquear el
 * render), así que tienen que decir lo mismo: si se toca uno, se toca el otro.
 */
function applyDocumentTheme(mode: ThemeMode, systemPref: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode === 'system' ? systemPref : mode);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());
  const [systemPref, setSystemPref] = useState<ResolvedTheme>(() => readSystemPreference());

  // Sync DOM whenever theme changes.
  //
  // `systemPref` está en las dependencias desde la #11899 y no es cosmético: en modo `system` el
  // atributo lleva el valor RESUELTO, así que un cambio de esquema del SO con la app abierta tiene
  // que reescribirlo. Con `[theme]` a secas, el listener de `matchMedia` de abajo actualizaba el
  // estado de React (y con él `resolvedTheme`) mientras el DOM se quedaba con el tema anterior:
  // los componentes que leen el hook y el CSS que lee el atributo discreparían.
  useEffect(() => {
    applyDocumentTheme(theme, systemPref);
  }, [theme, systemPref]);

  // Listen for OS-level theme changes (only matters when theme === 'system').
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent) => setSystemPref(event.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, mode);
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light';
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemPref : theme;

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, cycleTheme }),
    [theme, resolvedTheme, setTheme, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de <ThemeProvider>.');
  return ctx;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme } = useTheme();
  const nextLabel =
    theme === 'light' ? 'Cambiar a tema oscuro' : theme === 'dark' ? 'Cambiar a tema del sistema' : 'Cambiar a tema claro';
  const currentLabel = theme === 'light' ? 'Tema claro' : theme === 'dark' ? 'Tema oscuro' : 'Tema del sistema';

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={nextLabel}
      title={currentLabel}
      className={
        className ??
        'inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent,currentColor)]'
      }
    >
      {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <MonitorIcon />}
    </button>
  );
}
