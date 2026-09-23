// FLITO — un PDF por registro (HU #12817, AC1-AC5): `consolidarPdf` y `consolidarPorRegistro` sin HTTP.
//
// Sin mocks de pdf-lib: los documentos son PDFs e imágenes REALES (`helpers/pdf-firma.ts`) y lo que
// se afirma se lee del PDF producido. Cada tipo lleva un ancho de página distinto que funciona de
// firma: factura 3 páginas de 100, recibo 1 de 200, comprobante SOAT 2 de 300. Así un aserto de
// anchos cubre a la vez el ORDEN, el NÚMERO de páginas y que no sobre ni falte ninguna.

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { env } from '../../src/config/env.js';
import {
  consolidarPdf, consolidarPorRegistro,
} from '../../src/shared/soportes/soportes-zip-consolidar.js';
import {
  ZipDemasiadoGrandeError, ZipSinSoportesError, type EntradaZip,
} from '../../src/shared/soportes/soportes-zip.js';
import { anchosDe, JPEG_1X1, pdfCifrado, pdfFirma, png, tamanosDe } from '../helpers/pdf-firma.js';

let FACTURA: Buffer;
let RECIBO: Buffer;
let SOAT: Buffer;
let CIFRADO: Buffer;

beforeAll(async () => {
  FACTURA = await pdfFirma([100, 100, 100]);
  RECIBO = await pdfFirma([200]);
  SOAT = await pdfFirma([300, 300]);
  CIFRADO = await pdfCifrado([250]);
});

const A4_CORTO = 595;
const A4_LARGO = 842;

describe('consolidarPdf — AC1/AC2: todas las páginas, en el orden recibido', () => {
  it('factura → recibo → SOAT da [100,100,100,200,300,300]', async () => {
    const r = await consolidarPdf([FACTURA, RECIBO, SOAT]);
    expect(await anchosDe(r.pdf!)).toEqual([100, 100, 100, 200, 300, 300]);
    expect(r).toMatchObject({ incluidos: 3, omitidos: 0, cifrados: [] });
  });

  it('un solo documento también sale como PDF consolidado', async () => {
    const r = await consolidarPdf([RECIBO]);
    expect(await anchosDe(r.pdf!)).toEqual([200]);
    expect(r.incluidos).toBe(1);
  });
});

describe('consolidarPdf — AC3: lo que falte no deja página vacía', () => {
  it('sin recibo da [100,100,100,300,300], exactamente cinco páginas', async () => {
    const r = await consolidarPdf([FACTURA, SOAT]);
    expect(await anchosDe(r.pdf!)).toEqual([100, 100, 100, 300, 300]);
  });
});

describe('consolidarPdf — AC4: una imagen es UNA página A4 entera', () => {
  it('PNG apaisado (40×20) → una página A4 horizontal, con la imagen dentro', async () => {
    const r = await consolidarPdf([png(40, 20), RECIBO]);
    expect(await tamanosDe(r.pdf!)).toEqual([{ w: A4_LARGO, h: A4_CORTO }, { w: 200, h: 200 }]);
    // La página lleva un XObject de imagen: no es una hoja en blanco del tamaño correcto.
    const doc = await PDFDocument.load(r.pdf!);
    const recursos = doc.getPages()[0]!.node.Resources()!.toString();
    expect(recursos).toContain('/XObject');
    expect(r.incluidos).toBe(2);
  });

  it('PNG vertical → A4 vertical', async () => {
    const r = await consolidarPdf([png(20, 40)]);
    expect(await tamanosDe(r.pdf!)).toEqual([{ w: A4_CORTO, h: A4_LARGO }]);
  });

  it('JPEG, detectado por BYTES → una página A4', async () => {
    const r = await consolidarPdf([FACTURA, JPEG_1X1]);
    expect(await anchosDe(r.pdf!)).toEqual([100, 100, 100, A4_CORTO]);
    expect(r.incluidos).toBe(2);
  });
});

describe('consolidarPdf — AC5: lo dañado se omite y se cuenta', () => {
  it('basura y un `%PDF-` truncado se omiten; el resto se consolida', async () => {
    const truncado = FACTURA.subarray(0, 40);
    const r = await consolidarPdf([FACTURA, Buffer.from('basura que no es nada'), truncado, SOAT]);
    expect(await anchosDe(r.pdf!)).toEqual([100, 100, 100, 300, 300]);
    expect(r).toMatchObject({ incluidos: 2, omitidos: 2 });
  });

  it('`%PDF-1.4 basura` (cabecera de PDF, cuerpo roto) cuenta como omitido', async () => {
    const r = await consolidarPdf([Buffer.from('%PDF-1.4 basura'), RECIBO]);
    expect(await anchosDe(r.pdf!)).toEqual([200]);
    expect(r.omitidos).toBe(1);
  });

  it('todo ilegible → `pdf: null`', async () => {
    const r = await consolidarPdf([Buffer.from('x'), Buffer.from('%PDF-roto')]);
    expect(r.pdf).toBeNull();
    expect(r).toMatchObject({ incluidos: 0, omitidos: 2 });
  });
});

describe('consolidarPdf — PDF cifrado: aparte, bytes intactos, NO omitido', () => {
  it('el fixture cifrado es de verdad lo que pdf-lib rechaza', async () => {
    await expect(PDFDocument.load(CIFRADO)).rejects.toThrow(/encrypted/i);
  });

  it('el cifrado sale en `cifrados` con sus bytes, y el resto se consolida sin él', async () => {
    const r = await consolidarPdf([FACTURA, CIFRADO, SOAT]);
    expect(await anchosDe(r.pdf!)).toEqual([100, 100, 100, 300, 300]);
    expect(r.cifrados).toHaveLength(1);
    expect(r.cifrados[0]!.equals(CIFRADO)).toBe(true);
    expect(r).toMatchObject({ incluidos: 2, omitidos: 0 });
  });

  it('solo cifrados → sin consolidado, los originales aparte', async () => {
    const r = await consolidarPdf([CIFRADO]);
    expect(r.pdf).toBeNull();
    expect(r.cifrados).toHaveLength(1);
    expect(r.omitidos).toBe(0);
  });
});

// ── consolidarPorRegistro: agrupar, nombrar, volcar a disco, limpiar ────────────────────────────

/** Una entrada como las de `resolverEntradasZip`, con contenido en memoria. */
function entrada(registroId: string, placa: string, contenido: Buffer | Error, bytes = 1024): EntradaZip {
  return {
    nombreBase: placa, nombreRegistro: placa, tipo: 'factura_soat', registroId, bytes,
    abrir: async () => {
      if (contenido instanceof Error) throw contenido;
      return { stream: Readable.from([contenido]), extension: 'pdf' };
    },
  };
}

async function leer(e: EntradaZip): Promise<Buffer> {
  const { stream } = await e.abrir();
  const trozos: Buffer[] = [];
  for await (const c of stream) trozos.push(c as Buffer);
  return Buffer.concat(trozos);
}

const temporales = (): string[] => readdirSync(os.tmpdir()).filter((n) => n.startsWith('flito-zip-'));

describe('consolidarPorRegistro', () => {
  it('un PDF por registro; misma placa entre registros → `-2` en el orden recibido', async () => {
    const zc = await consolidarPorRegistro([
      entrada('r1', 'ABC123', FACTURA), entrada('r1', 'ABC123', RECIBO),
      entrada('r2', 'ABC123', SOAT),
      entrada('r3', 'XYZ789', RECIBO),
    ]);
    try {
      expect(zc.entradas.map((e) => e.nombreBase)).toEqual(['ABC123', 'ABC123-2', 'XYZ789']);
      expect(await anchosDe(await leer(zc.entradas[0]!))).toEqual([100, 100, 100, 200]);
      expect(await anchosDe(await leer(zc.entradas[1]!))).toEqual([300, 300]);
      expect(zc).toMatchObject({ incluidos: 4, omitidos: 0 });
    } finally {
      await zc.limpiar();
    }
  });

  it('un documento que no se puede leer (FLIT/MinIO caído) cuenta como omitido', async () => {
    const zc = await consolidarPorRegistro([
      entrada('r1', 'ABC123', new Error('FLIT respondió 502')), entrada('r1', 'ABC123', RECIBO),
    ]);
    try {
      expect(zc).toMatchObject({ incluidos: 1, omitidos: 1 });
      expect(await anchosDe(await leer(zc.entradas[0]!))).toEqual([200]);
    } finally {
      await zc.limpiar();
    }
  });

  it('cifrado: `PLACA` consolidado y el original aparte como `PLACA-2`, bytes intactos', async () => {
    const zc = await consolidarPorRegistro([
      entrada('r1', 'ABC123', FACTURA), entrada('r1', 'ABC123', CIFRADO),
      entrada('r2', 'XYZ789', CIFRADO), entrada('r2', 'XYZ789', CIFRADO),
    ]);
    try {
      expect(zc.entradas.map((e) => e.nombreBase)).toEqual(['ABC123', 'ABC123-2', 'XYZ789', 'XYZ789-2']);
      expect(await anchosDe(await leer(zc.entradas[0]!))).toEqual([100, 100, 100]);
      expect((await leer(zc.entradas[1]!)).equals(CIFRADO)).toBe(true);
      // Solo cifrados: sin consolidado vacío, los originales con `PLACA` y `PLACA-2`.
      expect((await leer(zc.entradas[2]!)).equals(CIFRADO)).toBe(true);
      expect(zc).toMatchObject({ incluidos: 4, omitidos: 0 });
    } finally {
      await zc.limpiar();
    }
  });

  it('el temporal existe mientras se emite y `limpiar()` lo borra', async () => {
    const antes = temporales();
    const zc = await consolidarPorRegistro([entrada('r1', 'ABC123', RECIBO)]);
    const nuevos = temporales().filter((n) => !antes.includes(n));
    expect(nuevos).toHaveLength(1);
    await zc.limpiar();
    expect(existsSync(`${os.tmpdir()}/${nuevos[0]}`)).toBe(false);
  });

  it('nada legible → `ZipSinSoportesError` y el temporal ya borrado', async () => {
    const antes = temporales();
    await expect(consolidarPorRegistro([
      entrada('r1', 'ABC123', Buffer.from('basura')), entrada('r2', 'XYZ789', new Error('caído')),
    ])).rejects.toBeInstanceOf(ZipSinSoportesError);
    expect(temporales()).toEqual(antes);
  });

  it('AC8: los bytes REALES por encima del tope → `ZipDemasiadoGrandeError`, temporal borrado', async () => {
    const tope = env.FLITO_ZIP_SOPORTES_MAX_BYTES;
    const cupo = env.FLITO_ZIP_FACTURA_CUPO_BYTES;
    env.FLITO_ZIP_SOPORTES_MAX_BYTES = 3000;
    env.FLITO_ZIP_FACTURA_CUPO_BYTES = 1000;
    const antes = temporales();
    try {
      // Cada uno cabe en su tope por documento (2 × 1000); juntos (3600) no caben en el lote.
      await expect(consolidarPorRegistro([
        entrada('r1', 'ABC123', Buffer.alloc(1800, 0x25), 1000),
        entrada('r2', 'XYZ789', Buffer.alloc(1800, 0x25), 1000),
      ])).rejects.toBeInstanceOf(ZipDemasiadoGrandeError);
      expect(temporales()).toEqual(antes);
    } finally {
      env.FLITO_ZIP_SOPORTES_MAX_BYTES = tope;
      env.FLITO_ZIP_FACTURA_CUPO_BYTES = cupo;
    }
  });
});
