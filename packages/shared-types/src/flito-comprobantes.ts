// Comprobantes universales (Épica #12245, Feature #12605, ADR-0018) — parte de EXTRACCIÓN.
//
// La HU #12610 trajo lo que la lectura necesita: el catálogo cerrado de tipos de documento, los diez
// campos que el prompt universal devuelve y la forma del sub-documento que sale de partir un
// consolidado. La HU #12611 (modelo, página y carga en lotes) añade estados, motivos de pendiente,
// DTOs y errores del módulo, que es donde se usan.

import { MotivoRevision, MOTIVO_REVISION_LABEL, type CampoExtraido } from './flito-ocr.js';
import type { ConceptoCosto } from './flito-conceptos.js';

/**
 * Qué documento es. Catálogo CERRADO: el normalizador del OCR devuelve `null` ante cualquier literal
 * que no esté aquí («null antes que adivinar», regla de oro de flito-ocr.prompts.ts).
 */
export const TipoDocumentoComprobante = {
  FACTURA_SOAT: 'factura_soat',
  RECIBO_IMPUESTO: 'recibo_impuesto',
  RECIBO_CAJA_IMPUESTO: 'recibo_caja_impuesto',
  RECIBO_DERECHO: 'recibo_derecho',
  FACTURA_SERVICIO: 'factura_servicio',
  COMPROBANTE_TRANSFERENCIA: 'comprobante_transferencia',
  CUENTA_COBRO: 'cuenta_cobro',
  OTRO_PAGO: 'otro_pago',
  DOCUMENTO_NO_PAGO: 'documento_no_pago',
} as const;

export type TipoDocumentoComprobante = (typeof TipoDocumentoComprobante)[keyof typeof TipoDocumentoComprobante];

export const TIPOS_DOCUMENTO_COMPROBANTE: readonly TipoDocumentoComprobante[] = Object.values(TipoDocumentoComprobante);

/** Copy de la ficha UX §5.2. `Record` exhaustivo: ampliar el enum sin label deja el build en rojo. */
export const TIPO_DOCUMENTO_COMPROBANTE_LABEL: Record<TipoDocumentoComprobante, string> = {
  factura_soat: 'Factura SOAT',
  recibo_impuesto: 'Recibo de impuesto',
  recibo_caja_impuesto: 'Recibo de caja',
  recibo_derecho: 'Recibo de derecho',
  factura_servicio: 'Factura de servicio',
  comprobante_transferencia: 'Transferencia',
  cuenta_cobro: 'Cuenta de cobro',
  otro_pago: 'Otro pago',
  documento_no_pago: 'No es un pago',
};

/**
 * Los diez campos de la lectura universal. Sin datos de personas (Habeas Data, ADR-0008): el prompt
 * no los pide y el extractor descarta cualquier clave que no esté en esta lista.
 */
export const CampoComprobante = {
  TIPO_DOCUMENTO: 'tipoDocumento',
  ES_COMPROBANTE_PAGO: 'esComprobantePago',
  CONCEPTO: 'concepto',
  PLACA: 'placa',
  VIN: 'vin',
  ID_FLIT: 'idFlit',
  VALOR_TOTAL: 'valorTotal',
  FECHA_PAGO: 'fechaPago',
  NUMERO_DOCUMENTO: 'numeroDocumento',
  EMISOR: 'emisor',
} as const;

export type CampoComprobante = (typeof CampoComprobante)[keyof typeof CampoComprobante];

export const CAMPOS_COMPROBANTE: readonly CampoComprobante[] = Object.values(CampoComprobante);

export type ExtraccionComprobante = Partial<Record<CampoComprobante, CampoExtraido>>;

/**
 * Un documento listo para leer, salido de partir un archivo. `paginas` son las del consolidado
 * original (base 1, como las ve un lector de PDF) que forman este documento; `null` cuando el
 * archivo entero ES el documento (imagen o PDF de una página) y no se recortó nada.
 *
 * El contenido es genérico porque este tipo lo comparten el API (donde es un `Buffer`) y el
 * navegador (donde no existe `Buffer`).
 */
export interface SubDocumento<B = Uint8Array> {
  buffer: B;
  contentType: string;
  paginas: number[] | null;
  nombre: string;
}

// ─── HU #12611 — estados, motivos, DTOs y errores del módulo ───────────────────────────────────────

/** Ciclo de vida de un comprobante. En F1 (#12605) todo queda en `pendiente`: nadie cruza ni aplica. */
export const EstadoComprobante = {
  PENDIENTE: 'pendiente',
  APLICADO: 'aplicado',
  DESCARTADO: 'descartado',
} as const;

export type EstadoComprobante = (typeof EstadoComprobante)[keyof typeof EstadoComprobante];

export const ESTADOS_COMPROBANTE: readonly EstadoComprobante[] = Object.values(EstadoComprobante);

/** Cómo se llegó al trámite. NULL mientras nadie lo haya asociado (F2). */
export const CruceComprobante = {
  ID_FLIT: 'id_flit',
  VIN: 'vin',
  PLACA: 'placa',
  MANUAL: 'manual',
} as const;

export type CruceComprobante = (typeof CruceComprobante)[keyof typeof CruceComprobante];

/**
 * Por qué un comprobante está pendiente. Hereda los cinco motivos de la cola de revisión OCR y añade
 * los que solo existen en la puerta universal. `leido` es el «no pasa nada»: la lectura fue completa
 * y solo falta que alguien (o F2) lo asocie; existe porque `flito_comprobantes_pendiente_chk` exige
 * un motivo en todo pendiente, y «sin motivo» sería mentir con NULL.
 */
export const MotivoPendienteComprobante = {
  ...MotivoRevision,
  TIPO_NO_IDENTIFICADO: 'tipo_no_identificado',
  CONCEPTO_DESCONOCIDO: 'concepto_desconocido',
  OCR_NO_DISPONIBLE: 'ocr_no_disponible',
  DESTINO_NO_ADMITE: 'destino_no_admite',
  LEIDO: 'leido',
} as const;

export type MotivoPendienteComprobante = (typeof MotivoPendienteComprobante)[keyof typeof MotivoPendienteComprobante];

export const MOTIVOS_PENDIENTE_COMPROBANTE: readonly MotivoPendienteComprobante[] = Object.values(MotivoPendienteComprobante);

/** Los cinco heredados reutilizan `MOTIVO_REVISION_LABEL` tal cual; los nuevos, el copy de la ficha UX §5.3. */
export const MOTIVO_PENDIENTE_COMPROBANTE_LABEL: Record<MotivoPendienteComprobante, string> = {
  ...MOTIVO_REVISION_LABEL,
  tipo_no_identificado: 'Tipo de documento sin identificar',
  concepto_desconocido: 'Concepto sin identificar',
  ocr_no_disponible: 'Sin lectura (OCR no disponible)',
  destino_no_admite: 'El trámite no admite este concepto',
  leido: 'Leído, pendiente de asociar',
};

/** Copy de los diez campos universales para el detalle. `Record` exhaustivo: ampliar el enum sin label deja el build en rojo. */
export const CAMPO_COMPROBANTE_LABEL: Record<CampoComprobante, string> = {
  tipoDocumento: 'Tipo de documento',
  esComprobantePago: 'Acredita un pago',
  concepto: 'Concepto',
  placa: 'Placa',
  vin: 'VIN',
  idFlit: 'ID FLIT',
  valorTotal: 'Valor total',
  fechaPago: 'Fecha',
  numeroDocumento: 'Número de documento',
  emisor: 'Emisor',
};

/**
 * Nivel de confianza de un campo, calculado en el SERVIDOR (donde vive `umbralPara`); el front lo
 * pinta y no deriva nada. `null` cuando la confianza es 0 (el OCR no leyó el campo).
 */
export type NivelConfianza = 'alta' | 'media' | 'baja' | null;

/** Códigos de error del módulo. La pantalla decide por `codigo`, no por el texto (calco de `CodigoErrorReciboCaja`). */
export const CodigoErrorComprobante = {
  /** 400: más archivos que el tope, uno por encima del peso, o ninguno. */
  ARCHIVO_INVALIDO: 'archivo_invalido',
  /** 400: Zod (loteId que no es uuid, filtros fuera de catálogo). */
  DATOS_INVALIDOS: 'datos_invalidos',
  /** 400: es_pago y sin valor confirmado (F2). */
  VALOR_REQUERIDO: 'valor_requerido',
  /** 404. */
  NO_ENCONTRADO: 'no_encontrado',
  /** 409: el comprobante no está pendiente. */
  YA_RESUELTO: 'ya_resuelto',
  /** 409 (F2): el destino ya está pagado; `puedeAdjuntar: true`. */
  YA_PAGADO: 'ya_pagado',
  /** 409 (F2). */
  TRAMITE_LIQUIDADO: 'tramite_liquidado',
  /** 409 (F2): SOAT/impuesto fuera de `solicitado`, trámite no aprobado (derecho), concepto no gestionado. */
  DESTINO_NO_ADMITE: 'destino_no_admite',
  /** 409 (F2): otro comprobante aplicado del mismo (trámite, concepto); descartar primero. */
  VALOR_YA_DOCUMENTADO: 'valor_ya_documentado',
  /** 409 (F3): aceptar diferencia sobre un comprobante sin marca. */
  SIN_DIFERENCIA: 'sin_diferencia',
  /** 409: releer sobre un pendiente cuyo motivo no es `ocr_no_disponible`. */
  SIN_RELECTURA: 'sin_relectura',
  /** 503: el OCR sigue caído al releer; la fila no cambia. */
  OCR_NO_DISPONIBLE: 'ocr_no_disponible',
} as const;

export type CodigoErrorComprobante = (typeof CodigoErrorComprobante)[keyof typeof CodigoErrorComprobante];

/** Cuerpo de todo error del módulo: `{ error, codigo }` y, según el código, los campos extra. */
export interface ErrorComprobanteDto {
  error: string;
  codigo: CodigoErrorComprobante;
  /** Texto legible para la persona («Ese SOAT ya está pagado», «Liquidación sellada»). */
  detalle?: string;
  /** `ya_pagado` y `destino_no_admite`: true cuando la misma petición con `esPago: false` sería aceptada. */
  puedeAdjuntar?: boolean;
  /** `valor_ya_documentado`: el comprobante aplicado que ocupa (trámite, concepto). */
  comprobanteAnteriorId?: string;
}

/** Un archivo (o sub-documento) del resultado de una carga. */
export interface ItemCargaComprobante {
  archivo: string;
  /** El comprobante creado; en `duplicados`, el del ORIGINAL o null si el original entró por otra puerta sin comprobante. */
  comprobanteId: string | null;
  paginas: number[] | null;
  tipoDocumento: TipoDocumentoComprobante | null;
  concepto: ConceptoCosto | null;
  idFlit: string | null;
  placa: string | null;
  motivo: MotivoPendienteComprobante | null;
  /**
   * Copy FIJADO por la ficha UX §6.2 como contrato; lo escribe el servidor y el front lo pinta tal cual:
   *  · pendiente:  `{MOTIVO_PENDIENTE_COMPROBANTE_LABEL[motivo]}` y, si hay detalle, `: {detalle}`
   *  · duplicado:  `Ya cargado el {fecha}` (con `comprobanteId` del original) o
   *                `Ya cargado el {fecha} en {SOAT | Impuestos | Derechos}` (sin comprobante, sin placa)
   *  · fallido:    `No es PDF ni imagen admitida` | `PDF de más de 150 páginas: pártelo` |
   *                `El archivo está dañado o cifrado` | `Pesa más de 15 MB`
   *  · aplicado (F2): `{Concepto} · {idFlit} · {pesos(valor)}`
   */
  detalle: string;
}

/** Calco de `ResultadoRecibos`: claves-arreglo que `fusionarResultadoCarga` acumula entre tandas. */
export interface ResultadoCargaComprobantes {
  /** Siempre vacío en F1 (#12605): la puerta no aplica. */
  aplicados: ItemCargaComprobante[];
  pendientes: ItemCargaComprobante[];
  duplicados: ItemCargaComprobante[];
  fallidos: ItemCargaComprobante[];
  /** Cuántos documentos se reconocieron en el envío (archivos + sub-documentos de consolidados). */
  documentos: number;
}

/** Fila de la cola. SIN `extraccion` ni `extraccionDestino` (ADR-0008 §1.2): eso solo sale en el detalle, como `campos`. */
export interface ComprobanteListaDto {
  id: string;
  loteId: string;
  estado: EstadoComprobante;
  motivoPendiente: MotivoPendienteComprobante | null;
  detallePendiente: string | null;
  tipoDocumento: TipoDocumentoComprobante | null;
  esPago: boolean | null;
  concepto: ConceptoCosto | null;
  /** F2. Siempre null en F1. */
  tramite: { id: string; idFlit: string; placa: string | null } | null;
  cruce: CruceComprobante | null;
  placaLeida: string | null;
  vinLeido: string | null;
  idFlitLeido: string | null;
  valor: number | null;
  fechaDocumento: string | null;
  numeroDocumento: string | null;
  emisor: string | null;
  marcadoPorDiferencia: boolean;
  diferenciaTarifa: number | null;
  diferenciaAceptada: boolean;
  paginas: number[] | null;
  archivo: { nombre: string; contentType: string };
  createdAt: string;
  aplicadoEn: string | null;
  aplicadoAutomaticamente: boolean;
  descartadoEn: string | null;
  subidoPorNombre: string;
  /** null si está pendiente o fue automático (LEFT JOIN a `users` por id, sin columna nueva). */
  aplicadoPorNombre: string | null;
  descartadoPorNombre: string | null;
}

export interface CampoComprobanteDto {
  campo: string;
  valor: string | null;
  confianza: number;
  confiable: boolean;
  /** Lo calcula el servidor con `nivelDe(confianza, umbral)`. */
  nivel: NivelConfianza;
  confirmadoPor?: string | null;
}

export type AdmisionConcepto = 'admite' | 'ya_pagado' | 'no_gestionado' | 'estado_no_permitido' | 'liquidado' | 'ya_documentado';

/** F2: un trámite que la llave leída alcanza y qué concepto admite. Sin datos de persona. */
export interface CandidatoTramiteDto {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  vin: string | null;
  tipoTramite: string | null;
  empresa: string | null;
  flitEstado: string | null;
  liquidado: boolean;
  admite: Record<ConceptoCosto, AdmisionConcepto>;
}

export interface ComprobanteDetalleDto extends ComprobanteListaDto {
  /** Los diez campos universales y, si hubo extracción del destino, los suyos. `nivel` viene del servidor. */
  campos: CampoComprobanteDto[];
  /** Solo en pendientes (F2, HU #12629): los trámites que alcanzan las llaves leídas, con su `admite`. `[]` en aplicados y descartados. */
  candidatos: CandidatoTramiteDto[];
  /** HU #12634 AC6: motivo escrito al aplicar (cruce manual o campos corregidos); null si fue automático o no se aplicó. */
  aplicadoMotivo: string | null;
  /** HU #12634 AC6: motivo del descarte; null si no está descartado. */
  descartadoMotivo: string | null;
  /** HU #12634 AC6: soporte hijo recortado que vio el destino; habilita «Ver el soporte aplicado» (`GET /:id/archivo?aplicado=1`). null si no hay. */
  soporteAplicadoId: string | null;
  /** F3 (HU #12654): cuándo se aceptó la diferencia (`diferencia_aceptada_en`); null si no se ha aceptado. */
  diferenciaAceptadaEn: string | null;
  /** F3 (HU #12654): motivo con el que se aceptó; null si no se ha aceptado. */
  diferenciaAceptadaMotivo: string | null;
  /** F3 (HU #12654): `username` del usuario interno que aceptó (LEFT JOIN a `users`); null si no se ha aceptado. */
  diferenciaAceptadaPorNombre: string | null;
}

/** Cuerpo de `POST /:id/diferencia/aceptar` (F3, HU #12654): el motivo es obligatorio (5..500). */
export interface AceptarDiferenciaBody {
  motivo: string;
}

/**
 * F2 (HU #12629): el filtro «estado de asociación» de la cola. Vocabulario de PANTALLA que el servidor
 * traduce a columnas (`condicionAsociacion`): `aplicado_automatico`/`aplicado_manual` son pagos
 * aplicados según `aplicado_automaticamente`; `adjuntado` es documentación (`es_pago = false`);
 * `rechazado_pago` es un pendiente cuyo destino no admite el concepto.
 */
export const ASOCIACIONES_COMPROBANTE = ['pendiente', 'aplicado_automatico', 'aplicado_manual', 'adjuntado', 'rechazado_pago', 'descartado'] as const;

export type AsociacionComprobante = (typeof ASOCIACIONES_COMPROBANTE)[number];

/** Cuerpo de `POST /:id/aplicar` (F2). Un solo `tramiteId` (D11). SIN `aceptarDiferencia`: eso vive en F3. */
export interface AplicarComprobanteBody {
  tramiteId: string;
  concepto: ConceptoCosto;
  esPago: boolean;
  /** Campos que la persona escribió/confirmó: claves de `CampoComprobante` y, con prefijo `destino.`, las del extractor especializado. */
  campos?: Record<string, string>;
  /** Obligatorio si hay `campos` o si `tramiteId` no es el candidato sugerido (cruce manual). */
  motivo?: string;
  /**
   * Bug #12913: el tipo de servicio adicional que paga el comprobante (id de
   * `flito_servicios_adicionales_tipos`, activo). Obligatorio si `esPago && concepto === 'servicios_adicionales'`;
   * en cualquier otro caso el API responde 400.
   */
  servicioTipoId?: string;
}

/** Respuesta de `POST /:id/aplicar`. */
export interface ResultadoAplicarComprobanteDto {
  resultado: 'aplicado';
  comprobante: ComprobanteDetalleDto;
}

export interface ListaComprobantesDto {
  items: ComprobanteListaDto[];
  total: number;
  page: number;
  pageSize: number;
}

// ── F3 (Feature #12607, HU #12653): el valor documental en el reporte de costos ──────────────────

/**
 * De dónde sale el valor de un honorario en una fila del reporte de costos (ADR-0018 §5).
 *
 *   'documental' — del comprobante de pago aplicado (trámite digital y logística, tolerancia 0).
 *   'tarifa'     — de la tarifa vigente (o de la puente de servicios, o del sello anterior a F3).
 *   null         — el concepto no aplica (logística autogestionada sin excepción): no hay valor.
 *
 * En una fila sellada se lee del sello (`detalle.<concepto>.origenValor`, HU #12654); en una fila
 * estimada, de si existe el comprobante aplicado. Servicios adicionales NO tiene origen: el catálogo
 * manda siempre y el comprobante solo marca «Difiere del catálogo».
 */
export type OrigenValor = 'documental' | 'tarifa' | null;

/**
 * Lo que el comprobante de pago aplicado dice de UN concepto, contra la tarifa (o el catálogo) que
 * había al aplicarlo. `null` en la fila = no hay comprobante de pago aplicado para ese concepto.
 *
 * Sin PII: `numero` y `fecha` son los del documento; `aceptadaPorNombre` es el `username` del
 * usuario interno que aceptó la diferencia (HU #12654), nunca la extracción.
 */
export interface ValorDocumentalConcepto {
  comprobanteId: string;
  numero: string | null;
  fecha: string | null;
  /** La tarifa (o Σ catálogo) contra la que se comparó al aplicar; `null` si no estaba configurada. */
  tarifaReferencia: number | null;
  /** valor − tarifaReferencia (tolerancia 0). Sin tarifa, el valor entero (marcado). */
  diferencia: number | null;
  /** true = alguien aceptó la diferencia (`diferencia_aceptada_por_id` NOT NULL). */
  aceptada: boolean;
  aceptadaPorNombre: string | null;
  aceptadaEn: string | null;
  aceptadaMotivo: string | null;
}

/**
 * Lo que cada fila del reporte de costos añade sobre sus comprobantes de pago (HU #12653, AC1-AC4,
 * AC6). Se hereda en `FilaReporte` para que el compilador exija rellenarlo.
 */
export interface ValoresDocumentalesDeFila {
  /** Solo los dos honorarios en que el documental manda; servicios adicionales no tiene origen (AC4). */
  origenes: { tramiteDigital: OrigenValor; logistica: OrigenValor };
  valorDocumental: {
    tramiteDigital: ValorDocumentalConcepto | null;
    logistica: ValorDocumentalConcepto | null;
    /** Solo informa la diferencia contra el catálogo: NO entra al valor ni al total. */
    serviciosAdicionales: ValorDocumentalConcepto | null;
  };
}
