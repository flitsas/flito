// Reporte de costos — el panel «Columnas» y su preferencia (rediseño, Épica #13763, spec §3.5).
//
// Sustituye al binario compacta/ampliada: casillas por grupo, Trámite y Placa sin casilla (no se
// pueden ocultar) y «Restablecer columnas». La preferencia es la LISTA de columnas visibles en una
// clave nueva, `flito.reporteCostos.columnas.v2`; la vieja (`flito.reporteCostos.columnas`) se
// ignora, no se migra ni se borra. Todo acceso a `localStorage` va en try/catch: sin almacenamiento
// (modo privado, cuota) la tabla arranca por defecto y no se recuerda.
//
// Es un `<details>`, el patrón de `RangoFechas` y `FiltrosInteligentes`: Esc cierra y devuelve el
// foco al summary.

import { useRef, useState, type KeyboardEvent } from 'react';
import { COLUMNAS, FIJAS, GRUPOS, POR_DEFECTO, type Columna } from './definicionColumnasReporteCostos';

export const CLAVE_COLUMNAS = 'flito.reporteCostos.columnas.v2';

function leer(): Set<string> {
  try {
    const crudo = localStorage.getItem(CLAVE_COLUMNAS);
    if (!crudo) return new Set(POR_DEFECTO);
    const lista: unknown = JSON.parse(crudo);
    if (!Array.isArray(lista)) return new Set(POR_DEFECTO);
    const conocidas = new Set(COLUMNAS.map((c) => c.id));
    return new Set([...FIJAS, ...lista.filter((x): x is string => typeof x === 'string' && conocidas.has(x))]);
  } catch {
    return new Set(POR_DEFECTO);
  }
}

function guardar(ids: Set<string>) {
  try { localStorage.setItem(CLAVE_COLUMNAS, JSON.stringify([...ids])); } catch { /* sin almacenamiento */ }
}

/** Las columnas visibles, leídas en el `useState` inicial (sin parpadeo) y anunciadas al cambiar. */
export function useColumnasVisibles(anunciar: (texto: string) => void) {
  const [ids, setIds] = useState<Set<string>>(leer);
  const aplicar = (n: Set<string>) => {
    setIds(n);
    guardar(n);
    // Las cifras salen de las listas, nunca escritas a mano.
    anunciar(`Columnas: ${n.size} de ${COLUMNAS.length} visibles.`);
  };
  const alternar = (id: string) => {
    if (FIJAS.has(id)) return;
    const n = new Set(ids);
    if (n.has(id)) n.delete(id); else n.add(id);
    aplicar(n);
  };
  const restablecer = () => aplicar(new Set(POR_DEFECTO));
  const visibles: Columna[] = COLUMNAS.filter((c) => ids.has(c.id));
  return { ids, visibles, alternar, restablecer };
}

export default function ColumnasReporteCostos({ ids, onAlternar, onRestablecer }: {
  ids: Set<string>; onAlternar: (id: string) => void; onRestablecer: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const alTeclear = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ref.current?.open) return;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
  };
  return (
    <details ref={ref} className="relative" onKeyDown={alTeclear}>
      <summary className="flit-focus inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-[999px] border bg-flit-card px-4 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
        Columnas
        <span className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{ids.size}/{COLUMNAS.length}</span>
      </summary>
      <div className="absolute right-0 z-30 mt-1 max-h-[70vh] w-[min(20rem,calc(100vw-2rem))] overflow-auto rounded-lg border bg-flit-card p-3"
        style={{ borderColor: 'var(--flit-border-input)', boxShadow: 'var(--flit-shadow-card)' }}>
        {GRUPOS.filter((g) => g.clave !== 'fija').map((g) => (
          <fieldset key={g.clave} className="mb-3">
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>{g.titulo}</legend>
            {COLUMNAS.filter((c) => c.grupo === g.clave).map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm transition-colors hover:bg-[var(--flit-bg-hover)]"
                style={{ color: 'var(--flit-text-primary)' }}>
                <input type="checkbox" checked={ids.has(c.id)} onChange={() => onAlternar(c.id)} />
                {c.titulo}
              </label>
            ))}
          </fieldset>
        ))}
        <p className="mb-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Trámite y Placa siempre se ven. El Excel trae todas las columnas.</p>
        <button type="button" className="flit-focus rounded text-sm font-semibold underline transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-blue-text)' }} onClick={onRestablecer}>
          Restablecer columnas
        </button>
      </div>
    </details>
  );
}
