// HU #13207 — compresión de los comprobantes PDF al cargarlos (flito-recibos.compresion.ts).
// Fixtures GENERADOS con pdf-lib aquí mismo (nada binario en el repo). Dos bloques:
//   · unit: `deps.ejecutar` inyectado, sin poppler — reglas del escalón 0, fallos, tiempo, verificación.
//   · integración: pdftotext/pdftoppm reales. Fuera de CI se salta si no hay poppler; EN CI no se salta:
//     si falta el binario los casos fallan (un gate que se salta en verde no es gate).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PDFDocument, PDFName, StandardFonts, degrees,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';
import {
  comprimirComprobante, META_BYTES, MAX_PAGINAS, type DepsCompresion,
} from '../../src/modules/flito-impuestos/flito-recibos.compresion.js';

const hayPoppler = spawnSync('pdftotext', ['-v']).status === 0;
const EN_CI = Boolean(process.env.CI);

const TEXTO = 'Recibo oficial de pago del impuesto vehicular. Placa de prueba, valor total y fecha de pago del contribuyente. '
  + 'Este texto existe para que pdftotext encuentre una capa de texto real, muy por encima del umbral de cuarenta caracteres.';

/** Imagen DeviceGray 8 bpc de ruido (incomprimible) dibujada a página completa. pdf-lib no codifica PNG. */
function pintarRuido(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>, px: number) {
  const stream = doc.context.stream(randomBytes(px * px), {
    Type: 'XObject', Subtype: 'Image', Width: px, Height: px, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  });
  page.node.setXObject(PDFName.of('Im1'), doc.context.register(stream));
  const { width, height } = page.getSize();
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, 0, 0), drawObject('Im1'), popGraphicsState());
}

async function escribirTexto(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  TEXTO.match(/.{1,70}(\s|$)/g)!.forEach((linea, i) => page.drawText(linea.trim(), { x: 40, y: 700 - i * 16, size: 11, font }));
}

const guardarPlano = async (doc: PDFDocument) => Buffer.from(await doc.save({ useObjectStreams: false }));

/** Texto + ruido grande: > 1 MB y el escalón 1 no llega a la meta. Prueba que un PDF con texto no se rasteriza. */
async function fTextoGrande() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  pintarRuido(doc, page, 1200);
  await escribirTexto(doc, page);
  return guardarPlano(doc);
}

/** Texto + ~20 000 objetos pequeños sin object streams: > 1 MB que el escalón 1 sí baja. */
async function fTextoObjetos() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  await escribirTexto(doc, page);
  const refs = Array.from({ length: 20_000 }, (_, i) => doc.context.register(doc.context.obj({ N: i, Pad: `relleno${'x'.repeat(40)}` })));
  doc.catalog.set(PDFName.of('Relleno'), doc.context.obj(refs));
  return guardarPlano(doc);
}

/** Escaneo: página pequeña con una imagen de ruido de 1200×1200 px, SIN texto. */
async function fEscaneo(opts: { tamano?: [number, number]; rotacion?: number; firmado?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(opts.tamano ?? [300, 300]);
  if (opts.rotacion) page.setRotation(degrees(opts.rotacion));
  pintarRuido(doc, page, 1200);
  if (opts.firmado) doc.context.register(doc.context.obj({ Type: 'Sig', ByteRange: [0, 0, 0, 0] }));
  return guardarPlano(doc);
}

/** Más de MAX_PAGINAS páginas y > 1 MB (el relleno es un stream suelto). */
async function fMuchasPaginas() {
  const doc = await PDFDocument.create();
  for (let i = 0; i <= MAX_PAGINAS; i++) doc.addPage([200, 200]);
  doc.catalog.set(PDFName.of('Relleno'), doc.context.register(doc.context.stream(randomBytes(META_BYTES + 10_000), {})));
  return guardarPlano(doc);
}

const textoReal = (buf: Buffer) => spawnSync('pdftotext', ['-layout', '-', '-'], { input: buf }).stdout.toString('utf8');
const pdfEntrada = (buffer: Buffer) => ({ buffer, mimetype: 'application/pdf' });
const restosTmp = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith('flito-comp-'));

/** `ejecutar` inyectado: devuelve texto para pdftotext y registra las llamadas. */
function ejecutarFalso(respuesta: (cmd: string, n: number) => Promise<Buffer>) {
  const llamadas: string[] = [];
  const fn: DepsCompresion['ejecutar'] = vi.fn(async (cmd: string) => { llamadas.push(cmd); return respuesta(cmd, llamadas.length); });
  return { fn, llamadas };
}

let F_TEXTO_GRANDE: Buffer; let F_TEXTO_OBJETOS: Buffer; let F_ESCANEO: Buffer;
beforeAll(async () => {
  [F_TEXTO_GRANDE, F_TEXTO_OBJETOS, F_ESCANEO] = await Promise.all([fTextoGrande(), fTextoObjetos(), fEscaneo()]);
  // Premisas de los fixtures: si dejan de pasar de 1 MB, los casos de abajo serían verdes vacíos.
  for (const f of [F_TEXTO_GRANDE, F_TEXTO_OBJETOS, F_ESCANEO]) expect(f.length).toBeGreaterThan(META_BYTES);
});

// ═════════════════ unit (sin poppler) ═══════════════════════════════════════════════════════════

describe('escalón 0 por regla — el mismo buffer, sin spawn (AC1)', () => {
  it.each([
    ['JPEG', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(META_BYTES * 2)])],
    ['PNG', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(META_BYTES * 2)])],
  ])('%s de 2 MB declarado como application/pdf → NO_PDF por magic bytes', async (_n, buf) => {
    const { fn } = ejecutarFalso(async () => Buffer.from(''));
    const r = await comprimirComprobante(pdfEntrada(buf), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'NO_PDF', bytesAntes: buf.length, bytesDespues: buf.length });
    expect(r.buffer).toBe(buf);
    expect(fn).not.toHaveBeenCalled();
  });

  it('PDF ≤ 1 MB → BAJO_META, idéntico', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    const buf = Buffer.from(await doc.save());
    const { fn } = ejecutarFalso(async () => Buffer.from(''));
    const r = await comprimirComprobante(pdfEntrada(buf), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'BAJO_META' });
    expect(r.buffer).toBe(buf);
    expect(fn).not.toHaveBeenCalled();
  });

  it('PDF firmado de > 1 MB (/Sig + /ByteRange) → FIRMADO, byte a byte', async () => {
    const buf = await fEscaneo({ firmado: true });
    expect(buf.length).toBeGreaterThan(META_BYTES);
    const copia = Buffer.from(buf);
    const { fn } = ejecutarFalso(async () => Buffer.from(''));
    const r = await comprimirComprobante(pdfEntrada(buf), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'FIRMADO' });
    expect(r.buffer.equals(copia)).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('PDF cifrado de > 1 MB (/Encrypt en el trailer) → CIFRADO, byte a byte', async () => {
    const buf = Buffer.from(F_ESCANEO.toString('latin1').replace(/trailer\s*<</, 'trailer\n<< /Encrypt 9999 0 R'), 'latin1');
    expect(buf.includes('/Encrypt')).toBe(true);
    const { fn } = ejecutarFalso(async () => Buffer.from(''));
    const r = await comprimirComprobante(pdfEntrada(buf), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'CIFRADO' });
    expect(r.buffer).toBe(buf);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('fallos → el original, nunca escalón 3 (AC5)', () => {
  it('pdftotext no instalado (ENOENT) → SIN_POPPLER; solo se intentó pdftotext', async () => {
    const { fn, llamadas } = ejecutarFalso(async () => { throw Object.assign(new Error('spawn pdftotext ENOENT'), { code: 'ENOENT' }); });
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'SIN_POPPLER' });
    expect(r.buffer).toBe(F_ESCANEO);
    expect(llamadas).toEqual(['pdftotext']);
  });

  it('pdftotext sale con código ≠ 0 → ERROR; un escaneo NO se rasteriza a ciegas', async () => {
    const { fn, llamadas } = ejecutarFalso(async () => { throw new Error('pdftotext exit 1: Syntax Error'); });
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'ERROR' });
    expect(r.buffer).toBe(F_ESCANEO);
    expect(llamadas).not.toContain('pdftoppm');
  });

  it('el binario no responde dentro del tiempo límite → TIEMPO, el original', async () => {
    const fn: DepsCompresion['ejecutar'] = vi.fn(() => new Promise<Buffer>(() => { /* nunca resuelve */ }));
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO), { ejecutar: fn, tiempoLimiteMs: 50 });
    expect(r).toMatchObject({ escalon: 0, motivo: 'TIEMPO' });
    expect(r.buffer).toBe(F_ESCANEO);
  });

  it('el binario real mata por timeout («cmd: timeout») → TIEMPO', async () => {
    const { fn } = ejecutarFalso(async (cmd) => { throw new Error(`${cmd}: timeout`); });
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO), { ejecutar: fn });
    expect(r.motivo).toBe('TIEMPO');
    expect(r.buffer).toBe(F_ESCANEO);
  });

  it('escalón 1 con texto DISTINTO al original → se descarta el reescrito; con texto, no hay escalón 3', async () => {
    const { fn, llamadas } = ejecutarFalso(async (_c, n) => Buffer.from((n === 1 ? 'A' : 'B').repeat(100)));
    const r = await comprimirComprobante(pdfEntrada(F_TEXTO_OBJETOS), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'VERIFICACION' });
    expect(r.buffer).toBe(F_TEXTO_OBJETOS);
    expect(llamadas).toEqual(['pdftotext', 'pdftotext']);
  });

  it(`más de ${MAX_PAGINAS} páginas → LIMITE_PAGINAS, sin spawn`, async () => {
    const buf = await fMuchasPaginas();
    expect(buf.length).toBeGreaterThan(META_BYTES);
    const { fn } = ejecutarFalso(async () => Buffer.from(''));
    const r = await comprimirComprobante(pdfEntrada(buf), { ejecutar: fn });
    expect(r).toMatchObject({ escalon: 0, motivo: 'LIMITE_PAGINAS' });
    expect(r.buffer).toBe(buf);
    expect(fn).not.toHaveBeenCalled();
  });

  it('bytes que empiezan por %PDF- pero no son un PDF → ERROR, nunca lanza', async () => {
    const buf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(META_BYTES + 10, 0x41)]);
    const r = await comprimirComprobante(pdfEntrada(buf));
    expect(r).toMatchObject({ escalon: 0, motivo: 'ERROR' });
    expect(r.buffer).toBe(buf);
  });
});

describe('semáforo de módulo — máximo 2 compresiones simultáneas', () => {
  it('4 llamadas a la vez: nunca hay más de 2 binarios activos', async () => {
    let activos = 0; let maximo = 0;
    const fn: DepsCompresion['ejecutar'] = async () => {
      activos++; maximo = Math.max(maximo, activos);
      await new Promise((r) => setTimeout(r, 40));
      activos--;
      return Buffer.from('x'.repeat(100));
    };
    const rs = await Promise.all(Array.from({ length: 4 }, () => comprimirComprobante(pdfEntrada(F_TEXTO_GRANDE), { ejecutar: fn })));
    expect(rs).toHaveLength(4);
    expect(maximo).toBe(2);
  });
});

// ═════════════════ integración (poppler real) ═══════════════════════════════════════════════════

describe.runIf(EN_CI)('CI', () => {
  it('trae poppler (pdftotext/pdftoppm): sin él la integración no puede saltarse en verde', () => {
    expect(hayPoppler).toBe(true);
  });
});

describe.skipIf(!hayPoppler && !EN_CI)('integración con poppler real', () => {
  it('AC2/AC3 — PDF con texto y ruido grande: NUNCA escalón 3, no más pesado, texto idéntico', async () => {
    const r = await comprimirComprobante(pdfEntrada(F_TEXTO_GRANDE));
    expect(r.escalon).not.toBe(3);
    expect(r.bytesDespues).toBeLessThanOrEqual(r.bytesAntes);
    expect(r.buffer.length).toBe(r.bytesDespues);
    expect(textoReal(r.buffer)).toBe(textoReal(F_TEXTO_GRANDE));
    expect(textoReal(F_TEXTO_GRANDE).replace(/\s/g, '').length).toBeGreaterThanOrEqual(40); // premisa: tiene texto
  });

  it('AC2 — PDF con texto y muchos objetos: escalón 1 sin pérdida, más liviano, mismo texto y páginas', async () => {
    const r = await comprimirComprobante(pdfEntrada(F_TEXTO_OBJETOS));
    expect(r.escalon).toBe(1);
    expect(r.bytesDespues).toBeLessThan(r.bytesAntes);
    expect(textoReal(r.buffer)).toBe(textoReal(F_TEXTO_OBJETOS));
    expect((await PDFDocument.load(r.buffer)).getPageCount()).toBe(1);
  });

  it('AC3/AC8 — escaneo sin texto: escalón 3, ≤ 1 MB, mismas páginas y mismo tamaño de página; PDF legible', async () => {
    const antes = restosTmp();
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO));
    expect(r).toMatchObject({ escalon: 3, motivo: 'META_ALCANZADA' });
    expect(r.bytesDespues).toBeLessThanOrEqual(META_BYTES);
    expect(r.buffer.length).toBe(r.bytesDespues);
    const doc = await PDFDocument.load(r.buffer);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 300 });
    const dirLegible = await fs.mkdtemp(path.join(os.tmpdir(), 'flito-test-legible-'));
    try { // legible: poppler lo renderiza sin error
      expect(spawnSync('pdftoppm', ['-r', '10', '-png', '-', path.join(dirLegible, 'x')], { input: r.buffer }).status).toBe(0);
    } finally { await fs.rm(dirLegible, { recursive: true, force: true }); }
    expect(restosTmp()).toEqual(antes); // AC: el temporal con PII no queda
  });

  it('AC3 — escaneo rotado 90°: se rearma con ancho y alto intercambiados y sin rotación', async () => {
    const buf = await fEscaneo({ tamano: [300, 200], rotacion: 90 });
    const r = await comprimirComprobante(pdfEntrada(buf));
    expect(r.escalon).toBe(3);
    const pag = (await PDFDocument.load(r.buffer)).getPage(0);
    expect(pag.getSize()).toEqual({ width: 200, height: 300 });
    expect(pag.getRotation().angle).toBe(0);
  });

  it('AC5 — pdftoppm falla después de escribir: se descarta el escalón 3 y el directorio temporal se borra', async () => {
    const antes = restosTmp();
    const { ejecutarBinario } = await import('../../src/modules/flito-ocr/flito-ocr-local.js');
    const fn: DepsCompresion['ejecutar'] = async (cmd, args, input, ms) => {
      if (cmd !== 'pdftoppm') return ejecutarBinario(cmd, args, input, ms);
      await fs.writeFile(`${args[args.length - 1]}-1.jpg`, 'jpeg a medias'); // dentro del mkdtemp
      throw new Error('pdftoppm exit 99: fallo forzado');
    };
    const r = await comprimirComprobante(pdfEntrada(F_ESCANEO), { ejecutar: fn });
    // Sin escalón 3 queda el mejor de {original, escalón 1}: el 1 solo reescribe sin pérdida (unos bytes menos).
    expect(r.escalon).not.toBe(3);
    expect(r.bytesDespues).toBeLessThanOrEqual(r.bytesAntes);
    expect(r.bytesDespues).toBeGreaterThan(META_BYTES);
    expect(restosTmp()).toEqual(antes);
  });

  it('AC4 — ningún escalón llega a la meta: se guarda el más liviano, nunca más pesado que el original', async () => {
    const r = await comprimirComprobante(pdfEntrada(F_TEXTO_GRANDE));
    expect(r.bytesDespues).toBeGreaterThan(META_BYTES);
    expect(r.bytesDespues).toBeLessThanOrEqual(r.bytesAntes);
    expect(['MAS_LIVIANO', 'SIN_MEJORA']).toContain(r.motivo);
    if (r.motivo === 'SIN_MEJORA') expect(r.buffer).toBe(F_TEXTO_GRANDE);
  });
});

// Tabla de medición para el HANDOFF (solo con MEDIR=1; la escribe en MEDIR_OUT si se da).
describe.runIf(hayPoppler && process.env.MEDIR === '1')('medición', () => {
  it('bytes antes/después por fixture', async () => {
    const filas: Record<string, unknown>[] = [];
    for (const [n, b] of [['F-texto-grande', F_TEXTO_GRANDE], ['F-texto-objetos', F_TEXTO_OBJETOS], ['F-escaneo', F_ESCANEO],
      ['F-escaneo-rotado', await fEscaneo({ tamano: [300, 200], rotacion: 90 })], ['F-firmado', await fEscaneo({ firmado: true })]] as const) {
      const t = Date.now(); const r = await comprimirComprobante(pdfEntrada(b));
      filas.push({ fixture: n, antes: r.bytesAntes, despues: r.bytesDespues, escalon: r.escalon, motivo: r.motivo, ms: Date.now() - t });
    }
    if (process.env.MEDIR_OUT) await fs.writeFile(path.resolve(process.env.MEDIR_OUT), JSON.stringify(filas, null, 1));
    expect(filas).toHaveLength(5);
  });
});
