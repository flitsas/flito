import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS, SECTION_LABEL, type NavItem } from './navItems';
import { effectivePages } from '../../lib/permissions';
import { useAuth } from '../../lib/auth';
import { startViewTransition } from '../../lib/viewTransitions';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Command Palette Aura 2026 — inspirado en Raycast/Linear/Vercel/Arc.
// Cmd+K abre · Esc cierra · ↑↓ navega · Enter ejecuta.
// Usa exclusivamente design tokens Aura (sin colores neutros hardcoded).
export default function CommandPalette({ open, onClose }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (idx: number): string => `${listboxId}-opt-${idx}`;

  const allowed = useMemo(() => effectivePages(user), [user]);
  const items = useMemo(() => NAV_ITEMS.filter((it) => allowed.has(it.page)), [allowed]);

  const filtered = useMemo<NavItem[]>(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        SECTION_LABEL[it.section].toLowerCase().includes(q) ||
        (it.keywords ?? '').toLowerCase().includes(q),
    );
  }, [items, query]);

  // Agrupar por sección preservando orden de aparición.
  const grouped = useMemo<Array<[NavItem['section'], NavItem[]]>>(() => {
    const map = new Map<NavItem['section'], NavItem[]>();
    filtered.forEach((it) => {
      const arr = map.get(it.section) ?? [];
      arr.push(it);
      map.set(it.section, arr);
    });
    return Array.from(map.entries());
  }, [filtered]);

  // Reset al abrir.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus en next tick para que el portal pinte primero.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Reset índice activo al cambiar el filtro.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keyboard nav global cuando la paleta está abierta.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(filtered.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[active];
        if (target) {
          onClose();
          startViewTransition(() => navigate(target.to));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, active, filtered, navigate, onClose]);

  // Auto-scroll del item activo.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // El input no debe consumir flechas — las maneja el listener global.
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Enter' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      e.preventDefault();
    }
  };

  if (!open) return null;

  let runningIdx = 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] sm:pt-[14vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Paleta de comandos"
    >
      {/* Overlay con surface-overlay token + blur */}
      <div
        className="absolute inset-0 flit-shell-overlay backdrop-blur-md animate-in fade-in"
        aria-hidden="true"
      />

      {/* Panel glassmórfico Aura */}
      <div
        className="flit-shell-palette relative w-full max-w-2xl overflow-hidden border flit-shell-sunken shadow-[var(--flit-shadow-card)]"
        style={{ borderRadius: 'var(--radius-xl)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Halo teal sutil arriba — pista de marca */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, var(--color-accent-soft), transparent)',
          }}
          aria-hidden="true"
        />

        {/* Input row */}
        <div className="flex h-14 items-center gap-3 border-b flit-shell-sunken px-5">
          <svg
            className="h-5 w-5 flit-shell-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Buscar o ir a…"
            className="flex-1 bg-transparent text-base flit-shell-primary placeholder:flit-shell-muted outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={filtered.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd
            className="hidden items-center rounded-md border flit-shell-sunken border flit-shell-sunken px-2 py-0.5 font-mono text-[10px] flit-shell-muted sm:inline-flex"
            aria-label="Tecla escape para cerrar"
          >
            esc
          </kbd>
        </div>

        {/* Listbox */}
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Resultados"
          className="overflow-y-auto py-2"
          style={{ maxHeight: 'min(60vh, 28rem)' }}
        >
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-5 py-14 text-center">
              <svg
                className="h-9 w-9 flit-shell-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.879 16.121A3 3 0 1014.12 11.88M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm flit-shell-secondary">
                Sin resultados para{' '}
                <span className="font-medium flit-shell-primary">"{query}"</span>
              </p>
              <p className="text-xs flit-shell-muted">
                Pulsa <kbd className="rounded border flit-shell-sunken border flit-shell-sunken px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>{' '}
                o haz click fuera para cerrar
              </p>
            </div>
          ) : (
            grouped.map(([section, list]) => (
              <div key={section} className="mb-1" role="group" aria-label={SECTION_LABEL[section]}>
                <p
                  className="px-5 pt-3 pb-1.5 font-semibold uppercase flit-shell-muted"
                  style={{ fontSize: '10px', letterSpacing: 'var(--tracking-wide)' }}
                >
                  {SECTION_LABEL[section]}
                </p>
                {list.map((it) => {
                  const idx = runningIdx++;
                  const isActive = idx === active;
                  return (
                    <button
                      key={it.to}
                      data-idx={idx}
                      id={optionId(idx)}
                      role="option"
                      aria-selected={isActive}
                      type="button"
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => {
                        onClose();
                        startViewTransition(() => navigate(it.to));
                      }}
                      className={[
                        'group relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-3 py-2.5 text-left',
                        'transition-all',
                        isActive
                          ? 'flit-shell-active flit-shell-primary translate-x-0.5'
                          : 'flit-shell-secondary flit-shell-hover hover:flit-shell-primary',
                      ].join(' ')}
                      style={{ transitionDuration: 'var(--duration-base)', transitionTimingFunction: 'var(--ease-out)' }}
                    >
                      {/* Indicador lateral teal cuando está activo */}
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full flit-shell-accent transition-opacity"
                        style={{
                          opacity: isActive ? 1 : 0,
                          transitionDuration: 'var(--duration-fast)',
                        }}
                      />
                      <span className="flex-1 text-sm font-medium">{it.label}</span>
                      {isActive && (
                        <kbd className="rounded border flit-shell-sunken border bg-white px-1.5 py-0.5 font-mono text-[10px] flit-shell-accent">
                          ↵
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex h-10 items-center justify-between border-t flit-shell-sunken flit-shell-sunken/40 px-5 text-[11px] flit-shell-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border flit-shell-sunken border bg-white px-1.5 py-0.5 font-mono">
                ↑↓
              </kbd>
              navegar
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border flit-shell-sunken border bg-white px-1.5 py-0.5 font-mono">
                ↵
              </kbd>
              abrir
            </span>
          </div>
          <span aria-live="polite" aria-atomic="true">
            {filtered.length} {filtered.length === 1 ? 'resultado' : 'resultados'}
          </span>
        </div>
      </div>
    </div>
  );
}
