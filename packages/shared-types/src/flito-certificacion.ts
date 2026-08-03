/**
 * Certificación de un impuesto contra el RUNT (Feature #11159).
 *
 * Certificar es contrastar lo que FLITO cree del vehículo con lo que el RUNT reporta, ANTES de que
 * salga el dinero del impuesto. Hasta ahora nadie lo hacía: placa, VIN y propietario entran por el
 * sync con FLIT y por el OCR de la factura de venta, y un error de digitación solo se descubría
 * cuando el organismo rechazaba el pago.
 *
 * Qué se puede contrastar de verdad — y qué no:
 *
 *   La consulta de vehículo del RUNT NO devuelve el propietario. Su respuesta es
 *   `{ vehiculo, tipoDocPropietario, ... }`, y `tipoDocPropietario` es solo el CÓDIGO DE TIPO de
 *   documento que funcionó ('C', 'E', …), no el nombre ni el número. Comparar el nombre del
 *   propietario exigiría una segunda consulta (`consulta-persona`), que duplicaría latencia y costo
 *   por registro.
 *
 *   No hace falta: la consulta se autentica CON placa + documento. Que el RUNT responda OK ya prueba
 *   que ese documento es el del propietario registrado. La propiedad queda validada por
 *   construcción, y esa prueba es más fuerte que comparar dos cadenas de texto (RN-02).
 *
 * Por eso solo placa y VIN son bloqueantes: son los únicos datos del vehículo que el RUNT devuelve y
 * que FLITO tiene para contrastar.
 */

/** Campos del vehículo que se contrastan al certificar. */
export const CampoCertificacion = {
  PLACA: 'placa',
  VIN: 'vin',
  MARCA: 'marca',
  LINEA: 'linea',
  MODELO: 'modelo',
  CLASE: 'clase',
} as const;

export type CampoCertificacion = (typeof CampoCertificacion)[keyof typeof CampoCertificacion];

export const CAMPO_CERTIFICACION_LABEL: Record<CampoCertificacion, string> = {
  placa: 'Placa',
  vin: 'VIN',
  marca: 'Marca',
  linea: 'Línea',
  modelo: 'Modelo',
  clase: 'Clase',
};

/**
 * Campos que impiden certificar si no coinciden (RN-03).
 *
 * Marca, línea, modelo y clase quedan FUERA a propósito: la nomenclatura del RUNT y la de FLIT
 * difieren de forma sistemática ('CHEVROLET' contra 'CHEVROLET (GM)', líneas con y sin sufijo de
 * versión), así que exigir igualdad literal condenaría a fallar a casi todos los registros. Se
 * muestran en el certificado como informativos.
 */
export const CAMPOS_BLOQUEANTES: readonly CampoCertificacion[] = [
  CampoCertificacion.PLACA,
  CampoCertificacion.VIN,
];

/** Desenlace de UN campo comparado. */
export const ResultadoCampo = {
  COINCIDE: 'coincide',
  DIFIERE: 'difiere',
  /** El RUNT no reportó el dato. No bloquea aunque el campo sea bloqueante (AC4). */
  NO_VERIFICABLE: 'no_verificable',
  /** FLITO no tiene el dato para contrastar. Tampoco bloquea: no hay nada que comparar. */
  SIN_DATO_FLITO: 'sin_dato_flito',
} as const;

export type ResultadoCampo = (typeof ResultadoCampo)[keyof typeof ResultadoCampo];

export interface ComparacionCampo {
  campo: CampoCertificacion;
  resultado: ResultadoCampo;
  /** Si este campo, al diferir, impide certificar. Se persiste para que el detalle sea legible sin recalcular. */
  bloqueante: boolean;
  valorFlito: string | null;
  valorRunt: string | null;
}

/**
 * Desenlace global de un intento de certificación.
 *
 * `TRASPASO_EN_SINCRONIZACION` existe porque tras un traspaso el RUNT rechaza la consulta
 * placa + documento durante 24-72 horas hábiles con un mensaje de «propietario» (RN-08). No es un
 * fallo del servicio ni un dato mal digitado: basta esperar. Meterlo en `ERROR_SERVICIO` dejaría al
 * gestor sin saber que solo tiene que reintentar mañana. Mismo criterio que `owner_sync_pending` en
 * `soat/refresh.service.ts`.
 */
export const ResultadoCertificacion = {
  CERTIFICADO: 'certificado',
  CON_DIFERENCIAS: 'con_diferencias',
  NO_ELEGIBLE: 'no_elegible',
  TRASPASO_EN_SINCRONIZACION: 'traspaso_en_sincronizacion',
  ERROR_SERVICIO: 'error_servicio',
} as const;

export type ResultadoCertificacion = (typeof ResultadoCertificacion)[keyof typeof ResultadoCertificacion];

export const RESULTADO_CERTIFICACION_LABEL: Record<ResultadoCertificacion, string> = {
  certificado: 'Certificado',
  con_diferencias: 'Con diferencias',
  no_elegible: 'No certificable',
  traspaso_en_sincronizacion: 'Traspaso en sincronización',
  error_servicio: 'Error del servicio RUNT',
};

/** Motivos por los que un registro no es certificable sin siquiera consultar el RUNT (RN-09, AC6). */
export const MotivoNoElegible = {
  SIN_DOCUMENTO_PROPIETARIO: 'sin_documento_propietario',
  SIN_PLACA: 'sin_placa',
  ESTADO_NO_ELEGIBLE: 'estado_no_elegible',
} as const;

export type MotivoNoElegible = (typeof MotivoNoElegible)[keyof typeof MotivoNoElegible];

export const MOTIVO_NO_ELEGIBLE_LABEL: Record<MotivoNoElegible, string> = {
  sin_documento_propietario: 'El vehículo no tiene documento de propietario, necesario para consultar el RUNT por placa.',
  sin_placa: 'El vehículo no tiene placa registrada.',
  estado_no_elegible: 'Solo se certifican impuestos ya enviados al gestor.',
};

/** Datos del vehículo que FLITO aporta a la comparación. */
export interface DatosVehiculoFlito {
  placa: string | null;
  vin: string | null;
  marca: string | null;
  linea: string | null;
  modelo: string | null;
  clase: string | null;
}

/** Los mismos datos, ya extraídos de la respuesta cruda del RUNT. */
export type DatosVehiculoRunt = DatosVehiculoFlito;

/** Veredicto de la comparación. Puro: no sabe de red ni de base de datos. */
export interface VeredictoComparacion {
  certificable: boolean;
  campos: ComparacionCampo[];
  /** Solo los bloqueantes que difieren — lo que el usuario necesita leer primero. */
  diferenciasBloqueantes: ComparacionCampo[];
}
