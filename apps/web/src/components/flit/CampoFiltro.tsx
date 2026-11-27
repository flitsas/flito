// Celda de filtro del kit (Épica #14707, bloque 4 — rediseño de Gestión Trámites, UX §5.4 / R10).
//
// Rótulo encima y un control desplegable de 40 px con chevron (`control-filtro`). Tres tipos:
//   - `multi`  → menú flotante con casillas (`menu-flotante` + `opcion-filtro`), «Todos/Todas» si no hay nada.
//   - `unica`  → el mismo menú con radios (Fuente y Autogestión dejan de ser `FiltroSegmentado`).
//   - `fechas` → `RangoFechas` del kit dentro de un popover (`aria-haspopup="dialog"`).
// Con un valor puesto el control lleva `data-puesto` (borde azul, texto de acción). Escape cierra y
// devuelve el foco al control; un clic fuera también cierra. `ThFiltroMulti` NO se toca: lo usan
// otras 11 pantallas; de él solo se reutiliza el tipo `OpcionFiltro`.
import { useEffect, useId, useRef, useState } from 'react';
import type { OpcionFiltro } from './ThFiltroMulti';
import RangoFechas, { type Rango } from './RangoFechas';

export type { OpcionFiltro };

type CampoMulti = {
  tipo: 'multi'; rotulo: string; opciones: OpcionFiltro[]; seleccion: string[];
  onCambio: (v: string[]) => void; todos: 'Todos' | 'Todas';
  /** Nombre accesible del grupo de casillas («Estados de SOAT»…). */
  nombreGrupo: string;
};
type CampoUnica = {
  tipo: 'unica'; rotulo: string; opciones: OpcionFiltro[]; valor: string; onCambio: (v: string) => void;
  /** Nombre accesible del control a partir del valor visible («Filtrar por fuente: FLIT 2»). */
  ariaLabel?: (valorTexto: string) => string;
};
type CampoFechas = { tipo: 'fechas'; rotulo: string; valor: Rango; onCambio: (r: Rango) => void };
export type CampoFiltroProps = CampoMulti | CampoUnica | CampoFechas;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const partes = (iso: string) => { const [a, m, d] = iso.split('-').map(Number); return { a, m, d }; };

/** «Cualquier fecha» · «1 nov – 15 nov 2026» · «Desde 1 nov 2026» · «Hasta 15 nov 2026». */
export function textoRango(r: Rango, corto = false): string {
  if (!r.desde && !r.hasta) return 'Cualquier fecha';
  const f = (iso: string, conAnio: boolean) => { const p = partes(iso); return `${p.d} ${MESES[p.m - 1]}${conAnio ? ` ${p.a}` : ''}`; };
  if (r.desde && r.hasta) return `${f(r.desde, false)} – ${f(r.hasta, !corto)}`;
  return r.desde ? `Desde ${f(r.desde, !corto)}` : `Hasta ${f(r.hasta, !corto)}`;
}

/** Texto resumido del valor: lo que dice el control y el chip del pie. */
export function textoCampo(p: CampoFiltroProps, corto = false): string {
  if (p.tipo === 'fechas') return textoRango(p.valor, corto);
  if (p.tipo === 'unica') return p.opciones.find((o) => o.value === p.valor)?.label ?? p.opciones[0]?.label ?? '';
  if (p.seleccion.length === 0) return p.todos;
  if (p.seleccion.length === 1) return p.opciones.find((o) => o.value === p.seleccion[0])?.label ?? p.seleccion[0];
  return `${p.seleccion.length} seleccionados`;
}

export const campoPuesto = (p: CampoFiltroProps) =>
  p.tipo === 'fechas' ? !!(p.valor.desde || p.valor.hasta) : p.tipo === 'unica' ? p.valor !== '' : p.seleccion.length > 0;

/** Apertura del menú: Escape devuelve el foco al control; un clic fuera de la celda cierra. */
function useMenu() {
  const [abierto, setAbierto] = useState(false);
  const celda = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (celda.current && !celda.current.contains(e.target as Node)) setAbierto(false); };
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); setAbierto(false); control.current?.focus();
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', tecla); };
  }, [abierto]);
  return { abierto, setAbierto, celda, control };
}

const chevron = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * `RangoFechas` sin cambio de API: es un `<details>` propio, así que el popover lo despliega al montar
 * (un clic en el control basta) y el CSS lo pone en el flujo del popover en vez de flotar otra vez.
 */
function PopoverFechas({ id, rotulo, valor, onCambio }: { id: string; rotulo: string; valor: Rango; onCambio: (r: Rango) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const d = ref.current?.querySelector('details'); if (d && !d.open) d.open = true; }, []);
  return (
    <div ref={ref} id={id} role="dialog" aria-label={`Rango de fechas: ${rotulo}`} className="menu-flotante menu-filtro menu-filtro--fechas">
      <RangoFechas etiqueta={rotulo} valor={valor} onCambio={onCambio} />
    </div>
  );
}

export default function CampoFiltro(p: CampoFiltroProps) {
  const id = useId();
  const idRotulo = `${id}-r`; const idValor = `${id}-v`; const idMenu = `${id}-m`;
  const m = useMenu();
  const valorTexto = textoCampo(p);
  const puesto = campoPuesto(p);
  const nombre = p.tipo === 'unica' && p.ariaLabel ? { 'aria-label': p.ariaLabel(valorTexto) } : { 'aria-labelledby': `${idRotulo} ${idValor}` };

  return (
    <div ref={m.celda} className="campo-filtro campo-filtro--ancla">
      <span className="campo-filtro__rotulo" id={idRotulo}>{p.rotulo}</span>
      <button ref={m.control} type="button" className="control control-filtro" data-puesto={puesto ? '' : undefined}
        aria-haspopup={p.tipo === 'fechas' ? 'dialog' : 'listbox'} aria-expanded={m.abierto}
        aria-controls={m.abierto ? idMenu : undefined} {...nombre} onClick={() => m.setAbierto((v) => !v)}>
        <span id={idValor} className={p.tipo === 'fechas' ? 'tabular-nums' : undefined}>{valorTexto}</span>
        {chevron}
      </button>
      {m.abierto && p.tipo === 'fechas' && (
        <PopoverFechas id={idMenu} rotulo={p.rotulo} valor={p.valor} onCambio={p.onCambio} />
      )}
      {m.abierto && p.tipo === 'multi' && (
        <div id={idMenu} role="group" aria-label={p.nombreGrupo} className="menu-flotante menu-filtro">
          {p.opciones.length === 0 && <p className="opcion-filtro opcion-filtro--vacia">Sin opciones</p>}
          {p.opciones.map((o) => (
            <label key={o.value} className="opcion-filtro">
              <input type="checkbox" className="accent-[var(--kit-azul)]" checked={p.seleccion.includes(o.value)}
                onChange={() => p.onCambio(p.seleccion.includes(o.value) ? p.seleccion.filter((x) => x !== o.value) : [...p.seleccion, o.value])} />
              <span className="truncate" title={o.label}>{o.label}</span>
            </label>
          ))}
        </div>
      )}
      {m.abierto && p.tipo === 'unica' && (
        <div id={idMenu} role="radiogroup" aria-label={p.rotulo} className="menu-flotante menu-filtro">
          {p.opciones.map((o) => (
            <label key={o.value} className="opcion-filtro">
              <input type="radio" name={idMenu} className="accent-[var(--kit-azul)]" checked={p.valor === o.value}
                onChange={() => { p.onCambio(o.value); m.setAbierto(false); m.control.current?.focus(); }} />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
