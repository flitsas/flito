// Comprobantes universales (Épica #12245, Feature #12605, ADR-0018) — parte de EXTRACCIÓN.
//
// Esta HU (#12610) trae solo lo que la lectura necesita: el catálogo cerrado de tipos de documento,
// los diez campos que el prompt universal devuelve y la forma del sub-documento que sale de partir
// un consolidado. Estados, motivos de pendiente, DTOs y errores del módulo llegan con la HU del
// modelo y las rutas, que es donde se usan.

import type { CampoExtraido } from './flito-ocr.js';

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
