import ExcelJS from 'exceljs';
import { Response } from 'express';
import { medirXlsx, type LimitesZip, type RechazoXlsx } from './xlsx-zip.js';

interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

export async function sendExcel(res: Response, filename: string, columns: ExcelColumn[], rows: Record<string, unknown>[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Datos');

  sheet.columns = columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width || 20,
  }));

  // Header style
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  rows.forEach((row) => sheet.addRow(row));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
}

/**
 * El puente entre el `Buffer` de Node y lo que ExcelJS declara que recibe.
 *
 * `exceljs/index.d.ts:1` hace `declare interface Buffer extends ArrayBuffer {}`, o sea que redefine
 * `Buffer` GLOBALMENTE para sus firmas: `xlsx.load` pide algo asignable a `ArrayBuffer` y un Buffer
 * de Node no lo es. En runtime sí lo acepta —es lo que hacen los tres puntos de ingesta desde
 * siempre—, así que lo que falta es una conversión de tipos, no de datos: copiar el `ArrayBuffer`
 * subyacente duplicaría 10 MB por carga, justo lo contrario de lo que persigue el Bug #11682.
 *
 * Se escribe UNA vez y aquí, en vez de repartir `as any` por cada llamada: un `as any` además apaga
 * el chequeo del resto de argumentos de `load`, y esto solo afecta al primero.
 */
export function bufferParaExcelJS(buffer: Buffer): ArrayBuffer {
  return buffer as unknown as ArrayBuffer;
}

/** El único MIME que un `.xlsx` declara. El olfateo real de los bytes lo hace `medirXlsx`. */
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Cuántas hojas y cuántas entradas se toleran en un libro que sube un usuario (Bug #11682).
 *
 * A diferencia de Conciliación —que recibe SIEMPRE el mismo reporte del portal, con una hoja y diez
 * entradas—, aquí el archivo lo arma quien carga: puede venir de RUNT, de un export del proveedor o
 * de un Excel guardado a mano con varias pestañas. Dieciséis hojas cubren eso de sobra; 128 entradas
 * las alojan (un libro de una hoja escrito por ExcelJS trae 16 entradas —medido—, y cada hoja de más
 * añade ~3 entre `sheetN.xml`, sus `_rels` y su parte en `[Content_Types]`).
 *
 * Estos dos NO son un cinturón de memoria —el techo de bytes lo pone cada consumidor—: existen para
 * no recorrer un directorio central con un millón de registros antes de poder decir que no.
 */
export const XLSX_MAX_HOJAS = 16;
export const XLSX_MAX_ENTRADAS = 128;

/** Los límites de un flujo, dado su techo de bytes descomprimidos. */
export function limitesXlsx(maxBytes: number): LimitesZip {
  return { maxBytes, maxHojas: XLSX_MAX_HOJAS, maxEntradas: XLSX_MAX_ENTRADAS };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

/**
 * El texto que ve quien cargó el archivo, y el HTTP que le corresponde.
 *
 * Vive aquí y no en `xlsx-zip.ts` porque aquel no sabe de HTTP y no debe saberlo; y lo comparten los
 * tres puntos de ingesta —en vez de escribir cada uno su frase— para que el mismo archivo no reciba
 * tres explicaciones distintas según por qué pantalla haya entrado. Conciliación NO lo usa: tiene
 * sus propios códigos de dominio y su copy para Financiera.
 *
 * 413 para el que no cabe (hay precedente en `vehicles/ocr.routes.ts`), 400 para el que no se puede
 * leer: son problemas distintos y el cliente no debería tener que adivinarlo por el texto.
 */
export function rechazoXlsxAHttp(rechazo: RechazoXlsx, limites: LimitesZip): { status: 413 | 400; mensaje: string } {
  if (rechazo.estado === 'excede') {
    return {
      status: 413,
      mensaje: `El archivo ocupa ${mb(rechazo.bytes)} MB por dentro y el máximo son ${mb(limites.maxBytes)} MB. `
        + 'Divídelo en cargas más pequeñas o quítale las filas que no vayan a procesarse.',
    };
  }
  if (rechazo.estado === 'estructura') {
    return {
      status: 400,
      mensaje: `El libro trae ${rechazo.hojas} hojas y ${rechazo.entradas} partes: más de las que esta carga admite. `
        + 'Sube un archivo con una sola hoja de datos.',
    };
  }
  return { status: 400, mensaje: 'No pudimos leer el archivo. Asegúrate de que sea un .xlsx sin dañar.' };
}

/**
 * Lo que devuelve `parseExcel`: o las filas, o el motivo por el que el libro no se llegó a abrir.
 *
 * Es un resultado y no una excepción a propósito. Con `Promise<T[]>` el rechazo tendría que viajar
 * como `throw`, y un `throw` desde aquí se lo come `express-async-errors` y sale como 500 genérico
 * salvo que CADA llamador se acuerde de atraparlo — justo lo que nadie se acuerda de hacer. Con esta
 * forma, el compilador no deja usar `filas` sin haber mirado antes `ok`.
 */
export type ParseExcelResultado<T> =
  | { ok: true; filas: T[] }
  | { ok: false; rechazo: RechazoXlsx };

/**
 * Lee la primera hoja de un `.xlsx`, **después** de comprobar cuánto ocupa por dentro (Bug #11682).
 *
 * El orden es el arreglo entero: `workbook.xlsx.load` descomprime y materializa el libro completo en
 * el heap, así que cualquier tope que se mire sobre el libro ya cargado llega tarde. Ver
 * `shared/utils/xlsx-zip.ts` para el porqué y para las medidas.
 *
 * `limites` es OBLIGATORIO y sin valor por defecto: el techo depende de cuántas filas admite el
 * flujo que llama —no de esta función—, y un defecto silencioso se le quedaría corto a un consumidor
 * o largo a otro sin que nadie se entere. Quien añada un llamador nuevo tiene que pensar su número
 * y escribir el cálculo, como hacen los de hoy.
 *
 * El buffer se estrecha a `Buffer` (antes era `Buffer | ArrayBuffer`): `medirXlsx` necesita leer
 * offsets con `readUInt32LE`, que es de `Buffer`, y los dos llamadores pasan `req.file.buffer`, que
 * ya lo es. Eso además quita el `as any` del `load`, porque ExcelJS declara `load(buffer: Buffer)`.
 */
export async function parseExcel<T>(
  buffer: Buffer,
  mapper: (row: ExcelJS.Row) => T | null,
  limites: LimitesZip,
): Promise<ParseExcelResultado<T>> {
  const medida = await medirXlsx(buffer, limites);
  if (medida.estado !== 'ok') return { ok: false, rechazo: medida };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bufferParaExcelJS(buffer));

  const sheet = workbook.worksheets[0];
  if (!sheet) return { ok: true, filas: [] };

  const results: T[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const mapped = mapper(row);
    if (mapped) results.push(mapped);
  });

  return { ok: true, filas: results };
}
