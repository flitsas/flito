import type { ReactNode } from 'react';
import { EstadoVista, type EstadoUi } from './Cargador';
import Paginacion from './Paginacion';

/**
 * Tabla del UI Kit 2026 (`.tabla-wrap`; DataTable de flit develop). >900 px: contenedor con borde y radio 9, cabecera
 * #A9C9FC en mayúscula, filas separadas por línea y hover. ≤900 px: cada fila es una TARJETA (la primera celda hace
 * de título y cada celda muestra su columna con `data-etiqueta`); ≤380 px una columna.
 * `matriz`: para RACI, tarifas o ~20 columnas — scroll horizontal dentro del contenedor en vez de tarjetas.
 * `seleccion`: casillas por fila y «todas» en la cabecera (estado en el padre).
 * Trae los 4 estados (status + reintento) y paginación opcional (también modo cursor de Paginacion).
 */
export interface ColumnaTabla<T> {
  key: string;
  header: ReactNode;
  /** Texto de la columna en modo tarjeta; por defecto `header` si es texto. */
  etiqueta?: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'center' | 'right';
  /** Se oculta en modo tarjeta (`.solo-escritorio`). */
  soloEscritorio?: boolean;
  /** Celda de «Acciones» (`.fila-abrir`): a la derecha y sin etiqueta en tarjeta. */
  acciones?: boolean;
  className?: string;
}

export interface SeleccionTabla {
  seleccionados: ReadonlySet<string>;
  onCambio: (siguiente: Set<string>) => void;
  etiquetaFila?: (key: string) => string;
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

export default function DataTable<T>({
  columnas, filas, getKey, status, onRetry, emptyMessage, emptyDetalle, emptyCta, errorMessage, ariaLabel,
  matriz = false, seleccion, onFilaClick, paginacion, minWidth,
}: {
  columnas: ColumnaTabla<T>[];
  filas: T[];
  getKey: (row: T) => string;
  status?: EstadoUi;
  onRetry?: () => void;
  emptyMessage?: string;
  emptyDetalle?: string;
  emptyCta?: ReactNode;
  errorMessage?: string;
  ariaLabel: string;
  matriz?: boolean;
  seleccion?: SeleccionTabla;
  onFilaClick?: (row: T) => void;
  paginacion?: Parameters<typeof Paginacion>[0];
  minWidth?: number;
}) {
  const efectivo: EstadoUi = status && status !== 'ready' ? status : filas.length === 0 ? 'empty' : 'ready';
  const keys = filas.map(getKey);
  const todas = seleccion ? keys.length > 0 && keys.every((k) => seleccion.seleccionados.has(k)) : false;
  const alternar = (k: string) => {
    if (!seleccion) return;
    const s = new Set(seleccion.seleccionados);
    if (s.has(k)) s.delete(k); else s.add(k);
    seleccion.onCambio(s);
  };
  return (
    <div className={`tabla-wrap${matriz ? ' kit-matriz' : ''}`} data-kit="tabla" data-modo={matriz ? 'matriz' : 'tarjetas'}>
      <EstadoVista status={efectivo} onRetry={onRetry} emptyMessage={emptyMessage} emptyDetalle={emptyDetalle} emptyCta={emptyCta} errorMessage={errorMessage}>
        <table className={matriz ? 'matriz kit-matriz__tabla' : undefined} aria-label={ariaLabel} style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {seleccion && (
                <th scope="col" className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" aria-label="Seleccionar todas las filas" checked={todas}
                    onChange={() => seleccion.onCambio(todas ? new Set() : new Set(keys))} />
                </th>
              )}
              {columnas.map((c) => <th key={c.key} scope="col" className={`${ALIGN[c.align ?? 'left']} ${c.soloEscritorio ? 'solo-escritorio' : ''}`}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {filas.map((row) => {
              const k = getKey(row);
              return (
                <tr key={k} onClick={onFilaClick ? () => onFilaClick(row) : undefined} className={onFilaClick ? 'cursor-pointer' : undefined}
                  aria-selected={seleccion ? seleccion.seleccionados.has(k) : undefined}>
                  {seleccion && (
                    <td data-etiqueta="Seleccionar" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" checked={seleccion.seleccionados.has(k)}
                        aria-label={seleccion.etiquetaFila ? seleccion.etiquetaFila(k) : 'Seleccionar fila'} onChange={() => alternar(k)} />
                    </td>
                  )}
                  {columnas.map((c) => (
                    <td key={c.key}
                      data-etiqueta={c.etiqueta ?? (typeof c.header === 'string' ? c.header : undefined)}
                      className={`${ALIGN[c.align ?? 'left']}${c.soloEscritorio ? ' solo-escritorio' : ''}${c.acciones ? ' fila-abrir' : ''} ${c.className ?? ''}`}
                      onClick={c.acciones ? (e) => e.stopPropagation() : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </EstadoVista>
      {paginacion && efectivo === 'ready' && <div className="px-3.5 pb-3"><Paginacion {...paginacion} /></div>}
    </div>
  );
}
