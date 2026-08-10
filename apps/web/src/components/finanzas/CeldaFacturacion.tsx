// Reporte de costos — la celda «Factura DIAN» de cada fila (HU #11337).
//
// Componente propio, minúsculo, y aun así separado: la pantalla que lo aloja está a 180 líneas del
// techo del repositorio y la celda va a crecer —el día que haya acción de reintento, por ejemplo—.
// Es más barato nacer fuera que salir después.

import { SIIGO_ESTADO_REPORTE_ETIQUETA } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import type { FacturacionTramite } from './tiposFacturacion';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';

const TONO: Record<SiigoEstadoReporte, ChipTone> = {
  no_enviado: 'draft',
  en_proceso: 'active',
  emitido: 'active',
  aceptado: 'success',
  rechazado: 'danger',
  anulado: 'neutral',
  fallido: 'danger',
};

interface Props {
  /** `undefined` = a este trámite nunca se le pidió factura. No es un fallo de carga. */
  ficha: FacturacionTramite | undefined;
  onAbrir: (ficha: FacturacionTramite) => void;
}

export default function CeldaFacturacion({ ficha, onAbrir }: Props) {
  // Sin ficha se pinta una raya y no «Sin enviar»: el reporte muestra trámites que quizá ni siquiera
  // están liquidados, y afirmar «sin enviar» sobre uno al que todavía no le toca sugiere un trabajo
  // pendiente que no existe. La raya dice «aquí no hay nada que mirar», que es la verdad.
  if (!ficha) {
    return <span style={{ color: 'var(--flit-text-muted)' }}>—</span>;
  }

  const necesitaAtencion = ficha.estado === 'rechazado' || ficha.estado === 'fallido';

  return (
    <button
      type="button"
      onClick={() => onAbrir(ficha)}
      className="flit-focus inline-flex items-center gap-1.5"
      // El título adelanta lo esencial sin abrir nada: en una tabla de doscientas filas, obligar a
      // abrir un modal por fila para saber por qué falló es hacer doscientos clics para un informe.
      title={necesitaAtencion && ficha.motivo
        ? ficha.motivo
        : `${SIIGO_ESTADO_REPORTE_ETIQUETA[ficha.estado]} — ver detalle`}
    >
      <StatusChip tone={TONO[ficha.estado]}>{SIIGO_ESTADO_REPORTE_ETIQUETA[ficha.estado]}</StatusChip>
      {/* Un rechazo sin motivo consultado todavía se marca, para que no parezca un rechazo sin causa. */}
      {ficha.motivoPendiente && (
        <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }} title="El motivo aún no se ha podido consultar">?</span>
      )}
    </button>
  );
}
