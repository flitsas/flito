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

/** Nombre del archivo de una página suelta, derivado del consolidado que la contenía. */
export function nombrePagina(nombreOriginal: string, numero: number): string {
  const base = nombreOriginal.replace(/\.pdf$/i, '');
  return `${base} - pág ${numero}.pdf`;
}
