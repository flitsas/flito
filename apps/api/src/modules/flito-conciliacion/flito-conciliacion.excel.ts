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
import { medirXlsx, type LimitesZip } from '../../shared/utils/xlsx-zip.js';

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
 * Techo de lo que el libro puede ocupar DESCOMPRIMIDO, sumadas todas sus partes.
 *
 * Los 10 MB de `CONCILIACION_MAX_BYTES` acotan lo que viaja por la red, no lo que ocupa en el heap:
 * un zip comprime XML 20:1 sin despeinarse, así que un archivo que pasa el tope de multer y el
 * magic number puede traer 105 MB de `sheet1.xml` dentro. Ese es el archivo real con el que se
 * reprodujo el fallo, y `load` se comía 1215 MB de heap antes de dejar contar sus filas.
 *
 * Por qué 16 MB y no un número redondo más grande:
 *
 *   · El reporte REAL del portal ocupa 25 KB descomprimidos con 11 filas (7,6 KB de hoja, ~700 B
 *     por fila). Un reporte de las 500 filas del tope ronda los 350 KB, y uno guardado a mano por
 *     Excel —con estilos por celda— no llega al mega. 16 MB son cuarenta veces eso: nadie legítimo
 *     lo va a rozar.
 *   · Al abrirlo, ExcelJS multiplica: 105 MB de XML se convirtieron en +1215 MB de heap, o sea ~11×.
 *     Con 16 MB el pico por carga queda en unos 190 MB, que el contenedor de 4 GB
 *     (`apps/api/Dockerfile`) aguanta aunque entren varias cargas a la vez. Con 50 MB serían 575 MB
 *     por carga y tres simultáneas volverían a poner el proceso en el filo.
 *
 * Con el pico acotado NO se añade además un semáforo de «una carga a la vez». Serializar pondría a
 * hacer cola peticiones que ya tienen retenido su buffer de hasta 10 MB en multer: la memoria no se
 * ahorraría, se movería a la cola —y esa sí crece sin techo—, a cambio de volver secuencial una
 * pantalla que Financiera usa a diario. Limitar concurrencia, si alguna vez hace falta, es cosa del
 * proceso o del proxy, no de este parser.
 *
 * Se puede bajar en una prueba pasando `opts.maxDescomprimido`; no hay variable de entorno porque
 * esto no es una política de negocio que Operaciones vaya a recalibrar, es un cinturón de memoria.
 */
export const CONCILIACION_MAX_DESCOMPRIMIDO = 16 * 1024 * 1024;

/** El reporte del portal trae UNA hoja y diez entradas. Se deja margen, no una barra libre. */
export const CONCILIACION_MAX_HOJAS = 8;
export const CONCILIACION_MAX_ENTRADAS = 64;

/** Ajustes de la revisión previa del zip. Existen para poder apretarlos en las pruebas. */
export interface OpcionesBoleta {
  maxDescomprimido?: number;
  maxHojas?: number;
  maxEntradas?: number;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

/**
 * El portero: mira el zip por fuera y decide si se puede abrir. Lanza si no.
 *
 * Todo el porqué está en `shared/utils/xlsx-zip.ts`. Lo que importa aquí es el ORDEN: esto corre
 * ANTES de `wb.xlsx.load`, que es la línea que descomprime y materializa el libro entero.
 */
async function revisarZip(buffer: Buffer, limites: LimitesZip, maxFilas: number): Promise<void> {
  const medida = await medirXlsx(buffer, limites);
  if (medida.estado === 'ok') return;

  if (medida.estado === 'excede') {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.ARCHIVO_DEMASIADO_GRANDE,
      `El archivo ocupa ${mb(medida.bytes)} MB por dentro y el máximo son `
      + `${mb(limites.maxBytes)} MB: no es el reporte de una boleta de hasta ${maxFilas} líneas. `
      + 'Descárgalo otra vez del portal, tal cual, sin abrirlo ni volverlo a guardar.',
      { bytes: medida.bytes, maximo: limites.maxBytes },
    );
  }
  if (medida.estado === 'estructura') {
    throw new ExcelBoletaError(
      CodigoErrorConciliacion.ARCHIVO_DEMASIADO_GRANDE,
      `El archivo trae ${medida.hojas} hojas y ${medida.entradas} componentes: no es el reporte que `
      + 'descargas del portal.',
      { hojas: medida.hojas, entradas: medida.entradas },
    );
  }
  // ilegible: ni siquiera es un zip que se deje recorrer. Mismo desenlace que un `load` fallido, y
  // a propósito el mismo texto: al que sube el archivo le da igual en qué byte se rompió.
  throw new ExcelBoletaError(
    CodigoErrorConciliacion.ARCHIVO_INVALIDO,
    'No pudimos leer el archivo. Tiene que ser el Excel que descargas del portal.',
  );
}

/**
 * Lee el `.xlsx` del portal.
 *
 * El tamaño se comprueba DOS veces y por motivos distintos, y el orden no es negociable:
 *
 *   1. `revisarZip`, ANTES de abrir nada, acota lo que el libro puede ocupar en el heap mirando el
 *      zip por fuera. Sin esto, `load` materializa el libro entero —13,7 s de event loop bloqueado
 *      y 1,2 GB de heap con un archivo de 9 MB— y cualquier tope posterior llega tarde: con el heap
 *      de producción, dos cargas así se llevan por delante el proceso, no la petición.
 *   2. El tope de FILAS, que es una regla de negocio (`CONCILIACION_MAX_FILAS`) y no una defensa,
 *      se comprueba con el libro ya abierto, antes de recorrer la hoja.
 *
 * @param maxFilas Tope de filas de datos (`env.CONCILIACION_MAX_FILAS`).
 * @param opts Cinturones de memoria; por defecto los de este módulo. Se aprietan en las pruebas.
 */
export async function parsearBoleta(
  buffer: Buffer, maxFilas: number, opts: OpcionesBoleta = {},
): Promise<BoletaParseada> {
  await revisarZip(buffer, {
    maxBytes: opts.maxDescomprimido ?? CONCILIACION_MAX_DESCOMPRIMIDO,
    maxHojas: opts.maxHojas ?? CONCILIACION_MAX_HOJAS,
    maxEntradas: opts.maxEntradas ?? CONCILIACION_MAX_ENTRADAS,
  }, maxFilas);

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
