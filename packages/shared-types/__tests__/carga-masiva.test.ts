import { describe, it, expect } from 'vitest';
import {
  CARGA_MASIVA_ARCHIVOS_POR_PETICION,
  CARGA_MASIVA_MAX_ARCHIVOS,
  CARGA_MASIVA_MAX_BYTES_ARCHIVO,
  CARGA_MASIVA_MAX_BYTES_CRUDOS,
  CARGA_MASIVA_MAX_BYTES_CUERPO,
  CARGA_MASIVA_MAX_ENTRADAS_ZIP,
  partirCargaMasivaEnTandas,
} from '../src/carga-masiva';
import * as barrel from '../src/index';

// Topes de la carga masiva SOAT/impuestos (HU #12050 / #12051).
//
// Viven en shared-types porque multer, nginx y el cliente de tandas tienen que citar el
// mismo número. Estos tests fijan NOMBRE y VALOR: si alguien “ajusta” el 50 o el 15 MB en un solo
// sitio, el contrato se parte sin que TypeScript se queje.

describe('HU #12050 — nombres y valores de los topes de carga masiva', () => {
  it('CARGA_MASIVA_MAX_ARCHIVOS es 50', () => {
    expect(CARGA_MASIVA_MAX_ARCHIVOS).toBe(50);
  });

  it('CARGA_MASIVA_MAX_BYTES_ARCHIVO es 15 MiB', () => {
    expect(CARGA_MASIVA_MAX_BYTES_ARCHIVO).toBe(15 * 1024 * 1024);
  });

  it('CARGA_MASIVA_MAX_BYTES_CUERPO es 250 MiB (nginx client_max_body_size)', () => {
    expect(CARGA_MASIVA_MAX_BYTES_CUERPO).toBe(250 * 1024 * 1024);
  });

  it('CARGA_MASIVA_MAX_BYTES_CRUDOS es 200 MiB', () => {
    expect(CARGA_MASIVA_MAX_BYTES_CRUDOS).toBe(200 * 1024 * 1024);
  });

  it('CARGA_MASIVA_ARCHIVOS_POR_PETICION es 5 (multer + partirCargaMasivaEnTandas)', () => {
    expect(CARGA_MASIVA_ARCHIVOS_POR_PETICION).toBe(5);
  });

  it('el barrel de shared-types reexporta las seis constantes y partirCargaMasivaEnTandas', () => {
    expect(barrel.CARGA_MASIVA_MAX_ARCHIVOS).toBe(CARGA_MASIVA_MAX_ARCHIVOS);
    expect(barrel.CARGA_MASIVA_MAX_BYTES_ARCHIVO).toBe(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
    expect(barrel.CARGA_MASIVA_MAX_BYTES_CUERPO).toBe(CARGA_MASIVA_MAX_BYTES_CUERPO);
    expect(barrel.CARGA_MASIVA_MAX_BYTES_CRUDOS).toBe(CARGA_MASIVA_MAX_BYTES_CRUDOS);
    expect(barrel.CARGA_MASIVA_ARCHIVOS_POR_PETICION).toBe(CARGA_MASIVA_ARCHIVOS_POR_PETICION);
    expect(barrel.CARGA_MASIVA_MAX_ENTRADAS_ZIP).toBe(CARGA_MASIVA_MAX_ENTRADAS_ZIP);
    expect(barrel.partirCargaMasivaEnTandas).toBe(partirCargaMasivaEnTandas);
  });
});

// HU #12056 — el navegador abre el ZIP y sus entradas viajan por las tandas de 5 que ya existían.
// Eso parte en dos la cantidad admitida: el picker sigue en 50 y el ZIP tiene techo propio. Que
// sean dos números DISTINTOS es la decisión, no un descuido: si alguien los iguala «para
// simplificar», o el ZIP de 90 comprobantes deja de caber, o el picker admite 300 en una sola
// petición. Este bloque fija los dos y su relación.
describe('HU #12056 — techo de entradas de un ZIP abierto en el navegador', () => {
  it('CARGA_MASIVA_MAX_ENTRADAS_ZIP es 300', () => {
    expect(CARGA_MASIVA_MAX_ENTRADAS_ZIP).toBe(300);
  });

  it('el techo del ZIP es MAYOR que el del picker manual: no son el mismo número', () => {
    expect(CARGA_MASIVA_MAX_ENTRADAS_ZIP).toBeGreaterThan(CARGA_MASIVA_MAX_ARCHIVOS);
    expect(CARGA_MASIVA_MAX_ENTRADAS_ZIP).not.toBe(CARGA_MASIVA_MAX_ARCHIVOS);
  });

  it('un ZIP lleno hasta el techo se parte en tandas de 5, todas completas y en orden', () => {
    const entradas = Array.from({ length: CARGA_MASIVA_MAX_ENTRADAS_ZIP }, (_, i) => `SIN MARCA/p${i}.pdf`);
    const tandas = partirCargaMasivaEnTandas(entradas);
    expect(tandas).toHaveLength(CARGA_MASIVA_MAX_ENTRADAS_ZIP / CARGA_MASIVA_ARCHIVOS_POR_PETICION);
    expect(new Set(tandas.map((t) => t.length))).toEqual(new Set([CARGA_MASIVA_ARCHIVOS_POR_PETICION]));
    expect(tandas.flat()).toEqual(entradas);
  });

  it('las entradas del ZIP se parten CON su ruta pegada: la tanda k lleva los pares k, no otros', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      archivo: `p${i}.pdf`,
      ruta: i % 2 === 0 ? `SIN MARCA/p${i}.pdf` : `CON MARCA/p${i}.pdf`,
    }));
    const tandas = partirCargaMasivaEnTandas(items);

    expect(tandas.map((t) => t.length)).toEqual([5, 5, 2]);
    for (const tanda of tandas) {
      for (const item of tanda) {
        expect(item.ruta.endsWith(`/${item.archivo}`)).toBe(true);
      }
    }
    expect(tandas[1].map((i) => i.ruta)).toEqual([
      'CON MARCA/p5.pdf', 'SIN MARCA/p6.pdf', 'CON MARCA/p7.pdf', 'SIN MARCA/p8.pdf', 'CON MARCA/p9.pdf',
    ]);
  });
});

describe('partirCargaMasivaEnTandas — HU #12051', () => {
  it('12 ítems → tandas [5, 5, 2] en el mismo orden', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const tandas = partirCargaMasivaEnTandas(items);
    expect(tandas.map((t) => t.length)).toEqual([5, 5, 2]);
    expect(tandas.flat()).toEqual(items);
  });

  it('7 ítems → [5, 2]', () => {
    const items = Array.from({ length: 7 }, (_, i) => `a${i}`);
    const tandas = partirCargaMasivaEnTandas(items);
    expect(tandas.map((t) => t.length)).toEqual([5, 2]);
    expect(tandas.flat()).toEqual(items);
  });

  it('5 ítems → una tanda', () => {
    expect(partirCargaMasivaEnTandas([1, 2, 3, 4, 5])).toEqual([[1, 2, 3, 4, 5]]);
  });

  it('0 ítems → []', () => {
    expect(partirCargaMasivaEnTandas([])).toEqual([]);
  });
});
