// Rótulo de un evento del recorrido de una LT, por TIPO de evento (no por estado).
// Compartido por la línea de tiempo del trámite y la bitácora del acta (sin duplicar el mapeo).

import {
  ESTADO_DOCUMENTO_LOGISTICA_LABEL,
  ESTADO_LOGISTICA_SIMPLE_LABEL,
  simplificarEstadoLogistica,
  type EstadoDocumentoLogistica,
} from '@operaciones/shared-types';

function etiquetaDocumento(estado: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(ESTADO_DOCUMENTO_LOGISTICA_LABEL, estado)) return null;
  return ESTADO_DOCUMENTO_LOGISTICA_LABEL[estado as EstadoDocumentoLogistica];
}

/** Nunca la clave cruda (`en_acta`, `recogida`). Llegada y anulación ganan al estado. */
export function rotuloEvento(evento: { tipo: string | null; estadoNuevo: string }): string {
  if (evento.tipo === 'llegada') return 'Llegada a FLIT';
  // Varios eventos escriben el mismo estado sin cambiarlo (acta, destino): rotular por tipo
  // evita líneas idénticas seguidas.
  if (evento.tipo === 'acta_organismo') return 'Acta de organismo firmada';
  if (evento.tipo === 'destino_registrado') return 'Destino registrado';
  if (evento.tipo === 'acta_flit') return 'Acta hacia FLIT';
  if (evento.tipo === 'acta_cliente') return 'Acta a cliente generada';
  if (evento.estadoNuevo === 'anulado' || evento.tipo === 'anulacion') return 'Anulado';
  return etiquetaDocumento(evento.estadoNuevo)
    ?? ESTADO_LOGISTICA_SIMPLE_LABEL[simplificarEstadoLogistica(evento.estadoNuevo)];
}
