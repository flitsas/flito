// HU #14114 (Feature C2 #14092, Épica #13758, ADR-0030 §5) — errores de dominio del registro de traslado.
// Extienden `LogisticaError` para que `ejecutar` / `conIdempotencia` de la ruta los traduzcan.
import { LogisticaError } from './flito-logistica.base.js';

export class TrasladoLogisticaError extends LogisticaError {
  constructor(message: string, status: number, codigo: string, extra?: unknown) {
    super(message, status, extra, codigo);
  }
}

/** AC2: la compañía no tiene precio vigente para el destino. */
export class PrecioTrasladoNoConfiguradoError extends TrasladoLogisticaError {
  constructor(destino: 'cliente' | 'flit') {
    const etiqueta = destino === 'flit' ? 'FLIT' : 'cliente';
    super(
      `La compañía no tiene precio vigente de entrega a ${etiqueta}; configúralo en Tarifas antes de registrar el viaje`,
      422,
      'PRECIO_TRASLADO_NO_CONFIGURADO',
    );
  }
}

/**
 * AC3: logística encendida sin proveedor. El ADR nombra `PROVEEDOR_LOGISTICA_NO_ASIGNADO`;
 * el AC manda `PROVEEDOR_LOGISTICA_REQUERIDO` — ese es el código público. Ambos nombres de clase
 * apuntan aquí.
 */
export class ProveedorLogisticaRequeridoError extends TrasladoLogisticaError {
  constructor() {
    super(
      'Una compañía con la logística encendida necesita un proveedor de logística.',
      422,
      'PROVEEDOR_LOGISTICA_REQUERIDO',
    );
  }
}
export { ProveedorLogisticaRequeridoError as ProveedorLogisticaNoAsignadoError };

/** AC4: las LT no son todas de la compañía del cuerpo. */
export class TrasladoCompaniaMixtaError extends TrasladoLogisticaError {
  constructor(documentoIds: string[]) {
    super('Las LT de un viaje deben ser de una sola compañía', 422, 'TRASLADO_COMPANIA_MIXTA', { documentoIds });
  }
}

/** AC4: la LT ya tiene un viaje vivo al mismo destino (también ante 23505). */
export class LtYaEnTrasladoError extends TrasladoLogisticaError {
  constructor(documentoIds: string[] = []) {
    super('Una o más LT ya están en un viaje vivo a ese destino', 409, 'LT_YA_EN_TRASLADO', { documentoIds });
  }
}

/** AC5: la compañía autogestiona su logística. */
export class LogisticaAutogestionadaTrasladoError extends TrasladoLogisticaError {
  constructor() {
    super(
      'La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona',
      409,
      'LOGISTICA_AUTOGESTIONADA',
    );
  }
}

/** AC6: mensajero sobre LT que no recogió, sin `operar_ajenas`. */
export class LtAjenaTrasladoError extends TrasladoLogisticaError {
  constructor() {
    super('Solo puedes registrar el viaje de las LT que recogiste tú', 403, 'LT_AJENA');
  }
}

/** AC2 HU #14122: falta el motivo, no existe o está inactivo. Un solo código. */
export class MotivoLlegadaRequeridoError extends TrasladoLogisticaError {
  constructor() {
    super(
      'Cada LT que viaja a FLIT necesita un motivo de llegada activo',
      422,
      'MOTIVO_LLEGADA_REQUERIDO',
    );
  }
}

/** AC6 HU #14122: se pidió salir de FLIT y alguna LT no está en_flit. */
export class LtNoEnFlitError extends TrasladoLogisticaError {
  constructor(documentoIds: string[] = []) {
    super(
      'Para salir de FLIT todas las LT tienen que estar en FLIT',
      409,
      'LT_NO_EN_FLIT',
      { documentoIds },
    );
  }
}

/** AC4 HU #14122: la llegada a FLIT exige el trazo de la sesión. */
export class FirmaLlegadaRequeridaError extends TrasladoLogisticaError {
  constructor() {
    super('La llegada a FLIT requiere la firma de quien recibe', 422, 'FIRMA_LLEGADA_REQUERIDA');
  }
}

/** Cuerpo de llegada con cédula, nombre de receptor o firmante: no se descarta en silencio. */
export class DatosInvalidosTrasladoError extends TrasladoLogisticaError {
  constructor() {
    super('El cuerpo no corresponde a esta operación', 422, 'DATOS_INVALIDOS');
  }
}

export class LtNoEncontradaTrasladoError extends TrasladoLogisticaError {
  constructor(documentoIds: string[]) {
    super('Una o más LT no existen', 422, 'LT_NO_ENCONTRADA', { documentoIds });
  }
}

export class LtEstadoNoAdmisibleError extends TrasladoLogisticaError {
  constructor(documentoIds: string[]) {
    super('Una o más LT no están en un estado en el que se pueda registrar el viaje', 409, 'LT_ESTADO_NO_ADMISIBLE', { documentoIds });
  }
}

export class TrasladoOrigenMixtoError extends TrasladoLogisticaError {
  constructor() {
    super('Las LT de un viaje deben tener el mismo origen (organismo o FLIT)', 422, 'TRASLADO_ORIGEN_MIXTO');
  }
}

export class CompaniaNoEncontradaTrasladoError extends TrasladoLogisticaError {
  constructor() {
    super('Compañía no encontrada', 404, 'COMPANIA_NO_ENCONTRADA');
  }
}

export class SinLtClasificadasError extends TrasladoLogisticaError {
  constructor() {
    super('No hay LT clasificadas para esta empresa', 400, 'SIN_LT_CLASIFICADAS');
  }
}

export class TrasladoNoEncontradoError extends TrasladoLogisticaError {
  constructor() {
    super('Viaje no encontrado', 404, 'TRASLADO_NO_ENCONTRADO');
  }
}

/** Despachar/entregar/devolver/anular sobre un estado que no lo admite (p. ej. anular ya en ruta). */
export class TrasladoEstadoNoAdmisibleError extends TrasladoLogisticaError {
  constructor(estado: string, accion: string) {
    super(`El viaje no se puede ${accion} en estado "${estado}"`, 409, 'TRASLADO_ESTADO_NO_ADMISIBLE', { estado });
  }
}

export class TrasladoActaNoEncontradaError extends TrasladoLogisticaError {
  constructor() {
    super('El viaje no tiene un acta de cliente asociada', 409, 'TRASLADO_SIN_ACTA');
  }
}

export class EntregaSinEntregadasError extends TrasladoLogisticaError {
  constructor() {
    super(
      'La entrega requiere al menos una LT entregada; para devolver el viaje completo usa la devolución',
      422,
      'ENTREGA_SIN_ENTREGADAS',
    );
  }
}

export class TrasladoLtsNoCoincidenError extends TrasladoLogisticaError {
  constructor() {
    super('Las LT indicadas no coinciden con las líneas en ruta de este viaje', 422, 'TRASLADO_LTS_NO_COINCIDEN');
  }
}
