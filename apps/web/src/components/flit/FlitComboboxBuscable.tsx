// Combobox con búsqueda en el servidor (BUG 14569, punto 8 — spec `docs/ux/flito-revisiones-buscador-tramite.md`).
//
// Presentacional: no consulta la API. La página le pasa el texto, el estado de la búsqueda y las
// opciones ya resueltas. Estructura visual de `FlitOrganismoCombobox` (trigger + panel con input y
// lista) y teclado de `ComboboxTramite` (↓/↑ con tope, Enter elige, Esc cierra y PARA la
// propagación), con el ARIA corregido: el input del panel es el `role="combobox"` con
// `aria-activedescendant`, y la opción es el propio `<li role="option">` (sin `<button>` dentro).
// Resaltado con el token `--kit-hover` (tiene par oscuro). 44 px de alto bajo `lg`.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import StatusChip, { type ChipTone } from './StatusChip';

export interface OpcionBuscable {
  id: string;
  /** Primera parte de la línea 1, en mono y semibold (p. ej. el N.º FLIT). */
  principal: string;
  /** Segunda parte de la línea 1, tabular (p. ej. la placa). */
  secundario?: string | null;
  /** Línea 2, en gris y truncada. */
  detalle?: string | null;
  chip?: { texto: string; tone: ChipTone } | null;
  deshabilitada?: boolean;
}

export type EstadoBuscable = 'pista' | 'cargando' | 'error' | 'lista';

export interface FlitComboboxBuscableProps {
  /** Id del trigger: el `<label htmlFor>` de `FlitField` (`inputId`) apunta aquí. */
  id: string;
  /** Texto del trigger con la selección; null = placeholder. */
  etiquetaSeleccion: string | null;
  placeholder: string;
  seleccionadoId: string | null;
  onElegir: (id: string) => void;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
  texto: string;
  onTextoChange: (texto: string) => void;
  estado: EstadoBuscable;
  opciones: readonly OpcionBuscable[];
  truncado: boolean;
  onReintentar: () => void;
  /** Encabezado del panel sobre la lista (p. ej. «Filtrado por la placa …»). */
  encabezado?: string | null;
  disabled?: boolean;
  required?: boolean;
  describedBy?: string;
  placeholderBusqueda: string;
  ariaLabelBusqueda: string;
  ariaLabelLista: string;
  maxLength?: number;
  copy: {
    pista: string;
    cargando: string;
    error: string;
    sinResultados: ReactNode;
    /** Texto de la región viva cuando hay opciones. */
    anuncio: (n: number, truncado: boolean) => string;
    truncado: string;
  };
}

const TACTIL = 'min-h-[44px] lg:min-h-10';

export default function FlitComboboxBuscable({
  id, etiquetaSeleccion, placeholder, seleccionadoId, onElegir, abierto, onAbiertoChange,
  texto, onTextoChange, estado, opciones, truncado, onReintentar, encabezado, disabled, required,
  describedBy, placeholderBusqueda, ariaLabelBusqueda, ariaLabelLista, maxLength, copy,
}: FlitComboboxBuscableProps) {
  const base = useId();
  const listboxId = `${base}-listbox`;
  const idOpcion = (i: number) => `${base}-opt-${i}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [activo, setActivoState] = useState(-1);

  const conLista = estado === 'lista' && opciones.length > 0;
  const habilitadas = opciones.map((o, i) => (o.deshabilitada ? -1 : i)).filter((i) => i >= 0);

  // Al abrir (o al llegar la lista): resalta la elegida o la primera elegible; el foco va al input.
  useEffect(() => {
    if (!abierto) return;
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [abierto]);
  useEffect(() => {
    if (!abierto) return;
    const elegida = opciones.findIndex((o) => o.id === seleccionadoId && !o.deshabilitada);
    setActivoState(elegida >= 0 ? elegida : (habilitadas[0] ?? -1));
    // Solo al abrir o cuando cambia la lista: no al mover el resaltado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, opciones]);

  useEffect(() => {
    if (!abierto) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onAbiertoChange(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [abierto, onAbiertoChange]);

  useEffect(() => {
    if (abierto && activo >= 0) document.getElementById(idOpcion(activo))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, activo]);

  const cerrar = (devolverFoco: boolean) => {
    onAbiertoChange(false);
    if (devolverFoco) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const elegir = (i: number) => {
    const o = opciones[i];
    if (!o || o.deshabilitada) return;
    onElegir(o.id);
    cerrar(true);
  };
  const mover = (delta: 1 | -1) => {
    const pos = habilitadas.indexOf(activo);
    if (pos < 0) { setActivoState(habilitadas[0] ?? -1); return; }
    const sig = habilitadas[Math.min(Math.max(pos + delta, 0), habilitadas.length - 1)];
    setActivoState(sig ?? -1);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAbiertoChange(true); }
  };
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(true); return; }
    if (e.key === 'Tab') { onAbiertoChange(false); return; }
    if (!conLista) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); elegir(activo); }
  };

  const anuncio = estado === 'cargando' ? copy.cargando
    : estado === 'lista' ? (opciones.length ? copy.anuncio(opciones.length, truncado) : '')
    : '';

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls={abierto ? listboxId : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
        onClick={() => onAbiertoChange(!abierto)}
        onKeyDown={onTriggerKey}
        className={`flit-focus flex w-full items-center justify-between gap-2 rounded-[9px] border border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] px-3 py-2 text-left text-sm text-[color:var(--color-text-primary)] outline-none transition-colors hover:border-[color:var(--kit-azul)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-[color:var(--color-border-control)] ${TACTIL}`}
      >
        <span className={`w-0 min-w-0 flex-1 truncate ${etiquetaSeleccion ? '' : 'text-[color:var(--color-text-tertiary)]'}`}>
          {etiquetaSeleccion ?? placeholder}
        </span>
        {!disabled && (
          <svg className={`h-4 w-4 shrink-0 text-[color:var(--color-text-tertiary)] ${abierto ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {abierto && !disabled && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-[9px] border bg-[var(--color-surface-elevated)]"
          style={{ borderColor: 'var(--color-border-control)', boxShadow: 'var(--kit-sombra)' }}>
          <div className="space-y-1.5 border-b p-2" style={{ borderColor: 'var(--color-border)' }}>
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              value={texto}
              maxLength={maxLength}
              onChange={(e) => onTextoChange(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={placeholderBusqueda}
              autoComplete="off"
              aria-label={ariaLabelBusqueda}
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={conLista && activo >= 0 ? idOpcion(activo) : undefined}
              className={`flit-focus w-full rounded-[9px] border border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--kit-gris)] outline-none transition-colors hover:border-[color:var(--kit-azul)] ${TACTIL}`}
            />
            {encabezado && conLista && <p className="px-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{encabezado}</p>}
          </div>

          <p role="status" aria-live="polite" className="sr-only">{anuncio}</p>

          {estado === 'pista' && <p className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{copy.pista}</p>}
          {estado === 'cargando' && (
            <div aria-hidden className="space-y-3 px-3 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3 w-2/5 rounded" style={{ background: 'var(--kit-hover)' }} />
                  <div className="h-2.5 w-3/5 rounded" style={{ background: 'var(--kit-hover)' }} />
                </div>
              ))}
            </div>
          )}
          {estado === 'error' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <p role="alert" style={{ color: 'var(--kit-rojo-texto)' }}>{copy.error}</p>
              <button type="button" onClick={onReintentar}
                className={`flit-focus rounded-[9px] px-2 text-sm font-medium underline-offset-2 transition-colors hover:bg-[color:var(--kit-hover)] hover:underline ${TACTIL}`}
                style={{ color: 'var(--color-action)' }}>
                Reintentar
              </button>
            </div>
          )}
          {estado === 'lista' && opciones.length === 0 && (
            <div role="status" className="space-y-1 px-3 py-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{copy.sinResultados}</div>
          )}

          <ul id={listboxId} role="listbox" aria-label={ariaLabelLista}
            className={`max-h-[60vh] overflow-auto lg:max-h-52 ${conLista ? 'py-1' : 'hidden'}`}>
            {conLista && opciones.map((o, i) => {
              const elegida = o.id === seleccionadoId;
              return (
                <li key={o.id} id={idOpcion(i)} role="option" aria-selected={elegida}
                  aria-disabled={o.deshabilitada || undefined}
                  onMouseEnter={() => { if (!o.deshabilitada) setActivoState(i); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => elegir(i)}
                  className={`flex flex-col justify-center gap-0.5 border-b px-3 py-2 text-sm transition-colors last:border-0 ${o.deshabilitada ? 'cursor-not-allowed' : 'cursor-pointer'} min-h-[44px] lg:min-h-0`}
                  style={{
                    borderColor: 'var(--color-border)',
                    color: o.deshabilitada ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                    background: i === activo ? 'var(--kit-hover)' : undefined,
                  }}>
                  <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="whitespace-nowrap">
                      {elegida && <span aria-hidden className="mr-1">✓</span>}
                      <span className="font-mono font-semibold">{o.principal}</span>
                      {o.secundario && <span className="tabular-nums"> · {o.secundario}</span>}
                    </span>
                    {o.chip && <StatusChip tone={o.chip.tone}>{o.chip.texto}</StatusChip>}
                  </span>
                  {o.detalle && <span className="truncate text-xs" style={{ color: 'var(--color-text-secondary)' }}>{o.detalle}</span>}
                </li>
              );
            })}
          </ul>

          {estado === 'lista' && truncado && opciones.length > 0 && (
            <p className="border-t px-3 py-2 text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>{copy.truncado}</p>
          )}
        </div>
      )}
    </div>
  );
}
