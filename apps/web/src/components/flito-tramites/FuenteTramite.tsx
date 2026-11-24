// FLITO — Gestión Trámites: la fuente del trámite en el listado (HU #13071, Feature #13058).
//
// La fuente se nombra siempre con su número, «FLIT 1» / «FLIT 2» (Épica #14560, pedido del PO), y las
// dos van en la misma pastilla del kit, igual que la cabecera del detalle. Es solo el rótulo visible:
// el valor que viaja al API (`?fuente=flit|flit2`) no cambia.
import { esFuenteTramite, type FuenteTramite } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { FlitEmpty, flitBtnSecondarySm } from '../flit/flitPageKit';

/** Rótulo visible de cada fuente (tabla, filtro y vacío filtrado). */
export const ETIQUETA_FUENTE_UI: Record<FuenteTramite, string> = { flit: 'FLIT 1', flit2: 'FLIT 2' };

/** Opciones del filtro segmentado: '' = Todas. */
export const OPCIONES_FUENTE: ReadonlyArray<{ valor: '' | FuenteTramite; etiqueta: string }> = [
  { valor: '', etiqueta: 'Todas' },
  { valor: 'flit', etiqueta: ETIQUETA_FUENTE_UI.flit },
  { valor: 'flit2', etiqueta: ETIQUETA_FUENTE_UI.flit2 },
];

export function CeldaFuenteTramite({ fuente }: { fuente: unknown }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 align-top">
      {!esFuenteTramite(fuente) ? (
        <span className="text-xs text-[color:var(--color-text-tertiary)]" aria-label="Fuente desconocida">—</span>
      ) : (
        <StatusChip tone="neutral">{ETIQUETA_FUENTE_UI[fuente]}</StatusChip>
      )}
    </td>
  );
}

/** Vacío filtrado cuando hay una fuente elegida: nunca un error (AC4), siempre con salida. */
export function VacioFuenteTramite({ fuente, otrosFiltros, onVerTodas }: {
  fuente: FuenteTramite; otrosFiltros: boolean; onVerTodas: () => void;
}) {
  const etiqueta = ETIQUETA_FUENTE_UI[fuente];
  return (
    <FlitEmpty>
      <p>
        {otrosFiltros
          ? `Ningún trámite de ${etiqueta} coincide con los filtros.`
          : `Todavía no hay trámites de ${etiqueta}. Cuando lleguen, aparecen aquí.`}
      </p>
      <button type="button" className={`${flitBtnSecondarySm} mt-3`} onClick={onVerTodas}>
        Ver todas las fuentes
      </button>
    </FlitEmpty>
  );
}
