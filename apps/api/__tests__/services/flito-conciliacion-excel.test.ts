// FLITO Conciliación — lectura del Excel del portal (HU #11676, AC7, AC8, AC11).
//
// Lo primero de este archivo es el test que importa más y que ningún fixture inventado puede
// sustituir: **el .xlsx REAL descargado del portal** (`docs/ejemplos/REPORTE SOAT DAVVID.xlsx`).
// Todo lo demás —la hoja, el encabezado, los 16 dígitos de la póliza— son afirmaciones sobre un
// formato que no controlamos, y comprobarlas contra un archivo que nos hemos fabricado nosotros
// demostraría solamente que sabemos fabricarlo igual que lo leemos.
//
// Ese archivo está en `.gitignore` (trae nombres de personas naturales, ver AC11). Si falta —un CI
// limpio, un clon nuevo— el test se SALTA con `it.skip` y lo dice, en vez de fallar: un archivo
// ausente no es una regresión del parser. El resto de la suite cubre el comportamiento con fixtures.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { CONCILIACION_MAX_FILAS } from '@operaciones/shared-types';
import { ExcelBoletaError, parsearBoleta } from '../../src/modules/flito-conciliacion/flito-conciliacion.excel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCEL_REAL = path.resolve(__dirname, '../../../../docs/ejemplos/REPORTE SOAT DAVVID.xlsx');

const MAX = CONCILIACION_MAX_FILAS;

/** Los 18 encabezados del portal, en su orden real. `Nombre` incluida: el parser no debe leerla. */
const ENCABEZADOS_PORTAL = [
  'Número de Póliza', 'Nombre', 'Fecha de Expedición', 'Prima', 'Descuento de Ley', 'Prima Total',
  'Comisión', 'IVA Comisión', 'ReteIVA', 'Sobrecomisión', 'Contribución', 'Retención', 'Ica',
  'Estado', 'Monto Reimpresión', 'Recargo RUNT', 'Medio de Pago', 'Total a Pagar',
];

interface FilaFixture {
  poliza?: string | number | null;
  nombre?: string;
  total?: number | string | null;
}

/** Fabrica un .xlsx con la forma del portal. `hoja` y `encabezados` se pueden retorcer a propósito. */
async function xlsx(
  filas: FilaFixture[],
  opts: { hoja?: string; encabezados?: string[] } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.hoja ?? 'Export');
  ws.addRow(opts.encabezados ?? ENCABEZADOS_PORTAL);
  for (const f of filas) {
    const fila: (string | number | null)[] = new Array(18).fill(null);
    fila[0] = f.poliza ?? null;
    fila[1] = f.nombre ?? null;
    fila[17] = f.total ?? null;
    ws.addRow(fila);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fallo(buffer: Buffer, max = MAX): Promise<ExcelBoletaError> {
  try {
    await parsearBoleta(buffer, max);
  } catch (e) {
    return e as ExcelBoletaError;
  }
  throw new Error('se esperaba que el parser rechazara el archivo');
}

describe('flito-conciliacion · el Excel REAL del portal', () => {
  const hay = existsSync(EXCEL_REAL);
  const caso = hay ? it : it.skip;

  caso('lo entiende: hoja Export, encabezado en la fila 1 y las dos columnas que el cruce necesita', async () => {
    const parseada = await parsearBoleta(readFileSync(EXCEL_REAL), MAX);

    // 11 filas de datos bajo el encabezado. Si el portal cambia el reporte, este número cambia y
    // el test lo dice: es lo que se quiere saber.
    expect(parseada.filas).toHaveLength(11);
    expect(parseada.filasOmitidas).toBe(0);

    // «Total a Pagar» de la muestra: 740 800 por fila.
    expect(parseada.filas[0].valorDeclarado).toBe(740800);
    expect(parseada.totalDeclarado).toBe(740800 * 11);

    // La numeración que ve el usuario empieza en 1 y es la fila de DATOS, no la del Excel.
    expect(parseada.filas[0].filaNumero).toBe(1);
    expect(parseada.filas[0].filaExcel).toBe(2);
  });

  caso('lee la póliza de 16 dígitos SIN perder un solo dígito ni pasarla a notación científica', async () => {
    const parseada = await parsearBoleta(readFileSync(EXCEL_REAL), MAX);

    // Es el punto entero de leerla como texto: la celda es NUMÉRICA en el archivo y
    // `1508007030296000` roza Number.MAX_SAFE_INTEGER. Un `toString()` descuidado de un double más
    // grande habría dado «1.508007030296e+15».
    expect(parseada.filas[0].numeroPolizaNorm).toBe('1508007030296000');
    for (const fila of parseada.filas) {
      expect(fila.numeroPolizaNorm).toMatch(/^\d{16}$/);
      expect(fila.numeroPolizaNorm).not.toContain('e');
    }
    // Y no se repite ninguna: el archivo real pasa el guarda de póliza repetida.
    expect(new Set(parseada.filas.map((f) => f.numeroPolizaNorm)).size).toBe(11);
  });

  caso('AC11 · no devuelve ni un solo nombre de los que trae la columna «Nombre»', async () => {
    const buffer = readFileSync(EXCEL_REAL);

    // Se leen los nombres del archivo APARTE, con exceljs a pelo, para poder afirmar que ninguno
    // aparece en lo que el parser entrega. Sin esta lectura el test sería «no veo nombres», que es
    // lo mismo que decir que no los busqué.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const hoja = wb.getWorksheet('Export')!;
    const nombres: string[] = [];
    for (let r = 2; r <= hoja.rowCount; r += 1) {
      const v = hoja.getRow(r).getCell(2).value;
      if (typeof v === 'string' && v.trim() !== '') nombres.push(v.trim());
    }
    expect(nombres.length).toBeGreaterThan(0);

    const parseada = await parsearBoleta(buffer, MAX);
    const serializado = JSON.stringify(parseada);
    for (const nombre of nombres) {
      expect(serializado).not.toContain(nombre);
      // Y tampoco el apellido suelto: la coma del portal separa apellidos de nombres.
      expect(serializado).not.toContain(nombre.split(',')[0]);
    }
    // La fila leída solo tiene las cuatro claves del cruce. Ninguna es un nombre.
    expect(Object.keys(parseada.filas[0]).sort())
      .toEqual(['filaExcel', 'filaNumero', 'numeroPolizaNorm', 'valorDeclarado']);
  });

  if (!hay) {
    it('AVISO: docs/ejemplos/REPORTE SOAT DAVVID.xlsx no está en este worktree', () => {
      expect(hay).toBe(false);
    });
  }
});

describe('flito-conciliacion · lo que el parser acepta', () => {
  it('lee la póliza aunque venga como texto con guiones y espacios, y la normaliza', async () => {
    const parseada = await parsearBoleta(await xlsx([
      { poliza: ' 1508-007-030 296000 ', total: 740800 },
    ]), MAX);
    expect(parseada.filas[0].numeroPolizaNorm).toBe('1508007030296000');
  });

  it('tolera que el portal cambie la caja o las tildes de los encabezados', async () => {
    const encabezados = [...ENCABEZADOS_PORTAL];
    encabezados[0] = 'NUMERO DE POLIZA';
    encabezados[17] = 'total  a   pagar';
    const parseada = await parsearBoleta(
      await xlsx([{ poliza: '123', total: 1000 }], { encabezados }),
      MAX,
    );
    expect(parseada.filas).toHaveLength(1);
  });

  it('ignora la fila de totales del final —la que no trae póliza— y la CUENTA', async () => {
    // Sumarla haría que el total declarado valiera el doble, que es un error que nadie ve hasta que
    // la boleta no cuadra por millones.
    const parseada = await parsearBoleta(await xlsx([
      { poliza: '111', total: 100 },
      { poliza: '222', total: 200 },
      { poliza: null, total: 300 },
    ]), MAX);
    expect(parseada.filas).toHaveLength(2);
    expect(parseada.totalDeclarado).toBe(300);
    expect(parseada.filasOmitidas).toBe(1);
  });

  it('lee importes escritos con separadores, en las dos convenciones', async () => {
    const parseada = await parsearBoleta(await xlsx([
      { poliza: '111', total: '740.800,50' },
      { poliza: '222', total: '740,800.50' },
    ]), MAX);
    expect(parseada.filas.map((f) => f.valorDeclarado)).toEqual([740800.5, 740800.5]);
  });
});

describe('flito-conciliacion · lo que el parser rechaza (AC7, AC8)', () => {
  it('AC8 · nombra la columna que falta, y la nombra a ella', async () => {
    const sinPoliza = [...ENCABEZADOS_PORTAL];
    sinPoliza[0] = 'Otra cosa';
    const e1 = await fallo(await xlsx([{ poliza: '1', total: 1 }], { encabezados: sinPoliza }));
    expect(e1.codigo).toBe('archivo_invalido');
    expect(e1.message).toContain('Número de Póliza');
    expect(e1.extra.columnaFaltante).toBe('Número de Póliza');

    const sinTotal = [...ENCABEZADOS_PORTAL];
    sinTotal[17] = 'Otra cosa';
    const e2 = await fallo(await xlsx([{ poliza: '1', total: 1 }], { encabezados: sinTotal }));
    expect(e2.message).toContain('Total a Pagar');
    expect(e2.extra.columnaFaltante).toBe('Total a Pagar');
  });

  it('rechaza el archivo cuya hoja no se llama Export', async () => {
    const e = await fallo(await xlsx([{ poliza: '1', total: 1 }], { hoja: 'Hoja1' }));
    expect(e.codigo).toBe('archivo_invalido');
    expect(e.message).toContain('Export');
  });

  it('rechaza lo que no es un xlsx, sin filtrar el error de la librería', async () => {
    const e = await fallo(Buffer.from('esto no es un zip, y mucho menos un xlsx'));
    expect(e.codigo).toBe('archivo_invalido');
    expect(e.message).toBe('No pudimos leer el archivo. Tiene que ser el Excel que descargas del portal.');
  });

  it('rechaza el archivo que solo trae encabezados', async () => {
    const e = await fallo(await xlsx([]));
    expect(e.codigo).toBe('sin_filas');
  });

  it('AC7 · rechaza por encima del tope de filas, diciendo cuántas trae y cuál es el máximo', async () => {
    const filas = Array.from({ length: 6 }, (_, i) => ({ poliza: `P${i}`, total: 100 }));
    const e = await fallo(await xlsx(filas), 5);
    expect(e.codigo).toBe('demasiadas_filas');
    expect(e.extra).toMatchObject({ filas: 6, maximo: 5 });
  });

  it('detecta la MISMA póliza en dos filas ANTES del INSERT, con las dos filas en el motivo', async () => {
    // Arrastre del gate de la HU anterior: existe un índice único (boleta_id, numero_poliza_norm),
    // así que sin esta comprobación el desenlace sería un 23505 crudo — un 500 sin explicación.
    const e = await fallo(await xlsx([
      { poliza: '1508007030296000', total: 100 },
      { poliza: '999', total: 100 },
      { poliza: '1508-0070-3029-6000', total: 100 },
    ]));
    expect(e.codigo).toBe('poliza_repetida');
    expect(e.extra).toMatchObject({ filaExcel: 4, filaExcelPrevia: 2 });
    expect(e.message).toContain('fila 4');
    expect(e.message).toContain('fila 2');
  });

  it('rechaza la fila cuyo valor no se puede leer o no es positivo', async () => {
    const e = await fallo(await xlsx([{ poliza: '111', total: 'no es un número' }]));
    expect(e.codigo).toBe('archivo_invalido');
    expect(e.message).toContain('fila 2');

    const cero = await fallo(await xlsx([{ poliza: '111', total: 0 }]));
    expect(cero.codigo).toBe('archivo_invalido');
  });

  it('rechaza —en vez de truncar— una póliza numérica que ya perdió dígitos en el propio Excel', async () => {
    // 18 dígitos: muy por encima de Number.MAX_SAFE_INTEGER. Devolver el número redondeado sería
    // cruzar contra el SOAT equivocado sin que nadie se entere, que es el fallo que no se admite.
    // El valor se construye desde una cadena y no como literal: escribirlo a mano es exactamente lo
    // que `no-loss-of-precision` prohíbe en el código fuente, y aquí hace falta el número YA
    // estropeado, que es lo que exceljs entrega cuando el portal exporta la póliza como número.
    const yaEstropeado = Number('150800703029600011');
    const e = await fallo(await xlsx([{ poliza: yaEstropeado, total: 100 }]));
    expect(e.codigo).toBe('archivo_invalido');
    expect(e.message).toContain('perder dígitos');
  });
});
