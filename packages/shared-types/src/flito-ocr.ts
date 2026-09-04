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
 *
 * ── Los NUEVE campos del COMPRADOR (HU #12092, Feature #12073) ──────────────────────────────────
 *
 * La factura de venta la emite el concesionario y en ella figura QUIÉN compra: es la única fuente
 * documental del titular que el canal Cliente tiene a mano cuando radica. Leerlos evita reteclear
 * nueve campos, y son exactamente los que `flito_compradores` persiste — menos el correo, que una
 * factura no trae y que por eso NO se pide (inventarlo sería el error que la regla de oro del prompt
 * prohíbe).
 *
 * `nombres`/`apellidos` y `razonSocial` son EXCLUYENTES (AC2): espejan `refinarTitular` del canal y
 * el CHECK `flito_compradores_titular_chk`. El modelo devuelve un juego u otro, nunca los dos.
 */
export const CampoFacturaVenta = {
  PLACA: 'placa',
  VIN: 'vin',
  NUMERO_FACTURA: 'numeroFactura',
  FECHA_FACTURA: 'fechaFactura',
  VALOR_VEHICULO: 'valorVehiculo',
  // Comprador / adquiriente — NO el emisor de la factura.
  NOMBRES: 'nombres',
  APELLIDOS: 'apellidos',
  RAZON_SOCIAL: 'razonSocial',
  TIPO_DOCUMENTO: 'tipoDocumento',
  NUMERO_DOCUMENTO: 'numeroDocumento',
  DIRECCION: 'direccion',
  MUNICIPIO: 'municipio',
  DEPARTAMENTO: 'departamento',
  CELULAR: 'celular',
} as const;

export type CampoFacturaVenta = (typeof CampoFacturaVenta)[keyof typeof CampoFacturaVenta];

/**
 * `Record` EXHAUSTIVO a propósito: es lo que hace que ampliar el enum sin ampliar las etiquetas deje
 * el build de shared-types en rojo (AC4 de la HU #12092, «el typecheck obliga a actualizar a los
 * consumidores existentes»).
 */
export const CAMPO_FACTURA_VENTA_LABEL: Record<CampoFacturaVenta, string> = {
  placa: 'Placa',
  vin: 'VIN',
  numeroFactura: 'Número de factura',
  fechaFactura: 'Fecha de la factura',
  valorVehiculo: 'Valor del vehículo',
  nombres: 'Nombres del comprador',
  apellidos: 'Apellidos del comprador',
  razonSocial: 'Razón social del comprador',
  tipoDocumento: 'Tipo de documento del comprador',
  numeroDocumento: 'Número de documento del comprador',
  direccion: 'Dirección del comprador',
  municipio: 'Municipio del comprador',
  departamento: 'Departamento del comprador',
  celular: 'Celular del comprador',
};

/**
 * Los nueve campos PERSONALES del comprador, en un solo sitio.
 *
 * Existe para que el backend (prompt, normalizadores, registro de acceso a datos personales) y el
 * formulario del canal no repitan la lista a mano: nueve claves copiadas en cuatro archivos son
 * cuatro sitios donde falta una el día que se añada la décima.
 */
export const CAMPOS_COMPRADOR_FACTURA: readonly CampoFacturaVenta[] = [
  CampoFacturaVenta.NOMBRES,
  CampoFacturaVenta.APELLIDOS,
  CampoFacturaVenta.RAZON_SOCIAL,
  CampoFacturaVenta.TIPO_DOCUMENTO,
  CampoFacturaVenta.NUMERO_DOCUMENTO,
  CampoFacturaVenta.DIRECCION,
  CampoFacturaVenta.MUNICIPIO,
  CampoFacturaVenta.DEPARTAMENTO,
  CampoFacturaVenta.CELULAR,
];

/**
 * Los campos que la COLA DE REVISIÓN de Operaciones pide para una factura de venta: los cinco
 * DOCUMENTALES de siempre, y ni uno más.
 *
 * ── Por qué esta lista existe y no basta con `Object.values(CampoFacturaVenta)` ─────────────────
 *
 * `camposEsperados()` (`flito-revisiones.service.ts`) construía la lista del formulario de revisión
 * con `Object.values` del enum. Al ampliar el enum con los nueve campos del comprador —que esa cola
 * NO extrae, NO persiste y NO tiene por qué mostrar—, esa pantalla se habría convertido, **en
 * silencio y con el build verde**, en un formulario donde un admin teclea a mano el nombre, la
 * cédula, la dirección y el celular de una persona sobre una fila que ni siquiera es del canal.
 *
 * La cola de revisión resuelve el CRUCE de un documento con un trámite (placa, VIN, número, fecha y
 * valor). El titular no entra ahí: entra en el formulario del canal Cliente, que es quien lo pide y
 * quien lo persiste. Por eso la lista se fija aquí, junto al enum que la podría desbordar.
 */
export const CAMPOS_REVISION_FACTURA_VENTA: readonly CampoFacturaVenta[] = [
  CampoFacturaVenta.PLACA,
  CampoFacturaVenta.VIN,
  CampoFacturaVenta.NUMERO_FACTURA,
  CampoFacturaVenta.FECHA_FACTURA,
  CampoFacturaVenta.VALOR_VEHICULO,
];

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
 * Campos que el OCR extrae de un recibo / cuenta de cobro de DERECHO DE TRÁMITE (HU #10950).
 *
 * `organismo` y `tipoTramite` no son datos que se persistan como valor del trámite: se leen para
 * CONTRASTAR (el organismo, contra el esperado; el tipo, para desempatar cuando una placa tiene
 * varios trámites candidatos). Por eso se extraen aunque no bloqueen — ver CAMPOS_REQUERIDOS.
 */
export const CampoDerechoTramite = {
  PLACA: 'placa',
  VALOR_TOTAL: 'valorTotal',
  FECHA_PAGO: 'fechaPago',
  NUMERO_RADICADO: 'numeroRadicado',
  ORGANISMO: 'organismo',
  TIPO_TRAMITE: 'tipoTramite',
} as const;

export type CampoDerechoTramite = (typeof CampoDerechoTramite)[keyof typeof CampoDerechoTramite];

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
export type ExtraccionDerechoTramite = Partial<Record<CampoDerechoTramite, CampoExtraido>>;

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

export const CAMPO_DERECHO_TRAMITE_LABEL: Record<CampoDerechoTramite, string> = {
  placa: 'Placa',
  valorTotal: 'Valor total a pagar',
  fechaPago: 'Fecha de pago',
  numeroRadicado: 'Radicado del trámite',
  organismo: 'Organismo emisor',
  tipoTramite: 'Tipo de trámite (concepto)',
};

/**
 * Lo único que bloquea el registro de un derecho de tránsito. La placa se valida aparte (es la
 * llave de cruce). Radicado, organismo y tipo se extraen pero NO se exigen: varían de formato
 * entre organismos y su ausencia no impide saber cuánto se pagó.
 */
export const CAMPOS_REQUERIDOS_DERECHO: readonly CampoDerechoTramite[] = ['valorTotal'];

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
  DERECHOS: 'derechos',
} as const;

export type FlujoRevision = (typeof FlujoRevision)[keyof typeof FlujoRevision];
