// FLITO — archivo del PDF y el XML de la factura electrónica (HU #11335, Feature #11243).
//
// Módulo PURO (sin zod ni side-effects): lo consumen la API, la web y los tests.
//
// Por qué existe: el enlace público que devuelve Siigo (`public_url`) no es un archivo nuestro. Si
// mañana Siigo deja de servirlo —contrato terminado, documento migrado, empresa cambiada— la
// prueba del documento se va con él. Lo que queda ante una glosa o una auditoría de la DIAN es lo
// que esté guardado en el almacenamiento de FLITO, así que el PDF y el XML se descargan y se
// archivan como un soporte más del trámite.

import { TipoSoporte } from './flito-estados.js';

/**
 * Los dos documentos que Siigo sirve de una factura, por su sufijo de endpoint
 * (`GET /v1/invoices/{id}/pdf` y `/xml`).
 *
 * Son DOS y no uno: el PDF es lo que se le enseña a una persona y el XML es el documento con
 * validez ante la DIAN. Archivar solo uno deja la mitad de la prueba.
 */
export const SIIGO_DOCUMENTOS_FACTURA = ['pdf', 'xml'] as const;
export type SiigoDocumentoFactura = (typeof SIIGO_DOCUMENTOS_FACTURA)[number];

/** Tipo con el que cada documento se guarda en `flito_soportes.tipo`. */
export const TIPO_SOPORTE_FACTURA: Record<SiigoDocumentoFactura, string> = {
  pdf: TipoSoporte.FACTURA_ELECTRONICA_PDF,
  xml: TipoSoporte.FACTURA_ELECTRONICA_XML,
};

/** Los dos tipos, para filtrar los soportes de facturación sin repetir literales. */
export const TIPOS_SOPORTE_FACTURA: readonly string[] = [
  TipoSoporte.FACTURA_ELECTRONICA_PDF,
  TipoSoporte.FACTURA_ELECTRONICA_XML,
];

export const SIIGO_DOCUMENTO_FACTURA_LABEL: Record<SiigoDocumentoFactura, string> = {
  pdf: 'Factura electrónica (PDF)',
  xml: 'Factura electrónica (XML)',
};

/**
 * `Content-Type` con el que se guarda cada documento.
 *
 * `application/xml` y no `text/xml`: lo que devuelve la DIAN es un documento firmado, no texto
 * para leer en el navegador, y `text/*` invita a que un visor lo interprete y lo reescriba.
 */
export const SIIGO_DOCUMENTO_FACTURA_CONTENT_TYPE: Record<SiigoDocumentoFactura, string> = {
  pdf: 'application/pdf',
  xml: 'application/xml',
};

/**
 * Firma que tiene que traer el contenido descargado para dejarse archivar.
 *
 * No es paranoia: Siigo puede responder 200 con un cuerpo que no es el documento —una página de
 * error, un JSON de aviso, una cadena vacía—, y guardarlo produciría un soporte que dice ser la
 * factura y no lo es. Un soporte mentiroso es peor que no tener soporte: el que falta se busca, y
 * el que miente se descubre el día de la glosa.
 */
export const SIIGO_DOCUMENTO_FACTURA_FIRMA: Record<SiigoDocumentoFactura, string> = {
  pdf: '%PDF',
  xml: '<',
};

/** Qué pasó con UN documento en un ciclo de archivo. */
export const SIIGO_ARCHIVO_DOCUMENTO_DESENLACES = [
  /** Se descargó de Siigo y se guardó ahora. */
  'archivado',
  /** Ya estaba: no se descargó nada y no se creó un soporte nuevo (AC3). */
  'ya_archivado',
  /** No se intentó, porque la factura todavía no está aceptada por la DIAN (AC2). */
  'omitido',
  /** Se intentó y falló. La factura queda incompleta y el siguiente ciclo lo retoma (AC5). */
  'fallido',
] as const;
export type SiigoArchivoDocumentoDesenlace = (typeof SIIGO_ARCHIVO_DOCUMENTO_DESENLACES)[number];

/**
 * Estado del archivo de una factura entera.
 *
 * `completa` exige los DOS documentos. No hay un estado intermedio que se parezca a «archivada»:
 * el AC5 pide justo que un fallo a mitad no se registre como terminado, y para eso el vocabulario
 * tiene que distinguirlo de forma que no se pueda confundir al leerlo.
 */
export const SIIGO_ARCHIVO_ESTADOS = [
  'completa',
  /** Falta al menos un documento por un fallo. Se reintenta solo en el siguiente ciclo. */
  'parcial',
  /** La DIAN todavía no la aceptó: no se descarga nada (AC2). */
  'pendiente_dian',
] as const;
export type SiigoArchivoEstado = (typeof SIIGO_ARCHIVO_ESTADOS)[number];

export const SIIGO_ARCHIVO_ESTADO_ETIQUETA: Record<SiigoArchivoEstado, string> = {
  completa: 'Archivada',
  parcial: 'Archivo incompleto',
  pendiente_dian: 'Pendiente de la DIAN',
};

/** Lo que se sabe de un documento tras el ciclo. */
export interface SiigoArchivoDocumento {
  documento: SiigoDocumentoFactura;
  desenlace: SiigoArchivoDocumentoDesenlace;
  /** Id del soporte creado o encontrado. `null` cuando no hay ninguno todavía. */
  soporteId: string | null;
  /** Motivo del fallo en lenguaje operativo. `null` si no falló. */
  motivo: string | null;
}

/** Resultado de archivar una factura. Lo devuelve tanto el ciclo automático como el manual. */
export interface SiigoArchivoResumen {
  facturaId: string;
  estado: SiigoArchivoEstado;
  documentos: SiigoArchivoDocumento[];
  /**
   * La compañía no tenía carpeta parametrizada y los documentos fueron a la de excepción (AC4).
   * Se informa en vez de dejarlo solo en la ruta del objeto: un archivo en un sitio que nadie
   * configuró es un archivo que nadie va a encontrar.
   */
  carpetaDeExcepcion: boolean;
}
