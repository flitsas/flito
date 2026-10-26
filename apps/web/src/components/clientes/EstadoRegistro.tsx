// Estado de un registro (activo / inactivo) en las tablas de Clientes y proveedores (HU #13948).
//
// Genérico sobre un booleano y sin dependencia de `Client`: la pestaña Proveedores (#13961) usa
// estas mismas piezas. Lo que NO vive aquí es el copy del vacío sin registros y del error de carga,
// porque dicen «clientes» o «proveedores» y son de cada pestaña.
//
// El filtro es EN CLIENTE sobre lo ya cargado: cambiarlo no pide datos ni pasa por «Cargando».

import { useId } from 'react';
import StatusChip from '../flit/StatusChip';
import {
  FlitEmpty, FlitPillGroup, FlitPillButton, flitBtnSecondarySm, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export type FiltroEstado = 'todos' | 'activos' | 'inactivos';

const OPCIONES: { valor: FiltroEstado; texto: string }[] = [
  { valor: 'todos', texto: 'Todos' },
  { valor: 'activos', texto: 'Activos' },
  { valor: 'inactivos', texto: 'Inactivos' },
];

/**
 * Grupo rotulado de pills. `role="group"` + `aria-labelledby` al rótulo visible: así el lector
 * anuncia «Estado» al entrar y `aria-pressed` dice cuál está puesta (AC6). Es el mismo patrón de
 * filtro rotulado de `BarraFiltrosBandeja`.
 */
export function FiltroEstadoPills({ valor, onCambio, etiqueta = 'Estado' }: {
  valor: FiltroEstado; onCambio: (v: FiltroEstado) => void; etiqueta?: string;
}) {
  const idRotulo = useId();
  return (
    <div role="group" aria-labelledby={idRotulo} className="flex flex-col gap-1.5">
      <span id={idRotulo} className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
        {etiqueta}
      </span>
      <FlitPillGroup>
        {OPCIONES.map((o) => (
          <FlitPillButton key={o.valor} active={valor === o.valor} pressed={valor === o.valor} onClick={() => onCambio(o.valor)}>
            {o.texto}
          </FlitPillButton>
        ))}
      </FlitPillGroup>
    </div>
  );
}

/** El texto es el dato; el color solo acompaña (AC6). */
export function ChipEstado({ activo }: { activo: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <StatusChip tone={activo ? 'success' : 'neutral'}>{activo ? 'Activo' : 'Inactivo'}</StatusChip>
    </span>
  );
}

/** «Mostrando X de Y». X = visibles tras el filtro; Y = total cargado. Se anuncia al cambiar. */
export function PieConteo({ visibles, total }: { visibles: number; total: number }) {
  return (
    <p role="status" className="mt-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
      Mostrando {visibles} de {total}
    </p>
  );
}

/** Existen registros, pero ninguno con este filtro: el siguiente paso es volver a «Todos». */
export function VacioFiltro({ onVerTodos }: { onVerTodos: () => void }) {
  return (
    <FlitEmpty>
      <p>No hay registros con este filtro.</p>
      <button type="button" className={`${flitBtnSecondarySm} mt-3`} style={flitBtnSecondaryStyle} onClick={onVerTodos}>
        Ver todos
      </button>
    </FlitEmpty>
  );
}

/** Filtro puro: Clientes pasa `(c) => c.active`; Proveedores, `(p) => p.activo`. */
export function filtrarPorEstado<T>(items: T[], filtro: FiltroEstado, esActivo: (t: T) => boolean): T[] {
  if (filtro === 'todos') return items;
  const quiere = filtro === 'activos';
  return items.filter((t) => esActivo(t) === quiere);
}
