// HU #12610 (Feature #12605, Épica #12245) — `particionar` y `leerSubDocumento` de
// flito-comprobantes.ocr.ts. Cubre AC3 (etapa especializada y fusión por mayor confianza), AC4
// (partición de consolidados con caída a página por documento) y AC5 (OCR caído). `anthropicMessages`
// mockeado como en flito-ocr.service.test.ts; los PDFs se generan aquí con pdf-lib (N páginas con
// el texto «p. k»): sin fixtures binarias y sin PII. El logger se captura para afirmar que ninguna
// línea imprime lo leído (AC2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { CampoComprobante, CampoImpuesto, CampoSoat, TipoDocumentoComprobante } from '@operaciones/shared-types';

process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

/** Todo lo que cualquier módulo escriba en el log, para afirmar que no lleva contenido leído. */
const logLineas: unknown[][] = [];
const logMock = {
  info: (...a: unknown[]) => { logLineas.push(a); }, warn: (...a: unknown[]) => { logLineas.push(a); },
  error: (...a: unknown[]) => { logLineas.push(a); }, debug: (...a: unknown[]) => { logLineas.push(a); },
};
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

const { particionar, leerSubDocumento, gruposDeParticion, fusionarConDestino, MAX_PAGINAS_PARTICION_MODELO } =
  await import('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const {
  PROMPT_COMPROBANTE_UNIVERSAL, PROMPT_PARTICION_CONSOLIDADO, PROMPT_FACTURA_SOAT, PROMPT_RECIBO_IMPUESTO,
  PROMPT_RECIBO_CAJA, PROMPT_DERECHO_TRAMITE,
} = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');
const { MAX_PAGINAS, PdfDemasiadoGrandeError } = await import('../../src/shared/pdf/separar-paginas.js');
const { conConcurrencia } = await import('../../src/shared/utils/con-concurrencia.js');
const { umbralPara } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js');
const { env } = await import('../../src/config/env.js');

// ─────────────────────────── Fixtures y helpers ──────────────────────────────

/**
 * PDF de `n` páginas, cada una con el texto «p. k» y un ancho distinto (200 + k): el texto va
 * comprimido dentro del PDF, así que es el ANCHO lo que permite afirmar qué página quedó en un
 * recorte (un `p` en vez de `p - 1` daría el conteo correcto con las páginas equivocadas).
 */
async function pdfDe(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let k = 1; k <= n; k += 1) doc.addPage([200 + k, 100]).drawText(`p. ${k}`, { x: 10, y: 50, size: 12 });
  return Buffer.from(await doc.save());
}
const paginasDe = async (b: Buffer) => (await PDFDocument.load(b)).getPageCount();
/** Números de página originales que contiene un recorte, deducidos del ancho. */
const numerosDe = async (b: Buffer) => (await PDFDocument.load(b)).getPages().map((pg) => pg.getWidth() - 200);
const { recortarPaginas } = await import('../../src/shared/pdf/separar-paginas.js');
const archivo = (buffer: Buffer, nombre = 'lote.pdf', contentType = 'application/pdf') => ({ nombre, contentType, buffer });

type Crudo = { valor: string | null; confianza: 'alta' | 'media' | 'baja' | null };
const c = (valor: string | null, confianza: Crudo['confianza'] = 'alta'): Crudo => ({ valor, confianza });
const respuesta = (obj: unknown) => ({ ok: true as const, data: { content: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } });
const particion = (documentos: Array<{ paginas: unknown }>, total = 3) => respuesta({ total_paginas: total, documentos });

type Payload = { model: string; max_tokens: number; messages: { content: { type: string; text?: string }[] }[] };
const payloadDe = (n: number) => anthropicMock.mock.calls[n]![0] as Payload;
const promptDeLlamada = (n: number) => payloadDe(n).messages[0]!.content.find((x) => x.type === 'text')!.text!;

/** Lectura universal nítida de un SOAT: no escala. */
const UNIVERSAL_SOAT = {
  tipoDocumento: c('factura_soat'), esComprobantePago: c('true'), concepto: c('soat'),
  placa: c('ABC123'), vin: c('1HGCM82633A123456'), idFlit: c('FLIT-ARHZZ1'),
  valorTotal: c('1234567'), fechaPago: c('2026-09-10'), numeroDocumento: c(null, null), emisor: c('Seguros del Estado'),
};
/** Lectura del extractor de SOAT nítida en todo lo que escala (placa, vin, póliza, valor, aseguradora): UNA llamada. */
const DESTINO_SOAT_NITIDO = {
  placa: c('ABC123'), vin: c('1HGCM82633A123456'), numeroPoliza: c('POL-9'), valorTotal: c('1234500'),
  aseguradora: c('Seguros del Estado'), fechaExpedicion: c('2026-09-09', 'media'), vigenciaDesde: c(null, null), vigenciaHasta: c(null, null),
};
/** La misma con la placa en media: el extractor de SOAT escala a Sonnet (dos llamadas), y sirve para la fusión. */
const DESTINO_SOAT = { ...DESTINO_SOAT_NITIDO, placa: c('ABC124', 'media') };
const sub = (buffer = Buffer.from('%PDF-x'), contentType = 'application/pdf') => ({ buffer, contentType, paginas: null, nombre: 'doc.pdf' });

beforeEach(() => { anthropicMock.mockReset(); logLineas.length = 0; });

// ─────────────────────────── AC4 — partición ─────────────────────────────────

describe('AC4 — particionar: imagen o PDF de una página es UN documento sin llamar al modelo', () => {
  it('imagen (JPEG/PNG/WEBP) → un sub-documento con paginas null, el mismo buffer y cero llamadas', async () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp']) {
      const buffer = Buffer.from('imagen');
      const r = await particionar(archivo(buffer, 'foto.jpg', ct));
      expect(r.metodo).toBe('unico');
      expect(r.documentos).toHaveLength(1);
      expect(r.documentos[0]).toEqual({ buffer, contentType: ct, paginas: null, nombre: 'foto.jpg' });
      expect(r.documentos[0]!.buffer).toBe(buffer);
      expect(r.paginasNoLeidas).toEqual([]);
    }
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('PDF de una página → un sub-documento con paginas null, sin reserializar y sin llamadas', async () => {
    const buffer = await pdfDe(1);
    const r = await particionar(archivo(buffer));
    expect(r.metodo).toBe('unico');
    expect(r.documentos).toHaveLength(1);
    expect(r.documentos[0]!.paginas).toBeNull();
    expect(r.documentos[0]!.buffer).toBe(buffer);
    expect(anthropicMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — particionar: consolidado de 2..100 páginas con pasada de partición', () => {
  it('una pasada Haiku con PROMPT_PARTICION_CONSOLIDADO y max_tokens 2000, sin escalación; grupos → PDFs recortados con paginas base 1', async () => {
    anthropicMock.mockResolvedValueOnce(particion([{ paginas: [1, 2] }, { paginas: [3] }]));

    const r = await particionar(archivo(await pdfDe(3)));

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(payloadDe(0).model).toBe(env.ANTHROPIC_MODEL_HAIKU);
    expect(payloadDe(0).max_tokens).toBe(2000);
    expect(promptDeLlamada(0)).toBe(PROMPT_PARTICION_CONSOLIDADO);
    expect(r.metodo).toBe('modelo');
    expect(r.documentos.map((d) => d.paginas)).toEqual([[1, 2], [3]]);
    expect(r.documentos.map((d) => d.nombre)).toEqual(['lote - págs 1-2.pdf', 'lote - pág 3.pdf']);
    expect(await numerosDe(r.documentos[0]!.buffer)).toEqual([1, 2]);
    expect(await numerosDe(r.documentos[1]!.buffer)).toEqual([3]);
    expect(r.documentos.every((d) => d.contentType === 'application/pdf')).toBe(true);
    expect(r.paginasNoLeidas).toEqual([]);
  });

  it('los grupos salen ordenados por primera página y con sus páginas ascendentes, aunque el modelo los devuelva desordenados', async () => {
    anthropicMock.mockResolvedValueOnce(particion([{ paginas: [4, 3] }, { paginas: ['1'] }], 4));

    const r = await particionar(archivo(await pdfDe(4)));

    expect(r.documentos.map((d) => d.paginas)).toEqual([[1], [3, 4]]);
  });

  it('las páginas que ningún grupo cubre se anotan como no leídas (portada/resumen) y no generan documento', async () => {
    anthropicMock.mockResolvedValueOnce(particion([{ paginas: [2] }, { paginas: [3, 4] }], 5));

    const r = await particionar(archivo(await pdfDe(5)));

    expect(r.metodo).toBe('modelo');
    expect(r.documentos.map((d) => d.paginas)).toEqual([[2], [3, 4]]);
    expect(await numerosDe(r.documentos[0]!.buffer)).toEqual([2]);
    expect(await numerosDe(r.documentos[1]!.buffer)).toEqual([3, 4]);
    expect(r.paginasNoLeidas).toEqual([1, 5]);
  });

  it('recortarPaginas: devuelve exactamente las páginas pedidas (base 1), sin tope de 20, y lanza ante una fuera de rango', async () => {
    const pdf = await pdfDe(25);
    expect(await numerosDe(await recortarPaginas(pdf, [3]))).toEqual([3]);
    expect(await numerosDe(await recortarPaginas(pdf, Array.from({ length: 25 }, (_, i) => i + 1)))).toHaveLength(25);
    await expect(recortarPaginas(pdf, [26])).rejects.toBeInstanceOf(RangeError);
    await expect(recortarPaginas(pdf, [0])).rejects.toBeInstanceOf(RangeError);
    await expect(recortarPaginas(pdf, [])).rejects.toBeInstanceOf(RangeError);
  });

  // Mutante nombrado (diseño, QA (5)): quitar la caída a `separarPaginas` cuando la partición no
  // parsea → el consolidado de 3 páginas se leería como UN solo documento; aquí se exigen 3.
  it('respuesta no parseable → cae a una página por documento: 3 sub-documentos, no 1', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta('lo siento, no puedo delimitar este archivo'));

    const r = await particionar(archivo(await pdfDe(3)));

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r.metodo).toBe('por_pagina');
    expect(r.documentos).toHaveLength(3);
    expect(r.documentos.map((d) => d.paginas)).toEqual([[1], [2], [3]]);
    expect(r.documentos.map((d) => d.nombre)).toEqual(['lote - pág 1.pdf', 'lote - pág 2.pdf', 'lote - pág 3.pdf']);
    expect(await Promise.all(r.documentos.map((d) => numerosDe(d.buffer)))).toEqual([[1], [2], [3]]);
    expect(r.paginasNoLeidas).toEqual([]);
  });

  it.each([
    ['grupos solapados', [{ paginas: [1, 2] }, { paginas: [2, 3] }]],
    ['página fuera de rango (4 en un PDF de 3)', [{ paginas: [1] }, { paginas: [4] }]],
    ['página 0', [{ paginas: [0, 1] }]],
    ['página no entera', [{ paginas: [1.5] }]],
    ['grupo vacío', [{ paginas: [] }, { paginas: [2] }]],
    ['sin documentos', []],
  ])('%s → cae a una página por documento', async (_caso, documentos) => {
    anthropicMock.mockResolvedValueOnce(particion(documentos));

    const r = await particionar(archivo(await pdfDe(3)));

    expect(r.metodo).toBe('por_pagina');
    expect(r.documentos.map((d) => d.paginas)).toEqual([[1], [2], [3]]);
  });

  it('gruposDeParticion es puro: null ante JSON sin `documentos` o no objeto', () => {
    expect(gruposDeParticion(null, 3)).toBeNull();
    expect(gruposDeParticion({ total_paginas: 3 }, 3)).toBeNull();
    expect(gruposDeParticion({ documentos: 'x' }, 3)).toBeNull();
    expect(gruposDeParticion({ documentos: [{ paginas: [2] }, { paginas: [1] }] }, 3)).toEqual([[1], [2]]);
  });
});

describe('AC4 — particionar: topes de páginas', () => {
  it(`PDF de ${MAX_PAGINAS_PARTICION_MODELO + 1} páginas → una página por documento SIN pasada de partición`, async () => {
    const r = await particionar(archivo(await pdfDe(MAX_PAGINAS_PARTICION_MODELO + 1)));

    expect(anthropicMock).not.toHaveBeenCalled();
    expect(r.metodo).toBe('por_pagina');
    expect(r.documentos).toHaveLength(MAX_PAGINAS_PARTICION_MODELO + 1);
    expect(r.documentos[100]!.paginas).toEqual([101]);
  }, 30_000);

  it(`PDF de exactamente ${MAX_PAGINAS_PARTICION_MODELO} páginas sí pasa por el modelo`, async () => {
    anthropicMock.mockResolvedValueOnce(particion([{ paginas: Array.from({ length: MAX_PAGINAS_PARTICION_MODELO }, (_, i) => i + 1) }], 100));

    const r = await particionar(archivo(await pdfDe(MAX_PAGINAS_PARTICION_MODELO)));

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r.metodo).toBe('modelo');
    expect(r.documentos).toHaveLength(1);
    expect(await paginasDe(r.documentos[0]!.buffer)).toBe(100);
  }, 30_000);

  it(`PDF de más de ${MAX_PAGINAS} páginas → PdfDemasiadoGrandeError sin llamar al modelo`, async () => {
    await expect(particionar(archivo(await pdfDe(MAX_PAGINAS + 1)))).rejects.toBeInstanceOf(PdfDemasiadoGrandeError);
    expect(anthropicMock).not.toHaveBeenCalled();
  }, 30_000);
});

// ─────────────────────────── AC3 — especializada y fusión ────────────────────

describe('AC3 — leerSubDocumento: etapa especializada solo con tipo confiable de los cuatro', () => {
  it('factura_soat confiable → llama a extraerFacturaSoat UNA vez y devuelve extraccionDestino en su forma nativa', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta(UNIVERSAL_SOAT)).mockResolvedValueOnce(respuesta(DESTINO_SOAT_NITIDO));

    const r = await leerSubDocumento(sub());

    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(promptDeLlamada(0)).toBe(PROMPT_COMPROBANTE_UNIVERSAL);
    expect(promptDeLlamada(1)).toBe(PROMPT_FACTURA_SOAT);
    expect(r.tipoDestino).toBe(TipoDocumentoComprobante.FACTURA_SOAT);
    expect(Object.keys(r.extraccionDestino!).sort()).toEqual(Object.values(CampoSoat).sort());
    expect((r.extraccionDestino as Record<string, unknown>)[CampoSoat.NUMERO_POLIZA]).toEqual({ valor: 'POL-9', confianza: 0.95, confiable: true });
    expect(r.extraccion).not.toHaveProperty(CampoSoat.NUMERO_POLIZA);
  });

  // Mutante: invertir el comparador (`<` o `<=` en vez de `>`) → la placa 'media' del destino
  // pisaría la 'alta' de la universal y el valor 'alta' del destino no entraría.
  it('fusiona hacia la universal SOLO cuando el destino trae MAYOR confianza: universal alta + destino media → se queda la universal', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta(UNIVERSAL_SOAT))
      .mockResolvedValueOnce(respuesta(DESTINO_SOAT))  // Haiku del SOAT: placa media → escala
      .mockResolvedValueOnce(respuesta(DESTINO_SOAT)); // Sonnet del SOAT: sigue media

    const { extraccion } = await leerSubDocumento(sub());

    expect(anthropicMock).toHaveBeenCalledTimes(3);

    // placa: universal ABC123 (alta) vs destino ABC124 (media) → universal.
    expect(extraccion[CampoComprobante.PLACA]).toEqual({ valor: 'ABC123', confianza: 0.95, confiable: true });
    // fechaPago: universal 2026-09-10 (alta) vs fechaExpedicion 2026-09-09 (media) → universal.
    expect(extraccion[CampoComprobante.FECHA_PAGO]).toEqual({ valor: '2026-09-10', confianza: 0.95, confiable: true });
    // valorTotal: empate alta/alta → se queda la universal (el destino no gana en empate).
    expect(extraccion[CampoComprobante.VALOR_TOTAL]).toEqual({ valor: '1234567', confianza: 0.95, confiable: true });
    // numeroDocumento: universal null (0) vs numeroPoliza alta → destino.
    expect(extraccion[CampoComprobante.NUMERO_DOCUMENTO]).toEqual({ valor: 'POL-9', confianza: 0.95, confiable: true });
    // Los que no tienen correspondencia no se tocan.
    expect(extraccion[CampoComprobante.ID_FLIT]).toEqual({ valor: 'FLIT-ARHZZ1', confianza: 0.95, confiable: true });
    expect(extraccion[CampoComprobante.TIPO_DOCUMENTO]!.valor).toBe('factura_soat');
  });

  it('destino con mayor confianza sustituye; destino sin el campo (null) nunca borra lo leído', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, valorTotal: c('1234567', 'media'), vin: c('1HGCM82633A123456', 'media') }))
      .mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, valorTotal: c('1234567', 'media'), vin: c('1HGCM82633A123456', 'media') })) // Sonnet
      .mockResolvedValueOnce(respuesta({ ...DESTINO_SOAT_NITIDO, vin: c(null, null) }))  // Haiku del SOAT: vin null → escala
      .mockResolvedValueOnce(respuesta({ ...DESTINO_SOAT_NITIDO, vin: c(null, null) })); // Sonnet del SOAT

    const { extraccion } = await leerSubDocumento(sub());

    expect(anthropicMock).toHaveBeenCalledTimes(4);
    expect(extraccion[CampoComprobante.VALOR_TOTAL]).toEqual({ valor: '1234500', confianza: 0.95, confiable: true });
    expect(extraccion[CampoComprobante.VIN]).toEqual({ valor: '1HGCM82633A123456', confianza: 0.6, confiable: false });
  });

  it('fusionarConDestino es pura: no muta la universal y copia el campo del destino', () => {
    const universal = { [CampoComprobante.PLACA]: { valor: 'ABC123', confianza: 0.6, confiable: false } };
    const destino = { [CampoSoat.PLACA]: { valor: 'ABC124', confianza: 0.95, confiable: true } };
    const r = fusionarConDestino(universal, destino, { [CampoComprobante.PLACA]: CampoSoat.PLACA });
    expect(r[CampoComprobante.PLACA]).toEqual({ valor: 'ABC124', confianza: 0.95, confiable: true });
    expect(r[CampoComprobante.PLACA]).not.toBe(destino[CampoSoat.PLACA]);
    expect(universal[CampoComprobante.PLACA]!.valor).toBe('ABC123');
  });

  it.each([
    [TipoDocumentoComprobante.RECIBO_IMPUESTO, PROMPT_RECIBO_IMPUESTO, { placa: c('ABC123'), valorTotal: c('500000'), numeroRecibo: c('R-1'), fechaPago: c('2026-09-01'), anioGravable: c('2026') }, CampoImpuesto.NUMERO_RECIBO],
    [TipoDocumentoComprobante.RECIBO_CAJA_IMPUESTO, PROMPT_RECIBO_CAJA, { valorTotal: c('500000'), numeroRecibo: c('RC-778'), fechaPago: c('2026-09-01') }, CampoImpuesto.NUMERO_RECIBO],
    [TipoDocumentoComprobante.RECIBO_DERECHO, PROMPT_DERECHO_TRAMITE, { placa: c('ABC123'), valorTotal: c('90000'), numeroRadicado: c('RAD-5'), fechaPago: c('2026-09-01'), organismo: c('BELLO'), tipoTramite: c('TRASPASO') }, 'numeroRadicado'],
  ])('%s confiable → el extractor de siempre (%s) una sola vez y numeroDocumento ↔ su número nativo', async (tipo, prompt, destino, campoNumero) => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, tipoDocumento: c(tipo), concepto: c('impuesto') }))
      .mockResolvedValueOnce(respuesta(destino));

    const r = await leerSubDocumento(sub());

    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(promptDeLlamada(1)).toBe(prompt);
    expect(r.tipoDestino).toBe(tipo);
    expect((r.extraccionDestino as Record<string, { valor: string | null }>)[campoNumero]!.valor).toBe(destino[campoNumero as keyof typeof destino]!.valor);
    expect(r.extraccion[CampoComprobante.NUMERO_DOCUMENTO]!.valor).toBe(destino[campoNumero as keyof typeof destino]!.valor);
  });

  it('tipo fuera de los cuatro (factura_servicio, alta) → sin segunda llamada; extraccionDestino null', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, tipoDocumento: c('factura_servicio'), concepto: c('logistica') }));

    const r = await leerSubDocumento(sub());

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r.tipoDestino).toBeNull();
    expect(r.extraccionDestino).toBeNull();
    expect(r.extraccion[CampoComprobante.TIPO_DOCUMENTO]!.valor).toBe('factura_servicio');
  });

  it('tipo NO confiable (media con el umbral por defecto umbralPara(null)) → solo las llamadas de la universal (Haiku + Sonnet), ninguna especializada', async () => {
    anthropicMock.mockResolvedValue(respuesta({ ...UNIVERSAL_SOAT, tipoDocumento: c('factura_soat', 'media') }));

    const r = await leerSubDocumento(sub());

    expect(umbralPara(null)).toBeGreaterThan(0.6);
    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(r.tipoDestino).toBeNull();
    expect(r.extraccionDestino).toBeNull();
    expect(r.extraccion[CampoComprobante.TIPO_DOCUMENTO]).toEqual({ valor: 'factura_soat', confianza: 0.6, confiable: false });
  });

  it('el umbral que se pasa manda: con 0.5, media es confiable y sí corre la especializada', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, tipoDocumento: c('factura_soat', 'media') }))
      .mockResolvedValueOnce(respuesta({ ...UNIVERSAL_SOAT, tipoDocumento: c('factura_soat', 'media') }))
      .mockResolvedValueOnce(respuesta(DESTINO_SOAT_NITIDO));

    const r = await leerSubDocumento(sub(), 0.5);

    expect(anthropicMock).toHaveBeenCalledTimes(3);
    expect(r.tipoDestino).toBe('factura_soat');
  });

  it('AC2 — ninguna línea del log lleva lo leído (placa, VIN, ID FLIT, valor, número)', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta(UNIVERSAL_SOAT)).mockResolvedValueOnce(respuesta(DESTINO_SOAT_NITIDO));

    await leerSubDocumento(sub());

    expect(logLineas.length).toBeGreaterThan(0);
    const todo = JSON.stringify(logLineas);
    expect(todo).not.toMatch(/ABC12[34]|1HGCM82633A123456|FLIT-ARHZZ1|123456[7]|1234500|POL-9|Seguros del Estado/);
  });
});

// ─────────────────────────── AC5 — OCR caído ─────────────────────────────────

describe('AC5 — el OCR caído no rompe la lectura', () => {
  it.each([[503, 'Servicio de IA no configurado'], [429, 'rate limit']])(
    'anthropicMessages no-200 (%s) → leerSubDocumento lanza OcrNoDisponibleError con ese status',
    async (status, message) => {
      anthropicMock.mockResolvedValue({ ok: false, status, message });

      const error = await leerSubDocumento(sub()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OcrNoDisponibleError);
      expect((error as InstanceType<typeof OcrNoDisponibleError>).status).toBe(status);
    },
  );

  it('dentro de conConcurrencia el error sale como OcrNoDisponibleError y no deja la promesa colgada', async () => {
    anthropicMock.mockResolvedValue({ ok: false, status: 503, message: 'caído' });

    await expect(conConcurrencia([sub(), sub(), sub()], 2, (s) => leerSubDocumento(s))).rejects.toBeInstanceOf(OcrNoDisponibleError);
  });

  it('la especializada caída también sale como OcrNoDisponibleError (no se devuelve una lectura a medias)', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta(UNIVERSAL_SOAT)).mockResolvedValueOnce({ ok: false, status: 503, message: 'caído' });

    await expect(leerSubDocumento(sub())).rejects.toBeInstanceOf(OcrNoDisponibleError);
  });

  // Mutante: propagar el error de `particionConsolidado` en vez de caer → esto rechazaría con
  // OcrNoDisponibleError; se exigen 3 sub-documentos.
  it('la partición con OCR caído NO lanza: cae a una página por documento', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'caído' });

    const r = await particionar(archivo(await pdfDe(3)));

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r.metodo).toBe('por_pagina');
    expect(r.documentos).toHaveLength(3);
    expect(r.documentos.map((d) => d.paginas)).toEqual([[1], [2], [3]]);
  });

  it('la partición con el mock rechazando (excepción de red) tampoco lanza', async () => {
    anthropicMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const r = await particionar(archivo(await pdfDe(2)));

    expect(r.metodo).toBe('por_pagina');
    expect(r.documentos).toHaveLength(2);
  });
});
