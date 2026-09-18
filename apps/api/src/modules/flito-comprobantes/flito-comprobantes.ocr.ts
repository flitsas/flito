// FLITO Comprobantes — lectura de cualquier documento y partición de consolidados (HU #12610,
// Feature #12605, Épica #12245, ADR-0018 §2-3).
//
// Tres etapas, y este archivo une las tres:
//   (a) **Partición** (`particionar`): un archivo entra y salen N sub-documentos. Una imagen o un PDF
//       de una página ES el documento (no se toca ni se reserializa: el dedup por hash depende de
//       ello). Un PDF de 2..100 páginas se delimita con una pasada barata del modelo
//       (`PROMPT_PARTICION_CONSOLIDADO`); si la respuesta no sirve —no parsea, páginas fuera de
//       rango, solapes— o el OCR está caído, se cae a UNA PÁGINA = UN DOCUMENTO (`separarPaginas`,
//       el patrón de derechos). De 101 a 150 páginas ni se intenta el modelo; más de 150 es
//       `PdfDemasiadoGrandeError` y el archivo entero va a `fallidos`.
//   (b) **Universal** (`extraerComprobanteUniversal`, en flito-ocr.service.ts): qué es, si es un
//       pago, de qué concepto, llaves y valor.
//   (c) **Especializada** (`leerSubDocumento`): si la universal dice con confianza que es un SOAT, un
//       recibo de impuesto, un recibo de caja o un derecho, se relee con el extractor de siempre y se
//       conserva su forma nativa (`extraccionDestino`, la que `marcarPagado`/`conciliar`/
//       `registrarDesdeRevision` ya saben persistir). La universal se corrige campo a campo SOLO
//       cuando la especializada trae MAYOR confianza: la etapa (c) afina, no pisa.
//
// Qué NO hace: persistir, cruzar con trámites ni decidir motivos de pendiente. Eso es de las HUs de
// carga y cruce. Y NUNCA escribe en el log el contenido leído: solo cuentas y banderas (Habeas Data).

import {
  CampoComprobante, CampoDerechoTramite, CampoImpuesto, CampoSoat, TipoDocumentoComprobante,
  type CampoExtraido, type ExtraccionComprobante, type ExtraccionDerechoTramite, type ExtraccionImpuesto,
  type ExtraccionSoat, type SubDocumento,
} from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import {
  MAX_PAGINAS, PdfDemasiadoGrandeError, nombrePagina, recortarPaginas, separarPaginas,
} from '../../shared/pdf/separar-paginas.js';
import {
  extraerComprobanteUniversal, extraerDerechoTramite, extraerFacturaSoat, extraerReciboCaja,
  extraerReciboImpuesto, particionConsolidado, type DocumentoAAnalizar,
} from '../flito-ocr/flito-ocr.service.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';

const log = loggerFor('flito-comprobantes-ocr');

/**
 * Hasta cuántas páginas se le pide al modelo que delimite. Por encima, una página por documento sin
 * preguntar: un PDF de 120 páginas es casi seguro un lote de recibos sueltos, y la pasada de
 * partición costaría más que lo que ahorra.
 */
export const MAX_PAGINAS_PARTICION_MODELO = 100;

/** Un archivo tal como llega de la carga (multer) o del soporte (S3). */
export interface ArchivoComprobante {
  nombre: string;
  contentType: string;
  buffer: Buffer;
}

/** `SubDocumento` del shared-type con el contenido como `Buffer`, que es lo que el OCR consume. */
export type SubDocumentoApi = SubDocumento<Buffer>;

export type MetodoParticion = 'unico' | 'modelo' | 'por_pagina';

export interface ResultadoParticion {
  documentos: SubDocumentoApi[];
  /**
   * Páginas del consolidado que el modelo dejó fuera de todo documento (portadas, resúmenes, hojas
   * en blanco). Se devuelven para que la carga se lo diga a la persona («la p. 7 no se leyó»); con
   * `unico` o `por_pagina` siempre está vacío porque no se descarta nada.
   */
  paginasNoLeidas: number[];
  metodo: MetodoParticion;
}

// ─────────────────────────── (a) Partición ───────────────────────────────────

const esPdf = (contentType: string) => contentType.toLowerCase().includes('pdf');

/** Nombre del sub-documento derivado del consolidado: «x - pág 3.pdf» o «x - págs 3-5.pdf». */
function nombreSubDocumento(nombreOriginal: string, paginas: number[]): string {
  if (paginas.length === 1) return nombrePagina(nombreOriginal, paginas[0]!);
  const base = nombreOriginal.replace(/\.pdf$/i, '');
  const primera = paginas[0]!;
  const ultima = paginas[paginas.length - 1]!;
  const contiguas = ultima - primera === paginas.length - 1;
  return `${base} - págs ${contiguas ? `${primera}-${ultima}` : paginas.join(',')}.pdf`;
}

/**
 * Valida la respuesta del modelo y la convierte en grupos de páginas ordenados. `null` ante
 * cualquier cosa que no sea una partición usable: sin `documentos`, un grupo vacío, una página que
 * no es entero en 1..total, o una página en dos grupos. Ante `null` se cae a página por documento;
 * NO se «repara» una respuesta a medias, porque un grupo corregido a mano se leería como un
 * documento incompleto sin que nadie lo supiera.
 */
export function gruposDeParticion(parsed: Record<string, unknown> | null, total: number): number[][] | null {
  const docs = parsed?.documentos;
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const vistas = new Set<number>();
  const grupos: number[][] = [];
  for (const d of docs) {
    const paginas = (d as { paginas?: unknown } | null)?.paginas;
    if (!Array.isArray(paginas) || paginas.length === 0) return null;
    const grupo: number[] = [];
    for (const p of paginas) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > total || vistas.has(n)) return null;
      vistas.add(n);
      grupo.push(n);
    }
    grupos.push(grupo.sort((a, b) => a - b));
  }
  return grupos.sort((a, b) => a[0]! - b[0]!);
}

async function porPagina(archivo: ArchivoComprobante): Promise<SubDocumentoApi[]> {
  const paginas = await separarPaginas(archivo.buffer);
  return paginas.map((p) => ({
    buffer: p.buffer, contentType: archivo.contentType, paginas: [p.numero], nombre: nombrePagina(archivo.nombre, p.numero),
  }));
}

/**
 * Pide al modelo la partición y la valida. Devuelve `null` cuando hay que caer a página por
 * documento, y lo hace TAMBIÉN si el OCR está caído: la partición es una optimización, y un
 * consolidado no se queda sin leer porque el modelo no estuvo para delimitarlo (la lectura de cada
 * página fallará después con su propio `OcrNoDisponibleError`, y ese sí se persiste como pendiente).
 */
async function particionPorModelo(archivo: ArchivoComprobante, total: number): Promise<number[][] | null> {
  try {
    const parsed = await particionConsolidado({ nombreArchivo: archivo.nombre, contentType: archivo.contentType, contenido: archivo.buffer });
    const grupos = gruposDeParticion(parsed, total);
    if (!grupos) log.warn({ total }, 'Partición del consolidado no usable; se cae a una página por documento');
    return grupos;
  } catch (e) {
    log.warn({ total, err: (e as Error).message }, 'Partición del consolidado falló; se cae a una página por documento');
    return null;
  }
}

/**
 * Parte un archivo en los documentos que contiene. Ver la cabecera del archivo para el reparto por
 * tamaño. Lanza solo `PdfDemasiadoGrandeError` (más de `MAX_PAGINAS`) y lo que pdf-lib lance ante
 * un PDF dañado o cifrado: ambos son «fallido» para la carga, no «pendiente».
 */
export async function particionar(archivo: ArchivoComprobante): Promise<ResultadoParticion> {
  const unico: ResultadoParticion = {
    documentos: [{ buffer: archivo.buffer, contentType: archivo.contentType, paginas: null, nombre: archivo.nombre }],
    paginasNoLeidas: [],
    metodo: 'unico',
  };
  if (!esPdf(archivo.contentType)) return unico;

  const { PDFDocument } = await import('pdf-lib');
  const total = (await PDFDocument.load(archivo.buffer)).getPageCount();
  if (total > MAX_PAGINAS) throw new PdfDemasiadoGrandeError(total);
  if (total <= 1) return unico;

  const grupos = total <= MAX_PAGINAS_PARTICION_MODELO ? await particionPorModelo(archivo, total) : null;
  if (!grupos) {
    const documentos = await porPagina(archivo);
    log.info({ total, documentos: documentos.length, metodo: 'por_pagina' }, 'Consolidado partido');
    return { documentos, paginasNoLeidas: [], metodo: 'por_pagina' };
  }

  const documentos: SubDocumentoApi[] = [];
  for (const paginas of grupos) {
    documentos.push({
      buffer: await recortarPaginas(archivo.buffer, paginas),
      contentType: archivo.contentType,
      paginas,
      nombre: nombreSubDocumento(archivo.nombre, paginas),
    });
  }
  const cubiertas = new Set(grupos.flat());
  const paginasNoLeidas = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !cubiertas.has(p));
  log.info({ total, documentos: documentos.length, noLeidas: paginasNoLeidas.length, metodo: 'modelo' }, 'Consolidado partido');
  return { documentos, paginasNoLeidas, metodo: 'modelo' };
}

// ─────────────────────────── (b) + (c) Lectura ───────────────────────────────

/** Los cuatro tipos con extractor propio; el resto se queda con la lectura universal. */
export type TipoConExtractor =
  | typeof TipoDocumentoComprobante.FACTURA_SOAT
  | typeof TipoDocumentoComprobante.RECIBO_IMPUESTO
  | typeof TipoDocumentoComprobante.RECIBO_CAJA_IMPUESTO
  | typeof TipoDocumentoComprobante.RECIBO_DERECHO;

export type ExtraccionDestino = ExtraccionSoat | ExtraccionImpuesto | ExtraccionDerechoTramite;

export interface LecturaSubDocumento {
  /** Los diez campos del catálogo, ya afinados con la especializada cuando la hubo. */
  extraccion: ExtraccionComprobante;
  /** Qué extractor corrió, o `null` si el tipo no es de los cuatro o no fue confiable. */
  tipoDestino: TipoConExtractor | null;
  /** La lectura nativa del destino (la forma que sus dueños persisten), o `null`. */
  extraccionDestino: ExtraccionDestino | null;
}

type Extractor = (doc: DocumentoAAnalizar) => Promise<ExtraccionDestino>;

/**
 * Extractor y correspondencia de campos por tipo. La correspondencia dice qué campo NATIVO del
 * destino responde a cada campo universal; los que no aparecen (p. ej. `vin` en un recibo de caja)
 * no se tocan. La fecha del SOAT es la de expedición: es la que el documento trae y la que el
 * destino guarda.
 */
const ESPECIALIZADOS: Record<TipoConExtractor, { extraer: Extractor; campos: Partial<Record<CampoComprobante, string>> }> = {
  factura_soat: {
    extraer: extraerFacturaSoat,
    campos: {
      [CampoComprobante.PLACA]: CampoSoat.PLACA, [CampoComprobante.VIN]: CampoSoat.VIN,
      [CampoComprobante.VALOR_TOTAL]: CampoSoat.VALOR_TOTAL, [CampoComprobante.FECHA_PAGO]: CampoSoat.FECHA_EXPEDICION,
      [CampoComprobante.NUMERO_DOCUMENTO]: CampoSoat.NUMERO_POLIZA,
    },
  },
  recibo_impuesto: {
    extraer: extraerReciboImpuesto,
    campos: {
      [CampoComprobante.PLACA]: CampoImpuesto.PLACA, [CampoComprobante.VALOR_TOTAL]: CampoImpuesto.VALOR_TOTAL,
      [CampoComprobante.FECHA_PAGO]: CampoImpuesto.FECHA_PAGO, [CampoComprobante.NUMERO_DOCUMENTO]: CampoImpuesto.NUMERO_RECIBO,
    },
  },
  recibo_caja_impuesto: {
    extraer: extraerReciboCaja,
    campos: {
      [CampoComprobante.VALOR_TOTAL]: CampoImpuesto.VALOR_TOTAL, [CampoComprobante.FECHA_PAGO]: CampoImpuesto.FECHA_PAGO,
      [CampoComprobante.NUMERO_DOCUMENTO]: CampoImpuesto.NUMERO_RECIBO,
    },
  },
  recibo_derecho: {
    extraer: (doc) => extraerDerechoTramite(doc),
    campos: {
      [CampoComprobante.PLACA]: CampoDerechoTramite.PLACA, [CampoComprobante.VALOR_TOTAL]: CampoDerechoTramite.VALOR_TOTAL,
      [CampoComprobante.FECHA_PAGO]: CampoDerechoTramite.FECHA_PAGO, [CampoComprobante.NUMERO_DOCUMENTO]: CampoDerechoTramite.NUMERO_RADICADO,
    },
  },
};

function tipoConExtractor(campo: CampoExtraido | undefined): TipoConExtractor | null {
  if (!campo?.confiable || campo.valor === null) return null;
  return Object.prototype.hasOwnProperty.call(ESPECIALIZADOS, campo.valor) ? (campo.valor as TipoConExtractor) : null;
}

/**
 * Fusión hacia la universal: por cada campo con correspondencia, el destino SUSTITUYE solo si trae
 * MAYOR confianza (estricta). En empate se queda la universal, que ya pasó por su propia escalación;
 * un destino sin el campo (`undefined` o `valor: null`, confianza 0) nunca borra un valor leído.
 */
export function fusionarConDestino(
  universal: ExtraccionComprobante,
  destino: ExtraccionDestino,
  campos: Partial<Record<CampoComprobante, string>>,
): ExtraccionComprobante {
  const salida: ExtraccionComprobante = { ...universal };
  for (const [campoUniversal, campoDestino] of Object.entries(campos) as Array<[CampoComprobante, string]>) {
    const d = (destino as Record<string, CampoExtraido | undefined>)[campoDestino];
    const u = salida[campoUniversal];
    if (d && d.confianza > (u?.confianza ?? 0)) salida[campoUniversal] = { ...d };
  }
  return salida;
}

/**
 * Lee UN sub-documento: universal siempre; especializada solo si el tipo salió confiable y tiene
 * extractor. `umbral` marca `confiable`; por defecto el global (`umbralPara(null)`), porque al leer
 * todavía no se sabe de qué organismo es el documento — quien cruce lo re-marca.
 *
 * Lanza `OcrNoDisponibleError` cuando el OCR está caído (sin API key, 429, 503): la carga lo
 * persiste como pendiente `ocr_no_disponible` y «Releer» vuelve a entrar por aquí.
 */
export async function leerSubDocumento(sub: SubDocumentoApi, umbral: number = umbralPara(null)): Promise<LecturaSubDocumento> {
  const doc: DocumentoAAnalizar = { nombreArchivo: sub.nombre, contentType: sub.contentType, contenido: sub.buffer, umbral };
  const universal = await extraerComprobanteUniversal(doc);

  const tipoDestino = tipoConExtractor(universal[CampoComprobante.TIPO_DOCUMENTO]);
  if (!tipoDestino) {
    log.info({ especializada: false, paginas: sub.paginas?.length ?? null }, 'Comprobante leído');
    return { extraccion: universal, tipoDestino: null, extraccionDestino: null };
  }

  const { extraer, campos } = ESPECIALIZADOS[tipoDestino];
  const extraccionDestino = await extraer(doc);
  log.info({ especializada: true, paginas: sub.paginas?.length ?? null }, 'Comprobante leído');
  return { extraccion: fusionarConDestino(universal, extraccionDestino, campos), tipoDestino, extraccionDestino };
}
