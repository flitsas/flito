import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS, SECTION_LABEL, SECTION_ORDER, navItemPermitido, type NavItem } from './navItems';
import { effectivePages } from '../../lib/permissions';
import { useAuth } from '../../lib/auth';
import { startViewTransition } from '../../lib/viewTransitions';
import ModalPortal from '../flit/ModalPortal';
import { Icono } from '../flit/kit/Icono';
import { IconoGlifo } from '../flit/kit/IconoGlifo';
import { iconoDeRuta } from './dockGrupos';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Command Palette Aura 2026 — inspirado en Raycast/Linear/Vercel/Arc.
// Cmd+K abre · Esc cierra · ↑↓ navega · Enter ejecuta.
// Usa exclusivamente design tokens Aura (sin colores neutros hardcoded).
//
// Bug #11720 (retrabajo) — de aquí se quitaron cuatro clases que NO pintaban nada y que sí
// desorientaban a quien venía a arreglar el contraste: `bg-white` en los `kbd` (utilidad de
// Tailwind, vive en @layer utilities y `.flit-shell-sunken`, sin capa, se la come),
// `hover:flit-shell-primary` y `placeholder:flit-shell-muted` (no son utilidades de Tailwind,
// así que nunca generaron regla) y un `flit-shell-sunken/40` con modificador de opacidad sobre
// una clase propia. Comprobado sobre el píxel en los dos temas: quitarlas no cambia un color.
// El ítem apuntado se queda en tinta secundaria y el placeholder lo pinta ahora una regla real
// en index.css. Las teclas heredan su fondo de `.flit-shell-sunken` y del bloque oscuro de la
// paleta; si mueves un `kbd` de contenedor, cambia el fondo que compone y hay que remedirlo
// (`scripts/check-contraste-paleta.mjs` y `e2e/tests/command-palette-oscuro.spec.ts`).
export default function CommandPalette({ open, onClose }: Props) {
  const { user, funciones } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (idx: number): string => `${listboxId}-opt-${idx}`;

  const allowed = useMemo(() => effectivePages(user), [user]);
  // En el orden del menú (SECTION_ORDER, sort estable): «Ayuda» va al final, como en la barra y el
  // drawer (HU #13431), aunque su ítem se declare antes en NAV_ITEMS. Enter y el índice activo leen
  // esta misma lista, así que lo pintado y lo ejecutado no se desalinean.
  const items = useMemo(
    () => NAV_ITEMS
      .filter((it) => navItemPermitido(it, user, allowed, funciones))
      .sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)),
    [allowed, user, funciones],
  );

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

  // Agrupar por sección preservando orden de aparición (`items` ya viene en SECTION_ORDER).
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

  // Buscador del UI Kit 2026 (`dialog#buscador` de la propuesta): velo azul con blur, modal blanco con ícono 52
  // centrado y la X; dentro, el control con lupa y los resultados agrupados (ícono 32 + nombre + sección).
  return (
    <ModalPortal>
    <div
      className="kit-velo z-[100] items-start justify-center px-3 pt-[10vh] sm:pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Paleta de comandos"
      data-kit="buscador"
    >
      <div className="kit-modal w-full max-w-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="kit-modal__cabeza">
          <Icono nombre="buscar" disco size={52} />
          <h2 className="kit-modal__titulo">Buscar en la plataforma</h2>
          <button type="button" className="kit-modal__cerrar" aria-label="Cerrar" onClick={onClose}><Icono nombre="cerrar" size={20} /></button>
        </div>
        <div className="kit-modal__cuerpo !pb-3">
          <div className="control-icono">
            <Icono nombre="buscar" size={18} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Buscar o ir a…"
              aria-label="Buscar"
              className="control"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={filtered.length > 0 ? optionId(active) : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Resultados"
          className="resultados overflow-y-auto px-4 pb-2 sm:px-6"
          style={{ maxHeight: 'min(52vh, 28rem)' }}
        >
          {filtered.length === 0 ? (
            <div className="kit-vacio !py-8">
              <Icono nombre="buscar" disco size={72} />
              <p>No encontramos nada con «{query}». Prueba con el nombre de un módulo.</p>
              <small>Pulsa Esc o haz clic fuera para cerrar.</small>
            </div>
          ) : (
            grouped.map(([section, list]) => (
              <div key={section} role="group" aria-label={SECTION_LABEL[section]}>
                <p className="grupo">{SECTION_LABEL[section]}</p>
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
                      className="resultado text-left transition-colors"
                    >
                      <span className="kico !h-8 !w-8" aria-hidden="true"><IconoGlifo icono={iconoDeRuta(it.to)} /></span>
                      <span className="min-w-0"><strong className="truncate">{it.label}</strong><small>{SECTION_LABEL[section]}</small></span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex h-10 items-center justify-between border-t border-[color:var(--color-divider)] px-6 text-xs text-[color:var(--color-text-tertiary)]">
          <span className="hidden items-center gap-3 sm:flex">
            <span><kbd className="flit-shell-kbd rounded px-1.5 py-0.5">↑↓</kbd> navegar</span>
            <span><kbd className="flit-shell-kbd rounded px-1.5 py-0.5">↵</kbd> abrir</span>
          </span>
          <span aria-live="polite" aria-atomic="true">
            {filtered.length} {filtered.length === 1 ? 'resultado' : 'resultados'}
          </span>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
