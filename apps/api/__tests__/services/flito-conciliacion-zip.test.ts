// FLITO Conciliación — el tope de tamaño se comprueba ANTES de abrir el libro (HU #11676).
//
// El fallo que estas pruebas cierran no era teórico. Con un reporte de 800 000 filas fabricado con
// el propio ExcelJS —8 989 380 bytes, o sea POR DEBAJO del tope de 10 MB de multer, con el MIME
// correcto y magic number de xlsx legítimo— `parsearBoleta` tardaba 13,7 s con el event loop
// bloqueado y dejaba +1215 MB de heap ANTES de mirar cuántas filas traía; con el heap de un
// contenedor de 1 GB era `FATAL ERROR: Reached heap limit`, que ningún `try/catch` recoge.
//
// ── Cómo se demuestra aquí que el rechazo va PRIMERO, sin depender de cronómetros ────────────────
//
// Con un zip cuyo directorio central DECLARA una hoja enorme pero cuyos datos son basura que no se
// puede inflar. Ese archivo tiene dos desenlaces posibles y son distinguibles:
//
//   · si se rechaza por tamaño antes de abrirlo  → `archivo_demasiado_grande`
//   · si se abriera primero con ExcelJS          → `archivo_invalido`, porque el libro no se lee
//
// La propia prueba comprueba las DOS mitades: que ExcelJS efectivamente revienta con ese buffer, y
// que `parsearBoleta` no devuelve eso sino el rechazo por tamaño. No hay forma de que pase si el
// orden se invierte otra vez.
//
// Los zips van fabricados a mano porque hace falta poder MENTIR en las cabeceras: ninguna librería
// escribe un central directory que declare 1 KB para 40 MB de datos, y ese es justo el caso que la
// segunda pasada tiene que atrapar. El falsificador vive en `__tests__/helpers/zip-falso.ts` desde
// que el Bug #11682 lo compartió con las pruebas de vehículos y SOAT.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { CONCILIACION_MAX_FILAS } from '@operaciones/shared-types';
import { medirXlsx } from '../../src/shared/utils/xlsx-zip.js';
import { xlsxFalso } from '../helpers/zip-falso.js';
import {
  CONCILIACION_MAX_DESCOMPRIMIDO, ExcelBoletaError, parsearBoleta,
} from '../../src/modules/flito-conciliacion/flito-conciliacion.excel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCEL_REAL = path.resolve(__dirname, '../../../../docs/ejemplos/REPORTE SOAT DAVVID.xlsx');

const LIMITES = {
  maxBytes: CONCILIACION_MAX_DESCOMPRIMIDO,
  maxHojas: 8,
  maxEntradas: 64,
};

async function fallo(buffer: Buffer, opts = {}): Promise<ExcelBoletaError> {
  try {
    await parsearBoleta(buffer, CONCILIACION_MAX_FILAS, opts);
  } catch (e) {
    return e as ExcelBoletaError;
  }
  throw new Error('se esperaba que el parser rechazara el archivo');
}

describe('flito-conciliacion · el zip se mide antes de abrirlo', () => {
  const hay = existsSync(EXCEL_REAL);
  const conReal = hay ? it : it.skip;

  conReal('el reporte REAL del portal pasa holgado: 25 KB por dentro, una hoja', async () => {
    const medida = await medirXlsx(readFileSync(EXCEL_REAL), LIMITES);

    expect(medida).toMatchObject({ estado: 'ok', hojas: 1, entradas: 10 });
    // 25 057 bytes descomprimidos según el propio zip. El techo es 16 MB: 650 veces más.
    expect(medida.estado === 'ok' && medida.bytes).toBe(25057);
  });

  conReal('y sigue cargándose entero: el camino feliz no se tocó', async () => {
    const parseada = await parsearBoleta(readFileSync(EXCEL_REAL), CONCILIACION_MAX_FILAS);

    expect(parseada.filas).toHaveLength(11);
    expect(parseada.totalDeclarado).toBe(740800 * 11);
  });

  it('un xlsx normal escrito por ExcelJS también pasa, y lo medido es lo que ocupa', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Export');
    ws.addRow(['Número de Póliza', 'Total a Pagar']);
    for (let i = 0; i < 200; i += 1) ws.addRow([`150800703029${1000 + i}`, 740800]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const medida = await medirXlsx(buffer, LIMITES);
    expect(medida.estado).toBe('ok');
    // Un reporte de 200 filas no llega ni al mega descomprimido: el techo no le queda corto a nadie.
    expect(medida.estado === 'ok' && medida.bytes).toBeLessThan(1024 * 1024);
  });

  it('PRIMERA pasada · lo delatan sus cabeceras, y el libro no se llega a abrir', async () => {
    // Declara 200 MB de hoja; los datos son basura que no se puede inflar. Si el archivo se abriera
    // antes de medirlo, el desenlace sería otro —y la mitad de abajo de esta prueba lo demuestra—.
    const bomba = xlsxFalso({
      nombre: 'xl/worksheets/sheet1.xml',
      datos: Buffer.from('esto no es un flujo deflate'),
      crudo: true,
      declarado: 200 * 1024 * 1024,
    });

    const medida = await medirXlsx(bomba, LIMITES);
    expect(medida).toMatchObject({ estado: 'excede', segun: 'cabeceras' });
    expect(medida.estado === 'excede' && medida.bytes).toBeGreaterThan(100 * 1024 * 1024);

    // Abrirlo con ExcelJS falla: ese es el error que devolvería el parser si el orden se invirtiera.
    await expect(new ExcelJS.Workbook().xlsx.load(bomba as unknown as ArrayBuffer)).rejects.toThrow();

    const e = await fallo(bomba);
    expect(e.codigo).toBe('archivo_demasiado_grande');
    expect(e.codigo).not.toBe('archivo_invalido');
    expect(e.extra).toMatchObject({ maximo: CONCILIACION_MAX_DESCOMPRIMIDO });
  });

  it('SEGUNDA pasada · un zip que MIENTE en sus cabeceras muere igual, sin inflarlo entero', async () => {
    // 40 MB de XML que caben en unas decenas de KB, declarados como 1 KB en el directorio central.
    // La primera pasada se lo traga —lo declarado cabe— y es el presupuesto de zlib el que corta.
    const enorme = Buffer.from(`<sheetData>${' '.repeat(40 * 1024 * 1024)}</sheetData>`);
    const mentirosa = xlsxFalso({
      nombre: 'xl/worksheets/sheet1.xml', datos: enorme, declarado: 1024,
    });
    expect(mentirosa.length).toBeLessThan(1024 * 1024);

    const t0 = Date.now();
    const medida = await medirXlsx(mentirosa, LIMITES);
    expect(medida).toMatchObject({ estado: 'excede', segun: 'datos' });
    // Cortar en el presupuesto significa no materializar los 40 MB: es cosa de milisegundos.
    expect(Date.now() - t0).toBeLessThan(2000);

    expect((await fallo(mentirosa)).codigo).toBe('archivo_demasiado_grande');
  });

  it('el techo se puede apretar en una prueba, y entonces rechaza hasta un archivo pequeño', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Export');
    ws.addRow(['Número de Póliza', 'Total a Pagar']);
    for (let i = 0; i < 2000; i += 1) ws.addRow([`150800703029${1000 + i}`, 740800]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    // Mismo archivo, dos veredictos: con el techo de producción entra; con 64 KB, no. Es la prueba
    // de que el rechazo mira el tamaño DESCOMPRIMIDO y no el del archivo (que aquí es diminuto).
    expect((await medirXlsx(buffer, LIMITES)).estado).toBe('ok');

    const e = await fallo(buffer, { maxDescomprimido: 64 * 1024 });
    expect(e.codigo).toBe('archivo_demasiado_grande');
    expect(e.message).toContain('MB');
    expect(e.extra).toMatchObject({ maximo: 64 * 1024 });
  });

  it('un libro con más hojas de las que el portal manda se rechaza por estructura', async () => {
    const muchasHojas = xlsxFalso(
      { nombre: 'xl/worksheets/sheet1.xml', datos: Buffer.from('<worksheet/>') }, 12,
    );

    expect(await medirXlsx(muchasHojas, LIMITES)).toMatchObject({ estado: 'estructura' });
    expect((await fallo(muchasHojas)).codigo).toBe('archivo_demasiado_grande');
  });

  it('lo que no es un zip recorrible sigue siendo «no pudimos leer el archivo»', async () => {
    for (const basura of [Buffer.alloc(0), Buffer.from('%PDF-1.4 no soy un zip'), Buffer.alloc(5000)]) {
      expect(await medirXlsx(basura, LIMITES)).toEqual({ estado: 'ilegible' });
      const e = await fallo(basura);
      expect(e.codigo).toBe('archivo_invalido');
      expect(e.message).toContain('No pudimos leer el archivo');
    }
  });

  it('el rechazo no deja el heap por el suelo: medir no es cargar', async () => {
    // 32 MB de hoja declarados con honestidad. Abrirlos con ExcelJS costaría cientos de MB (medido:
    // ~11× el XML); rechazarlos por cabeceras tiene que costar lo que ocupa el propio buffer.
    const bomba = xlsxFalso({
      nombre: 'xl/worksheets/sheet1.xml',
      datos: Buffer.from(`<sheetData>${' '.repeat(32 * 1024 * 1024)}</sheetData>`),
    });

    const antes = process.memoryUsage().heapUsed;
    const e = await fallo(bomba);
    const gastado = process.memoryUsage().heapUsed - antes;

    expect(e.codigo).toBe('archivo_demasiado_grande');
    expect(gastado).toBeLessThan(64 * 1024 * 1024);
  });
});
