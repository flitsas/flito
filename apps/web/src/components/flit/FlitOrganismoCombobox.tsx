import { useState, useRef, useEffect, useMemo, useId, type KeyboardEvent } from 'react';
import { ORGANISMOS_TRANSITO, getOrganismoByCodigo } from '@operaciones/shared-types';

function normalizeSearch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export interface FlitOrganismoComboboxProps {
  value: string;
  onChange: (codigo: string) => void;
  /** Muestra opción «Todos» con value ''. Solo para admin en bandeja. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  placeholder?: string;
}

export default function FlitOrganismoCombobox({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = 'Todos los organismos',
  required,
  disabled,
  id: idProp,
  'aria-label': ariaLabel = 'Organismo de tránsito',
  placeholder = 'Buscar municipio o secretaría…',
}: FlitOrganismoComboboxProps) {
  const autoId = useId();
  const listboxId = `${idProp ?? autoId}-listbox`;
  const inputId = `${idProp ?? autoId}-search`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = value ? getOrganismoByCodigo(value) : undefined;

  const filtered = useMemo(() => {
    const q = normalizeSearch(query.trim());
    if (q.length < 2) return ORGANISMOS_TRANSITO;
    return ORGANISMOS_TRANSITO.filter(
      (o) =>
        normalizeSearch(`${o.nombre} ${o.ciudad} ${o.codigo}`).includes(q),
    );
  }, [query]);

  const options = useMemo(() => {
    const items: { codigo: string; label: string; sub?: string }[] = [];
    if (allowEmpty) items.push({ codigo: '', label: emptyLabel });
    for (const o of filtered) {
      items.push({ codigo: o.codigo, label: o.ciudad, sub: o.nombre });
    }
    return items;
  }, [allowEmpty, emptyLabel, filtered]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const pick = (codigo: string) => {
    onChange(codigo);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Enter' && options[highlight]) {
      e.preventDefault();
      pick(options[highlight].codigo);
    }
  };

  const triggerLabel = selected
    ? `${selected.ciudad} — ${selected.nombre}`
    : allowEmpty && !value
      ? emptyLabel
      : 'Seleccione municipio…';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={idProp ?? autoId}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="flit-focus flex w-full items-center justify-between gap-2 rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-left text-sm text-[color:var(--flit-text-primary)] outline-none transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`min-w-0 truncate ${!selected && !allowEmpty ? 'text-[color:var(--flit-text-muted)]' : ''}`}>
          {triggerLabel}
        </span>
        {selected && (
          <span className="shrink-0 font-mono text-[10px] text-[color:var(--flit-text-muted)]">{selected.codigo}</span>
        )}
        <svg
          className={`h-4 w-4 shrink-0 text-[color:var(--flit-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Campo oculto para validación HTML5 en formularios */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          required
          value={value}
          onChange={() => {}}
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />
      )}

      {open && (
        <div
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border bg-white shadow-lg"
          style={{ borderColor: 'var(--flit-border-input)', boxShadow: 'var(--flit-shadow-card)' }}
        >
          <div className="border-b p-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <input
              ref={searchRef}
              id={inputId}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              autoComplete="off"
              className="flit-focus w-full rounded-lg border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none"
            />
          </div>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-52 overflow-auto py-1"
          >
            {options.length === 0 ? (
              <li className="px-4 py-3 text-center text-xs text-[color:var(--flit-text-muted)]">
                Sin resultados
              </li>
            ) : (
              options.map((opt, i) => {
                const isSelected = opt.codigo === value;
                const isHighlighted = i === highlight;
                return (
                  <li key={opt.codigo || '__all__'} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => pick(opt.codigo)}
                      className="flit-focus w-full border-b border-[color:var(--flit-border-soft)] px-4 py-2.5 text-left text-sm transition-colors last:border-0"
                      style={
                        isSelected || isHighlighted
                          ? { background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }
                          : undefined
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate ${opt.codigo && isSelected ? 'font-semibold' : ''}`}>{opt.label}</span>
                        {opt.codigo && (
                          <span className="shrink-0 font-mono text-[10px] text-[color:var(--flit-text-muted)]">
                            {opt.codigo}
                          </span>
                        )}
                      </div>
                      {opt.sub && (
                        <span className="block truncate text-[10px] text-[color:var(--flit-text-muted)]">{opt.sub}</span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
