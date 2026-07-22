// FLITO — campos extraídos por OCR de factura SOAT, recibo de impuesto y factura
// de venta, con confianza por campo y motivo de revisión. Portado desde
// packages/shared/src/ocr.ts. Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §8.
//
// El motor OCR es Anthropic (Claude), pero el CONTRATO de campos y el modelo de
// confianza se conservan: RN-04/RN-05 (un dato bajo umbral no se persiste como
// válido sin confirmación humana) dependen de este tipo.

/** Campos que el OCR extrae de una factura de SOAT (FEATURE_SOAT §9.3). */
export const CampoSoat = {
  PLACA: 'placa',
  VIN: 'vin',
  NUMERO_POLIZA: 'numeroPoliza',
  FECHA_EXPEDICION: 'fechaExpedicion',
  VIGENCIA_DESDE: 'vigenciaDesde',
  VIGENCIA_HASTA: 'vigenciaHasta',
  VALOR_TOTAL: 'valorTotal',
  ASEGURADORA: 'aseguradora',
} as const;

export type CampoSoat = (typeof CampoSoat)[keyof typeof CampoSoat];

/**
 * Campos que el OCR extrae de una factura de venta.
 * Placa y VIN son ambos obligatorios (doble llave): el VIN identifica el vehículo
 * físico y la placa el trámite. `valorVehiculo` es la base gravable del impuesto.
 */
export const CampoFacturaVenta = {
  PLACA: 'placa',
  VIN: 'vin',
  NUMERO_FACTURA: 'numeroFactura',
  FECHA_FACTURA: 'fechaFactura',
  VALOR_VEHICULO: 'valorVehiculo',
} as const;

export type CampoFacturaVenta = (typeof CampoFacturaVenta)[keyof typeof CampoFacturaVenta];

export const CAMPO_FACTURA_VENTA_LABEL: Record<CampoFacturaVenta, string> = {
  placa: 'Placa',
  vin: 'VIN',
  numeroFactura: 'Número de factura',
  fechaFactura: 'Fecha de la factura',
  valorVehiculo: 'Valor del vehículo',
};

/** Campos que el OCR extrae de un recibo de impuestos (FEATURE_IMPUESTOS §9.3). */
export const CampoImpuesto = {
  PLACA: 'placa',
  VALOR_TOTAL: 'valorTotal',
  NUMERO_RECIBO: 'numeroRecibo',
  FECHA_PAGO: 'fechaPago',
  ANIO_GRAVABLE: 'anioGravable',
} as const;

export type CampoImpuesto = (typeof CampoImpuesto)[keyof typeof CampoImpuesto];

/**
 * Un valor extraído nunca viaja sin su confianza. RN-04/RN-05: un dato bajo el
 * umbral no se persiste como válido sin confirmación humana; por eso
 * `confirmadoPor` es parte del dato.
 */
export interface CampoExtraido {
  /** Valor crudo tal como lo leyó el OCR. */
  valor: string | null;
  /** 0 a 1. */
  confianza: number;
  /** `confianza >= umbral` aplicable al momento de la extracción. */
  confiable: boolean;
  /** Id del usuario que confirmó el campo en la cola de revisión, si aplica. */
  confirmadoPor?: string | null;
  confirmadoEn?: string | null;
}

export type ExtraccionSoat = Partial<Record<CampoSoat, CampoExtraido>>;
export type ExtraccionImpuesto = Partial<Record<CampoImpuesto, CampoExtraido>>;
export type ExtraccionFacturaVenta = Partial<Record<CampoFacturaVenta, CampoExtraido>>;

export const CAMPO_SOAT_LABEL: Record<CampoSoat, string> = {
  placa: 'Placa',
  vin: 'VIN',
  numeroPoliza: 'Número de póliza',
  fechaExpedicion: 'Fecha de expedición',
  vigenciaDesde: 'Vigencia desde',
  vigenciaHasta: 'Vigencia hasta',
  valorTotal: 'Valor total',
  aseguradora: 'Aseguradora emisora',
};

export const CAMPO_IMPUESTO_LABEL: Record<CampoImpuesto, string> = {
  placa: 'Placa',
  valorTotal: 'Valor total',
  numeroRecibo: 'Número de recibo',
  fechaPago: 'Fecha de pago',
  anioGravable: 'Año gravable',
};

/**
 * Campos SOAT que se extraen y persisten pero NO se exigen para pasar a `Pagado`
 * (DECISIONES.md §2.1, decisión D-7 de la migración). Cada pago registra en su
 * bitácora, bajo `noExigidosSinLeer`, cuáles de estos pasaron sin ser confiables.
 */
export const CAMPOS_SOAT_EXTRAIDOS_SIN_EXIGIR: readonly CampoSoat[] = [
  'fechaExpedicion', 'vigenciaDesde', 'vigenciaHasta',
];

/**
 * Motivo por el que un documento cayó en la cola de revisión (CA-06 SOAT,
 * CA-07 Impuestos).
 */
export const MotivoRevision = {
  CONFIANZA_INSUFICIENTE: 'confianza_insuficiente',
  SIN_LLAVE_DE_CRUCE: 'sin_llave_de_cruce',
  LLAVE_NO_CRUZA: 'llave_no_cruza',
  DIFERENCIA_DE_VALOR: 'diferencia_de_valor',
  /** La factura de venta cruza con más de un trámite del mismo vehículo. */
  CRUCE_AMBIGUO: 'cruce_ambiguo',
} as const;

export type MotivoRevision = (typeof MotivoRevision)[keyof typeof MotivoRevision];

export const MOTIVO_REVISION_LABEL: Record<MotivoRevision, string> = {
  confianza_insuficiente: 'Confianza del OCR bajo el umbral',
  sin_llave_de_cruce: 'El OCR no encontró placa ni VIN',
  llave_no_cruza: 'La placa o VIN no corresponde a ningún registro',
  diferencia_de_valor: 'El valor pagado difiere del liquidado',
  cruce_ambiguo: 'El documento cruza con más de un trámite del mismo vehículo',
};

/** Flujo al que pertenece una revisión OCR. */
export const FlujoRevision = {
  SOAT: 'soat',
  IMPUESTOS: 'impuestos',
  FACTURA_VENTA: 'factura_venta',
} as const;

export type FlujoRevision = (typeof FlujoRevision)[keyof typeof FlujoRevision];
