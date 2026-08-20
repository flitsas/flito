// FLITO Conciliación — lectura del Excel que Financiera descarga del portal (HU #11676).
//
// Este archivo hace UNA cosa: convertir el `.xlsx` en filas `{ filaNumero, numeroPolizaNorm,
// valorDeclarado }`. No consulta la base, no sabe qué es un SOAT y no decide nada del cruce. Está
// separado del servicio porque es lo único de todo el módulo que depende de la forma que hoy tiene
// el reporte del portal — el día que el portal cambie una columna, se toca aquí y nada más.
//
// ── Lo verificado contra el archivo real (docs/ejemplos/REPORTE SOAT DAVVID.xlsx) ────────────────
//
//   · Hoja «Export», encabezado en la fila 1, 18 columnas, 11 filas de datos en la muestra.
//   · «Número de Póliza» es la columna 1 y viene NUMÉRICA, de 16 dígitos (1508007030296000).
//   · «Total a Pagar» es la columna 18, numérica limpia, y cumple Prima Total + Contribución +
//     Recargo RUNT.
//   · NO hay columna de placa: la placa sale del SOAT que cruce, no del Excel.
//   · SÍ hay una columna «Nombre» con nombres completos de personas naturales. Este parser **no la
//     lee**: no está en el mapa de columnas, así que no puede acabar en la base, en la respuesta ni
//     en un log ni por accidente (AC11, Ley 1581).
//
// ── Por qué la póliza se lee como TEXTO y no como número ─────────────────────────────────────────
//
// `1508007030296000` cabe en un double por poco: Number.MAX_SAFE_INTEGER es 9007199254740991, o sea
// 16 dígitos justos. Una póliza de 17 dígitos ya no se puede representar exacta, y el síntoma no
// sería un error: sería un número con el último dígito cambiado que cruza contra el SOAT equivocado
// —o contra ninguno—. Como exceljs devuelve la celda ya parseada a `number`, los dígitos originales
// no se pueden recuperar; lo único honesto es DETECTARLO y rechazar el archivo diciendo por qué.
// De ahí `Number.isSafeInteger` en `polizaDeCelda`.

import ExcelJS from 'exceljs';
import {
  CONCILIACION_COLUMNA_POLIZA, CONCILIACION_COLUMNA_TOTAL, CONCILIACION_HOJA,
  CodigoErrorConciliacion, normalizarPoliza, POLIZA_MAX_LONGITUD,
} from '@operaciones/shared-types';

/** Una fila de datos ya leída y normalizada. Es todo lo que el cruce necesita del archivo. */
export interface FilaBoleta {
  /** 1 = primera fila de DATOS (la fila 2 del Excel). Es lo que el usuario ve en pantalla. */
  filaNumero: number;
  /** Fila física del Excel, solo para los mensajes de error: «revisa la fila 7 del archivo». */
  filaExcel: number;
  numeroPolizaNorm: string;
  valorDeclarado: number;
}

export interface BoletaParseada {
  filas: FilaBoleta[];
  /** Suma de «Total a Pagar» de las filas leídas. */
  totalDeclarado: number;
  /** Filas ignoradas por no traer póliza (la fila de totales de algunas descargas). */
  filasOmitidas: number;
}

/**
 * Fallo de lectura del archivo. Lo traduce el servicio a su HTTP; aquí solo se nombra el motivo con
 * su código, para que la pantalla pueda enseñar su propio texto sin parsear cadenas.
 */
export class ExcelBoletaError extends Error {
  constructor(
    readonly codigo: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExcelBoletaError';
  }
}

/** Techo de `numeric(14,2)` en la columna `valor_declarado`. Pasarse sería un 22003 en el INSERT. */
const TOPE_VALOR = 999_999_999_999.99;

/**
 * Compara encabezados sin que una tilde o una mayúscula tiren la carga.
 *
 * El portal ha escrito «Número de Póliza», «NUMERO DE POLIZA» y «Número de póliza» en distintas
 * versiones del reporte, y las tres son la misma columna. Lo que NO se tolera es que la columna no
 * esté: eso es un 400 que la nombra (AC8).
 */
function claveEncabezado(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Texto de una celda, cubriendo las formas que exceljs devuelve (rich text, fórmula, hyperlink). */
function textoDeCelda(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor.trim();
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  if (valor instanceof Date) return valor.toISOString();
  const o = valor as unknown as Record<string, unknown>;
  if (Array.isArray(o.richText)) {
    return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('').trim();
  }
  if ('result' in o) return textoDeCelda(o.result as ExcelJS.CellValue);
  if (typeof o.text === 'string') return o.text.trim();
  return '';
}

/**
 * El número de póliza como CADENA de dígitos, o `''` si la celda está vacía.
 *
 * Lanza si la celda es un número que ya perdió precisión: ver la nota de la cabecera. Devolver ahí
 * el número redondeado sería exactamente el fallo silencioso que este módulo no puede permitirse.
 */
function polizaDeCelda(valor: ExcelJS.CellValue, filaExcel: number): string {
  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor)) {
      throw new ExcelBoletaError(
        CodigoErrorConciliacion.ARCHIVO_INVALIDO,
        `La fila ${filaExcel} trae un número de póliza que Excel guardó como número y ya no se `
        + 'puede leer sin perder dígitos. Dale formato de texto a la columna «'
        + `${CONCILIACION_COLUMNA_POLIZA}» y vuelve a guardarlo.`,
        { filaExcel },
      );
    }
    return String(valor);
  }
  return textoDeCelda(valor);
}

/**
 * Un importe de la columna «Total a Pagar».
 *
 * El archivo real trae números limpios, pero una descarga guardada a mano puede traerlos como texto
 * con separadores. Se aceptan las dos convenciones —`1.234.567,89` y `1,234,567.89`— decidiendo por
 * el ÚLTIMO separador cuál es el decimal: es la única regla que no confunde `1.234` (mil doscientos
 * treinta y cuatro) con `1.234` (uno coma dos tres cuatro) más de lo que ya los confunde el formato.
 */
function numeroDeCelda(valor: ExcelJS.CellValue): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const texto = textoDeCelda(valor).replace(/[^\d.,-]/g, '');
  if (texto === '') return null;
  const ultimoPunto = texto.lastIndexOf('.');
  const ultimaComa = texto.lastIndexOf(',');
  let normal = texto;
  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    normal = ultimaComa > ultimoPunto
      ? texto.replace(/\./g, '').replace(',', '.')
      : texto.replace(/,/g, '');
  } else if (ultimaComa >= 0) {
    // Una sola coma: decimal si deja 1 o 2 cifras detrás; si no, es separador de miles.
    normal = texto.length - ultimaComa - 1 <= 2 ? texto.replace(',', '.') : texto.replace(/,/g, '');
  } else if (ultimoPunto >= 0 && texto.length - ultimoPunto - 1 === 3 && texto.indexOf('.') !== ultimoPunto) {
    normal = texto.replace(/\./g, '');
  }
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

/** Redondeo a pesos con dos decimales, el mismo criterio del libro de bolsa. */
function aPesos(n: number): number {
  return Math.round(n * 100) / 100;
}

/** La hoja «Export», o el 400 que dice que falta. */
function hojaDe(wb: ExcelJS.Workbook): ExcelJS.Worksheet {
  const objetivo = claveEncabezado(CONCILIACION_HOJA);
  const hoja = wb.worksheets.find((w) => claveEncabezado(w.name) === objetivo);
  if (!hoja) {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.ARCHIVO_INVALIDO,
      `El archivo no tiene la hoja «${CONCILIACION_HOJA}». Descárgalo otra vez del portal, tal cual.`,
      { hojaFaltante: CONCILIACION_HOJA },
    );
  }
  return hoja;
}

/**
 * Índices (1-based) de las dos columnas que se leen. Cualquier otra columna del reporte —incluida
 * «Nombre»— queda fuera del mapa a propósito.
 */
function columnasDe(hoja: ExcelJS.Worksheet): { poliza: number; total: number } {
  const encabezado = hoja.getRow(1);
  const porClave = new Map<string, number>();
  encabezado.eachCell({ includeEmpty: false }, (celda, i) => {
    const clave = claveEncabezado(textoDeCelda(celda.value));
    if (clave !== '' && !porClave.has(clave)) porClave.set(clave, i);
  });
  const poliza = porClave.get(claveEncabezado(CONCILIACION_COLUMNA_POLIZA));
  const total = porClave.get(claveEncabezado(CONCILIACION_COLUMNA_TOTAL));
  // Se nombra LA QUE FALTA, no «faltan columnas»: quien recibe el error tiene que poder mirar su
  // archivo y ver cuál es (AC8).
  if (poliza === undefined || total === undefined) {
    const faltante = poliza === undefined ? CONCILIACION_COLUMNA_POLIZA : CONCILIACION_COLUMNA_TOTAL;
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.ARCHIVO_INVALIDO,
      `La hoja «${CONCILIACION_HOJA}» no tiene la columna «${faltante}».`,
      { columnaFaltante: faltante },
    );
  }
  return { poliza, total };
}

/**
 * Lee el `.xlsx` del portal.
 *
 * @param maxFilas Tope de filas de datos (`env.CONCILIACION_MAX_FILAS`). Se comprueba ANTES de
 *   recorrer la hoja: un archivo con un millón de filas no se lee entero para luego rechazarlo.
 */
export async function parsearBoleta(buffer: Buffer, maxFilas: number): Promise<BoletaParseada> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // El mensaje de exceljs («Can't find end of central directory») no le dice nada a Financiera, y
    // repetirlo en la respuesta filtraría detalle de implementación sin ganar nada.
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.ARCHIVO_INVALIDO,
      'No pudimos leer el archivo. Tiene que ser el Excel que descargas del portal.',
    );
  }

  const hoja = hojaDe(wb);
  const { poliza: colPoliza, total: colTotal } = columnasDe(hoja);

  if (hoja.rowCount - 1 > maxFilas) {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.DEMASIADAS_FILAS,
      `El archivo trae ${hoja.rowCount - 1} líneas y el máximo son ${maxFilas}.`,
      { filas: hoja.rowCount - 1, maximo: maxFilas },
    );
  }

  const filas: FilaBoleta[] = [];
  // La póliza no se repite dentro de una boleta: hay un índice ÚNICO (boleta_id,
  // numero_poliza_norm) y dos filas iguales son el mismo pago contado dos veces. Se detecta AQUÍ, en
  // memoria, para que el usuario reciba un motivo legible con las dos filas en vez de un 23505.
  const vistas = new Map<string, number>();
  let totalDeclarado = 0;
  let filasOmitidas = 0;

  for (let r = 2; r <= hoja.rowCount; r += 1) {
    const fila = hoja.getRow(r);
    const crudoPoliza = polizaDeCelda(fila.getCell(colPoliza).value, r);
    const crudoTotal = fila.getCell(colTotal).value;

    if (crudoPoliza.trim() === '') {
      // Sin póliza no hay nada contra lo que cruzar. Si además la fila está vacía es relleno; si
      // trae importe es la fila de totales que algunas descargas añaden al final, y sumarla haría
      // que el total declarado valiera el doble. Se cuenta y se informa: no se calla.
      if (numeroDeCelda(crudoTotal) !== null) filasOmitidas += 1;
      continue;
    }

    const norm = normalizarPoliza(crudoPoliza);
    if (norm.length < 1 || norm.length > POLIZA_MAX_LONGITUD) {
      throw new ExcelBoletaError(
        CodigoErrorConciliacion.ARCHIVO_INVALIDO,
        `La fila ${r} tiene un número de póliza que no se puede usar: revísalo en el archivo.`,
        { filaExcel: r },
      );
    }

    const valor = numeroDeCelda(crudoTotal);
    if (valor === null || !(valor > 0) || valor > TOPE_VALOR) {
      throw new ExcelBoletaError(
        CodigoErrorConciliacion.ARCHIVO_INVALIDO,
        `La fila ${r} no trae un valor válido en la columna «${CONCILIACION_COLUMNA_TOTAL}».`,
        { filaExcel: r },
      );
    }

    const previa = vistas.get(norm);
    if (previa !== undefined) {
      throw new ExcelBoletaError(
        CodigoErrorConciliacion.POLIZA_REPETIDA,
        `La póliza de la fila ${r} ya aparece en la fila ${previa} del mismo archivo: sería el `
        + 'mismo SOAT cobrado dos veces. Revisa la descarga del portal antes de cargarla.',
        { filaExcel: r, filaExcelPrevia: previa },
      );
    }
    vistas.set(norm, r);

    filas.push({
      filaNumero: filas.length + 1,
      filaExcel: r,
      numeroPolizaNorm: norm,
      valorDeclarado: aPesos(valor),
    });
    totalDeclarado = aPesos(totalDeclarado + valor);
  }

  if (filas.length === 0) {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.SIN_FILAS,
      'El archivo no trae ninguna fila de datos.',
    );
  }
  if (filas.length > maxFilas) {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.DEMASIADAS_FILAS,
      `El archivo trae ${filas.length} líneas y el máximo son ${maxFilas}.`,
      { filas: filas.length, maximo: maxFilas },
    );
  }

  return { filas, totalDeclarado, filasOmitidas };
}
