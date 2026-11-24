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
 * Aditivas para tablas cruzadas (Torre #14590): `encabezadoFila` (la 1.ª columna es `<th scope="row">`, fija en
 * `matriz`), `pie` (filas de `<tfoot>`, que se repiten en cada página), `caption` (`sr-only`) y `regionDesplazable`
 * (el contenedor que se desliza es enfocable, con ese `aria-label`).
 * Aditivas para colas con fila marcada y filas especiales (Épica #14560, cola SOAT): `filaMarcada` (velo + filete
 * izquierdo del acento, `data-marcada`) y `filasPrevias` (`<tr>` propios del consumidor, ANTES de las filas de datos;
 * cuentan como contenido para el estado vacío).
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
  /** Aditivo (Torre #14590, detalle): `aria-sort` del `<th>` de una columna ordenable. */
  ariaSort?: 'ascending' | 'descending' | 'none';
}

export interface SeleccionTabla {
  seleccionados: ReadonlySet<string>;
  onCambio: (siguiente: Set<string>) => void;
  etiquetaFila?: (key: string) => string;
}

/** Mismo velo + filete que `FlitTr marcada` (flitPageKit), para que la fila marcada no cambie al migrar. */
const FILA_MARCADA = 'bg-[var(--kit-hover)] shadow-[inset_3px_0_0_var(--kit-azul)]';

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

export default function DataTable<T>({
  columnas, filas, getKey, status, onRetry, emptyMessage, emptyDetalle, emptyCta, errorMessage, ariaLabel,
  matriz = false, seleccion, onFilaClick, paginacion, minWidth, encabezadoFila = false, pie, caption, regionDesplazable,
  filaMarcada, filasPrevias,
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
  encabezadoFila?: boolean;
  /** Contenido de `<tfoot>` (`<tr>…</tr>`). */
  pie?: ReactNode;
  caption?: string;
  regionDesplazable?: string;
  /** Fila marcada por el consumidor (selección propia): velo + filete izquierdo, como `FlitTr marcada`. */
  filaMarcada?: (row: T) => boolean;
  /** `<tr>` del consumidor que van antes de las filas de datos (p. ej. solicitudes incompletas del SOAT). */
  filasPrevias?: ReactNode;
}) {
  const hayPrevias = filasPrevias !== undefined && filasPrevias !== null && filasPrevias !== false
    && !(Array.isArray(filasPrevias) && filasPrevias.length === 0);
  const efectivo: EstadoUi = status && status !== 'ready' ? status : filas.length === 0 && !hayPrevias ? 'empty' : 'ready';
  const keys = filas.map(getKey);
  const todas = seleccion ? keys.length > 0 && keys.every((k) => seleccion.seleccionados.has(k)) : false;
  const alternar = (k: string) => {
    if (!seleccion) return;
    const s = new Set(seleccion.seleccionados);
    if (s.has(k)) s.delete(k); else s.add(k);
    seleccion.onCambio(s);
  };
  return (
    <div className={`tabla-wrap${matriz ? ' kit-matriz' : ''}${regionDesplazable ? ' flit-focus' : ''}`} data-kit="tabla" data-modo={matriz ? 'matriz' : 'tarjetas'}
      {...(regionDesplazable ? { tabIndex: 0, role: 'region', 'aria-label': regionDesplazable } : {})}>
      <EstadoVista status={efectivo} onRetry={onRetry} emptyMessage={emptyMessage} emptyDetalle={emptyDetalle} emptyCta={emptyCta} errorMessage={errorMessage}>
        <table className={matriz ? 'matriz kit-matriz__tabla' : undefined} aria-label={ariaLabel} style={minWidth ? { minWidth } : undefined}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {seleccion && (
                <th scope="col" className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" aria-label="Seleccionar todas las filas" checked={todas}
                    onChange={() => seleccion.onCambio(todas ? new Set() : new Set(keys))} />
                </th>
              )}
              {columnas.map((c) => <th key={c.key} scope="col" aria-sort={c.ariaSort} className={`${ALIGN[c.align ?? 'left']} ${c.soloEscritorio ? 'solo-escritorio' : ''}`}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {filasPrevias}
            {filas.map((row) => {
              const k = getKey(row);
              const marcada = filaMarcada ? filaMarcada(row) : false;
              const clase = [onFilaClick ? 'cursor-pointer' : '', marcada ? FILA_MARCADA : ''].filter(Boolean).join(' ');
              return (
                <tr key={k} onClick={onFilaClick ? () => onFilaClick(row) : undefined} className={clase || undefined}
                  data-marcada={marcada || undefined}
                  aria-selected={seleccion ? seleccion.seleccionados.has(k) : undefined}>
                  {seleccion && (
                    <td data-etiqueta="Seleccionar" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" checked={seleccion.seleccionados.has(k)}
                        aria-label={seleccion.etiquetaFila ? seleccion.etiquetaFila(k) : 'Seleccionar fila'} onChange={() => alternar(k)} />
                    </td>
                  )}
                  {columnas.map((c, i) => {
                    if (encabezadoFila && i === 0) {
                      const contenido = c.render(row);
                      return (
                        <th key={c.key} scope="row" title={typeof contenido === 'string' ? contenido : undefined}
                          className={`${ALIGN[c.align ?? 'left']} ${c.className ?? ''}`}>{contenido}</th>
                      );
                    }
                    return (
                    <td key={c.key}
                      data-etiqueta={c.etiqueta ?? (typeof c.header === 'string' ? c.header : undefined)}
                      className={`${ALIGN[c.align ?? 'left']}${c.soloEscritorio ? ' solo-escritorio' : ''}${c.acciones ? ' fila-abrir' : ''} ${c.className ?? ''}`}
                      onClick={c.acciones ? (e) => e.stopPropagation() : undefined}>
                      {c.render(row)}
                    </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {pie && <tfoot>{pie}</tfoot>}
        </table>
      </EstadoVista>
      {paginacion && efectivo === 'ready' && <div className="px-3.5 pb-3"><Paginacion {...paginacion} /></div>}
    </div>
  );
}
