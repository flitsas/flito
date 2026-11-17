// Estado de un registro (activo / inactivo) en las tablas de Clientes y proveedores (HU #13948).
//
// Genérico sobre un booleano y sin dependencia de `Client`: la pestaña Proveedores (#13961) usa
// estas mismas piezas. Lo que NO vive aquí es el copy del vacío sin registros y del error de carga,
// porque dicen «clientes» o «proveedores» y son de cada pestaña.
//
// El filtro es EN CLIENTE sobre lo ya cargado: cambiarlo no pide datos ni pasa por «Cargando».

import StatusChip from '../flit/StatusChip';
import FiltroSegmentado from '../flit/FiltroSegmentado';
import { Vacio } from '../flit/Cargador';
import GradientButton from '../flit/GradientButton';

export type FiltroEstado = 'todos' | 'activos' | 'inactivos';

const OPCIONES: { valor: FiltroEstado; etiqueta: string }[] = [
  { valor: 'todos', etiqueta: 'Todos' },
  { valor: 'activos', etiqueta: 'Activos' },
  { valor: 'inactivos', etiqueta: 'Inactivos' },
];

/**
 * Segmentado del kit (`FiltroSegmentado`): `role="group"` con el nombre del rótulo visible, así el
 * lector anuncia «Estado» al entrar y `aria-pressed` dice cuál está puesta (AC6).
 */
export function FiltroEstadoPills({ valor, onCambio, etiqueta = 'Estado' }: {
  valor: FiltroEstado; onCambio: (v: FiltroEstado) => void; etiqueta?: string;
}) {
  return <FiltroSegmentado opciones={OPCIONES} valor={valor} onCambio={onCambio} ariaLabel={etiqueta} rotulo={etiqueta} />;
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
    <p role="status" className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
      Mostrando {visibles} de {total}
    </p>
  );
}

/** Existen registros, pero ninguno con este filtro: el siguiente paso es volver a «Todos». */
export function VacioFiltro({ onVerTodos }: { onVerTodos: () => void }) {
  return (
    <Vacio
      texto="No hay registros con este filtro."
      icono="filtro"
      accion={<GradientButton variant="secondary" size="sm" onClick={onVerTodos}>Ver todos</GradientButton>}
    />
  );
}

/** Filtro puro: Clientes pasa `(c) => c.active`; Proveedores, `(p) => p.activo`. */
export function filtrarPorEstado<T>(items: T[], filtro: FiltroEstado, esActivo: (t: T) => boolean): T[] {
  if (filtro === 'todos') return items;
  const quiere = filtro === 'activos';
  return items.filter((t) => esActivo(t) === quiere);
}
