// Separación de un PDF consolidado en páginas individuales.
//
// Extraído de modules/drive/procesador.routes.ts (HU #10950), donde vivía embebido en el handler y
// solo servía al flujo de Drive. La carga manual necesita exactamente lo mismo: un PDF que trae N
// recibos, uno por página, hay que partirlo antes de pasarlo al OCR.
//
// Qué NO hace: decidir si una página es un recibo o una portada. Eso lo resuelve el propio prompt
// del OCR (devuelve valores nulos ante un resumen), que es más robusto que cualquier heurística
// sobre el texto y no obliga a mantener reglas por organismo.

import { loggerFor } from '../logger.js';

const log = loggerFor('pdf-separar');

/** Tope de páginas de un consolidado. El de Drive usaba 150; se conserva. */
export const MAX_PAGINAS = 150;

export class PdfDemasiadoGrandeError extends Error {
  constructor(public paginas: number) {
    super(`El PDF tiene ${paginas} páginas y el máximo admitido es ${MAX_PAGINAS}.`);
  }
}

export interface PaginaPdf {
  /** 1-indexado, como lo ve el usuario en su lector de PDF. */
  numero: number;
  buffer: Buffer;
}

/**
 * Parte un PDF en páginas individuales. Un PDF de una sola página se devuelve tal cual, sin
 * reescribirlo: re-serializarlo solo para obtener el mismo documento gastaría CPU y, peor, cambiaría
 * sus bytes — y el dedup por hash depende de que un archivo idéntico siga siendo idéntico.
 */
export async function separarPaginas(buffer: Buffer): Promise<PaginaPdf[]> {
  const { PDFDocument } = await import('pdf-lib');
  const origen = await PDFDocument.load(buffer);
  const total = origen.getPageCount();

  if (total === 0) return [];
  if (total > MAX_PAGINAS) throw new PdfDemasiadoGrandeError(total);
  if (total === 1) return [{ numero: 1, buffer }];

  const paginas: PaginaPdf[] = [];
  for (let i = 0; i < total; i += 1) {
    const doc = await PDFDocument.create();
    const [copiada] = await doc.copyPages(origen, [i]);
    doc.addPage(copiada);
    paginas.push({ numero: i + 1, buffer: Buffer.from(await doc.save()) });
  }
  log.info({ total }, 'PDF consolidado separado en páginas');
  return paginas;
}

/**
 * Recorta de un PDF las páginas pedidas (base 1, en el orden dado) y devuelve un PDF nuevo con solo
 * ellas. Es la contraparte de `separarPaginas` para consolidados que la partición ya delimitó: un
 * documento de tres hojas sale como UN PDF de tres páginas, no como tres sueltas (Épica #12245).
 *
 * Calco de `extractPages` de tramites/ocr-docs.routes.ts sin su tope de 20 páginas: aquí el tope es
 * el del consolidado entero (`MAX_PAGINAS`), y quien llama ya validó el rango. Una página fuera de
 * rango es un error de quien llama, no algo que se filtre en silencio: un recorte «parcial» se
 * leería como un documento incompleto sin que nadie lo supiera.
 */
export async function recortarPaginas(buffer: Buffer, paginas: number[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const origen = await PDFDocument.load(buffer);
  const total = origen.getPageCount();
  if (total > MAX_PAGINAS) throw new PdfDemasiadoGrandeError(total);
  if (paginas.length === 0) throw new RangeError('recortarPaginas: sin páginas que recortar');
  const indices = paginas.map((p) => {
    if (!Number.isInteger(p) || p < 1 || p > total) throw new RangeError(`recortarPaginas: página ${p} fuera de rango (1..${total})`);
    return p - 1;
  });
  const doc = await PDFDocument.create();
  const copiadas = await doc.copyPages(origen, indices);
  for (const pagina of copiadas) doc.addPage(pagina);
  return Buffer.from(await doc.save());
}

/** Nombre del archivo de una página suelta, derivado del consolidado que la contenía. */
export function nombrePagina(nombreOriginal: string, numero: number): string {
  const base = nombreOriginal.replace(/\.pdf$/i, '');
  return `${base} - pág ${numero}.pdf`;
}
