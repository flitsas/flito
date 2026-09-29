// FLITO — Gestión Trámites: la fuente del trámite en el listado (HU #13071, Feature #13058).
//
// FLIT es el caso normal y se ve sin pesar (texto muted); FLIT 2 es la excepción y va en chip para
// que el ojo la encuentre. Las etiquetas salen SOLO de `ETIQUETA_FUENTE_TRAMITE`.
import { ETIQUETA_FUENTE_TRAMITE, esFuenteTramite, type FuenteTramite } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { FlitEmpty, flitBtnSecondarySm } from '../flit/flitPageKit';

/** Opciones del filtro segmentado: '' = Todas. */
export const OPCIONES_FUENTE: ReadonlyArray<{ valor: '' | FuenteTramite; etiqueta: string }> = [
  { valor: '', etiqueta: 'Todas' },
  { valor: 'flit', etiqueta: ETIQUETA_FUENTE_TRAMITE.flit },
  { valor: 'flit2', etiqueta: ETIQUETA_FUENTE_TRAMITE.flit2 },
];

export function CeldaFuenteTramite({ fuente }: { fuente: unknown }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 align-top">
      {!esFuenteTramite(fuente) ? (
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }} aria-label="Fuente desconocida">—</span>
      ) : fuente === 'flit2' ? (
        <StatusChip tone="neutral">{ETIQUETA_FUENTE_TRAMITE.flit2}</StatusChip>
      ) : (
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{ETIQUETA_FUENTE_TRAMITE[fuente]}</span>
      )}
    </td>
  );
}

/** Vacío filtrado cuando hay una fuente elegida: nunca un error (AC4), siempre con salida. */
export function VacioFuenteTramite({ fuente, otrosFiltros, onVerTodas }: {
  fuente: FuenteTramite; otrosFiltros: boolean; onVerTodas: () => void;
}) {
  const etiqueta = ETIQUETA_FUENTE_TRAMITE[fuente];
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
