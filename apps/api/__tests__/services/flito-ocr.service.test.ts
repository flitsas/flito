// FLITO OCR — motor de extracción. Verifica el CONTRATO y las REGLAS (mapeo de confianza, umbral,
// normalización, doble pasada, degradación), no la calidad del OCR: `anthropicMessages` está
// mockeado (los tests corren sin red ni API key). La calidad real del prompt se mide aparte con
// golden fixtures + ANTHROPIC_API_KEY (§8.4). Ver docs/MIGRACION_FLITO_A_OPERACIONES.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CampoImpuesto, CAMPO_IMPUESTO_LABEL } from '@operaciones/shared-types';

// Aísla el test de los flags de demo del .env (dotenv los carga vía env.ts): OCR_STUB=0 evita el stub.
// OCR_LOCAL ya no gobierna el fallback (Bug #14229); se deja en 0 para no confundir lecturas viejas.
// Key de prueba: sin ella extraer() iría siempre al local (Bug #14229) y no ejercitaría Anthropic.
process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'sk-ant-test-ocr-fallback';

const anthropicMock = vi.fn();
const textoDocumentoMock = vi.fn();
const camposDesdeTextoMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));
vi.mock('../../src/modules/flito-ocr/flito-ocr-local.js', () => ({
  textoDocumento: (...args: unknown[]) => textoDocumentoMock(...args),
  camposDesdeTexto: (...args: unknown[]) => camposDesdeTextoMock(...args),
}));

const {
  extraerFacturaSoat, extraerReciboImpuesto, extraerVehiculoFacturaVenta,
  placaDesdeNombre, normalizarPesos, normalizarFecha, OcrNoDisponibleError,
} = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { env } = await import('../../src/config/env.js');
const { PROMPT_RECIBO_IMPUESTO, PROMPT_RECIBO_CAJA, PROMPT_FACTURA_VENTA_VEHICULO } = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');

// Si el .env del worktree no trae key, forzamos una de prueba (mismo objeto que usa el service).
if (!env.ANTHROPIC_API_KEY) {
  (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = 'sk-ant-test-ocr-fallback';
}

/** Encola una respuesta OK de Anthropic con el JSON dado como texto del content. */
function respuesta(obj: Record<string, unknown>) {
  return { ok: true as const, data: { content: [{ text: JSON.stringify(obj) }] } };
}

const doc = (extra?: Partial<{ nombreArchivo: string; contentType: string; umbral: number }>) => ({
  nombreArchivo: extra?.nombreArchivo ?? 'factura.pdf',
  contentType: extra?.contentType ?? 'application/pdf',
  contenido: Buffer.from('%PDF-fake'),
  umbral: extra?.umbral ?? 0.85,
});

/** Key de prueba: beforeEach la restaura por si un caso la borró (ruta «sin API key»). */
const API_KEY_TEST = env.ANTHROPIC_API_KEY!;

beforeEach(() => {
  anthropicMock.mockReset();
  textoDocumentoMock.mockReset();
  camposDesdeTextoMock.mockReset();
  (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = API_KEY_TEST;
});

/** Campos mínimos del fallback local para una factura SOAT (solo lo que el aserto mira). */
function crudoLocalSoat(placa = 'QTQ100', valorTotal = '634900') {
  return {
    placa: { valor: placa, confianza: 'media' as const },
    vin: { valor: null, confianza: null },
    numeroPoliza: { valor: 'P-LOCAL', confianza: 'baja' as const },
    valorTotal: { valor: valorTotal, confianza: 'media' as const },
    aseguradora: { valor: 'SURA', confianza: 'baja' as const },
    fechaExpedicion: { valor: null, confianza: null },
    vigenciaDesde: { valor: null, confianza: null },
    vigenciaHasta: { valor: null, confianza: null },
  };
}

describe('flito-ocr — mapeo de confianza y umbral', () => {
  it('todos alta → una sola pasada (Haiku), campos confiables y normalizados', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      placa: { valor: 'qtq100', confianza: 'alta' },
      vin: { valor: '9BWZZZ377VT004251', confianza: 'alta' },
      numeroPoliza: { valor: 'FLIT-ARHZZ1', confianza: 'alta' },
      valorTotal: { valor: '$1.234.567,89', confianza: 'alta' },
      aseguradora: { valor: 'Seguros del Estado', confianza: 'alta' },
      fechaExpedicion: { valor: '2026-07-09', confianza: 'alta' },
      vigenciaDesde: { valor: '10/07/2026', confianza: 'alta' },
      vigenciaHasta: { valor: '09/07/2027', confianza: 'alta' },
    }));

    const r = await extraerFacturaSoat(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(1); // sin escalación
    expect(r.placa).toEqual({ valor: 'QTQ100', confianza: 0.95, confiable: true });
    expect(r.valorTotal).toEqual({ valor: '1234567', confianza: 0.95, confiable: true }); // pesos → entero
    expect(r.numeroPoliza!.valor).toBe('FLIT-ARHZZ1'); // guion preservado (transcripción exacta)
    expect(r.vigenciaDesde!.valor).toBe('2026-07-10'); // dd/mm/yyyy → ISO
    expect(r.fechaExpedicion!.confiable).toBe(true);
  });

  it('media/baja/null NO son confiables con umbral 0.85', async () => {
    // Todos los campos de escalación en 'media' fuerzan segunda pasada; devolvemos lo mismo.
    anthropicMock.mockResolvedValue(respuesta({
      placa: { valor: 'ABC123', confianza: 'media' },
      valorTotal: { valor: '500000', confianza: 'baja' },
      numeroRecibo: { valor: 'R-1', confianza: 'alta' },
      fechaPago: { valor: null, confianza: null },
      anioGravable: { valor: '2026', confianza: 'media' },
    }));

    const r = await extraerReciboImpuesto(doc());
    expect(r.placa!.confianza).toBe(0.6);
    expect(r.placa!.confiable).toBe(false);      // media < 0.85
    expect(r.valorTotal!.confiable).toBe(false); // baja < 0.85
    expect(r.fechaPago).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.numeroRecibo!.confiable).toBe(true); // alta
  });

  it('umbral parametrizable: un umbral bajo (0.5) vuelve confiable lo "media"', async () => {
    anthropicMock.mockResolvedValue(respuesta({
      placa: { valor: 'ABC123', confianza: 'media' },
      valorTotal: { valor: '500000', confianza: 'media' },
      numeroRecibo: { valor: null, confianza: null },
      fechaPago: { valor: null, confianza: null },
      anioGravable: { valor: null, confianza: null },
    }));
    const r = await extraerReciboImpuesto(doc({ umbral: 0.5 }));
    expect(r.placa!.confiable).toBe(true); // 0.6 >= 0.5
    expect(r.valorTotal!.confiable).toBe(true);
  });
});

describe('flito-ocr — doble pasada (escalación a Sonnet)', () => {
  it('campo requerido dudoso en Haiku → 2ª pasada; gana la de mayor confianza', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({ // Haiku: valorTotal dudoso
        placa: { valor: 'QTQ100', confianza: 'alta' },
        vin: { valor: null, confianza: null },
        numeroPoliza: { valor: 'P1', confianza: 'alta' },
        valorTotal: { valor: '111', confianza: 'baja' },
        aseguradora: { valor: 'SURA', confianza: 'alta' },
        fechaExpedicion: { valor: null, confianza: null },
        vigenciaDesde: { valor: null, confianza: null },
        vigenciaHasta: { valor: null, confianza: null },
      }))
      .mockResolvedValueOnce(respuesta({ // Sonnet: lo lee con alta
        placa: { valor: 'QTQ100', confianza: 'alta' },
        vin: { valor: null, confianza: null },
        numeroPoliza: { valor: 'P1', confianza: 'alta' },
        valorTotal: { valor: '250000', confianza: 'alta' },
        aseguradora: { valor: 'SURA', confianza: 'alta' },
        fechaExpedicion: { valor: null, confianza: null },
        vigenciaDesde: { valor: null, confianza: null },
        vigenciaHasta: { valor: null, confianza: null },
      }));

    const r = await extraerFacturaSoat(doc());
    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(r.valorTotal).toEqual({ valor: '250000', confianza: 0.95, confiable: true }); // gana Sonnet
  });

  it('si Sonnet falla, se conserva la lectura de Haiku (degradación)', async () => {
    anthropicMock
      .mockResolvedValueOnce(respuesta({
        placa: { valor: 'QTQ100', confianza: 'media' },
        vin: { valor: null, confianza: null }, numeroPoliza: { valor: 'P1', confianza: 'alta' },
        valorTotal: { valor: '250000', confianza: 'alta' }, aseguradora: { valor: 'SURA', confianza: 'alta' },
        fechaExpedicion: { valor: null, confianza: null }, vigenciaDesde: { valor: null, confianza: null }, vigenciaHasta: { valor: null, confianza: null },
      }))
      .mockRejectedValueOnce(new OcrNoDisponibleError(503, 'timeout'));

    const r = await extraerFacturaSoat(doc());
    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(r.placa!.valor).toBe('QTQ100'); // Haiku sobrevive
    expect(r.valorTotal!.valor).toBe('250000');
  });
});

describe('flito-ocr — fallback local (Bug #14229)', () => {
  it('Anthropic 503 → cae al local sin OCR_LOCAL=1 y no lanza OcrNoDisponibleError', async () => {
    process.env.OCR_LOCAL = '0';
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'upstream down' });
    textoDocumentoMock.mockResolvedValueOnce('texto local sin PII en el log');
    camposDesdeTextoMock.mockReturnValueOnce(crudoLocalSoat());

    const r = await extraerFacturaSoat(doc());

    expect(textoDocumentoMock).toHaveBeenCalledTimes(1);
    expect(camposDesdeTextoMock).toHaveBeenCalledTimes(1);
    expect(r.placa!.valor).toBe('QTQ100');
    expect(r.valorTotal!.valor).toBe('634900');
  });

  it('sin API key → usa local sin exigir OCR_LOCAL=1 (no llama a Anthropic)', async () => {
    const prev = env.ANTHROPIC_API_KEY;
    (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = undefined;
    process.env.OCR_LOCAL = '0';
    try {
      textoDocumentoMock.mockResolvedValueOnce('texto local');
      camposDesdeTextoMock.mockReturnValueOnce(crudoLocalSoat('ABC123', '100000'));

      const r = await extraerFacturaSoat(doc());

      expect(anthropicMock).not.toHaveBeenCalled();
      expect(textoDocumentoMock).toHaveBeenCalledTimes(1);
      expect(r.placa!.valor).toBe('ABC123');
      expect(r.valorTotal!.valor).toBe('100000');
    } finally {
      (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = prev;
    }
  });

  it('Anthropic falla y el local también → propaga el error del local', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'quota' });
    textoDocumentoMock.mockRejectedValueOnce(new Error('pdftotext exit 1: broken'));

    await expect(extraerFacturaSoat(doc())).rejects.toThrow(/pdftotext/);
    expect(textoDocumentoMock).toHaveBeenCalledTimes(1);
  });

  it('Anthropic OK → no llama al local', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      placa: { valor: 'QTQ100', confianza: 'alta' },
      vin: { valor: null, confianza: null },
      numeroPoliza: { valor: 'P1', confianza: 'alta' },
      valorTotal: { valor: '250000', confianza: 'alta' },
      aseguradora: { valor: 'SURA', confianza: 'alta' },
      fechaExpedicion: { valor: null, confianza: null },
      vigenciaDesde: { valor: null, confianza: null },
      vigenciaHasta: { valor: null, confianza: null },
    }));

    const r = await extraerFacturaSoat(doc());

    expect(textoDocumentoMock).not.toHaveBeenCalled();
    expect(camposDesdeTextoMock).not.toHaveBeenCalled();
    expect(r.valorTotal!.valor).toBe('250000');
  });
});

describe('flito-ocr — degradación y robustez', () => {
  it('respuesta no parseable → extracción vacía (todo null, va a revisión)', async () => {
    anthropicMock.mockResolvedValue({ ok: true, data: { content: [{ text: 'lo siento, no puedo' }] } });
    const r = await extraerFacturaSoat(doc());
    expect(r.valorTotal).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.placa!.valor).toBeNull();
  });

  it('normalizador descarta un valor no numérico aunque el modelo diga "alta"', async () => {
    anthropicMock.mockResolvedValue(respuesta({
      placa: { valor: 'ABC123', confianza: 'alta' },
      valorTotal: { valor: 'no visible', confianza: 'alta' }, // no es plata
      numeroRecibo: { valor: null, confianza: null }, fechaPago: { valor: null, confianza: null }, anioGravable: { valor: null, confianza: null },
    }));
    const r = await extraerReciboImpuesto(doc());
    expect(r.valorTotal).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('imagen (jpg): también extrae (media_type imagen, no PDF)', async () => {
    anthropicMock.mockResolvedValue(respuesta({
      placa: { valor: 'QTQ100', confianza: 'alta' }, valorTotal: { valor: '634900', confianza: 'alta' },
      numeroRecibo: { valor: 'R-1', confianza: 'alta' }, fechaPago: { valor: null, confianza: null }, anioGravable: { valor: null, confianza: null },
    }));
    const r = await extraerReciboImpuesto(doc({ contentType: 'image/jpeg', nombreArchivo: 'f.jpg' }));
    expect(r.valorTotal!.valor).toBe('634900');
    expect(r.numeroRecibo!.valor).toBe('R-1');
  });
});

describe('flito-ocr — helpers portados de patrones.ts', () => {
  it('placaDesdeNombre: respaldo por nombre de archivo', () => {
    expect(placaDesdeNombre('QTQ100 - Secretaría.pdf')).toBe('QTQ100');
    expect(placaDesdeNombre('abc_12d.jpg')).toBe('ABC12D'); // moto
    expect(placaDesdeNombre('sin-placa.pdf')).toBeNull();
  });
  it('normalizarPesos: formato colombiano e internacional, descarta decimales', () => {
    expect(normalizarPesos('1.234.567,89')).toBe('1234567');
    expect(normalizarPesos('1,234,567.89')).toBe('1234567');
    expect(normalizarPesos('$ 500000')).toBe('500000');
    expect(normalizarPesos('abc')).toBeNull();
  });
  it('normalizarFecha: dd/mm/yyyy, ISO y "15 de julio de 2026"', () => {
    expect(normalizarFecha('15/07/2026')).toBe('2026-07-15');
    expect(normalizarFecha('2026-7-9')).toBe('2026-07-09');
    expect(normalizarFecha('15 de julio de 2026')).toBe('2026-07-15');
    expect(normalizarFecha('mañana')).toBeNull();
  });
});

// ═════════════════ HU #12614 (AC1) · el sello PAGADO se lee en la misma llamada ═════════════════
// Mutante M5 del AC7: si el prompt no pide `selloPagado` (o el campo no está en `campos`), caen el
// `toMatch` del JSON del prompt y el `toEqual` del campo devuelto.
describe('extraerReciboImpuesto — selloPagado (HU #12614, AC1)', () => {
  /** El texto del prompt que viajó en la llamada N (0-based), como en flito-ocr.recibo-caja.test.ts. */
  function promptDeLlamada(n: number): string {
    const payload = anthropicMock.mock.calls[n]![0] as { messages: { content: { type: string; text?: string }[] }[] };
    return payload.messages[0]!.content.find((c) => c.type === 'text')!.text!;
  }
  const alta = (valor: string) => ({ valor, confianza: 'alta' });
  const base = { placa: alta('ABC123'), valorTotal: alta('500000'), numeroRecibo: alta('R-1'), fechaPago: alta('2026-09-10'), anioGravable: alta('2026') };

  it('el prompt pide selloPagado (true/false/null) y el campo vuelve en la MISMA llamada, sin escalación (M5)', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({ ...base, selloPagado: alta('true') }));

    const r = await extraerReciboImpuesto(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(promptDeLlamada(0)).toBe(PROMPT_RECIBO_IMPUESTO);
    expect(PROMPT_RECIBO_IMPUESTO).toMatch(/"selloPagado":\{"valor":null,"confianza":null\}/);
    expect(PROMPT_RECIBO_IMPUESTO).toMatch(/sello o la marca de agua PAGADO/i);
    expect(PROMPT_RECIBO_IMPUESTO).toMatch(/"true"[\s\S]*"false"[\s\S]*null/);
    expect(Object.keys(r)).toContain(CampoImpuesto.SELLO_PAGADO);
    expect(CampoImpuesto.SELLO_PAGADO).toBe('selloPagado');
    expect(CAMPO_IMPUESTO_LABEL.selloPagado).toBe('Sello PAGADO');
    expect(r.selloPagado).toEqual({ valor: 'true', confianza: 0.95, confiable: true });
  });

  it.each([
    ['null', { valor: null, confianza: null }],
    ["'sí' (fuera del catálogo)", alta('sí')],
    ["'PAGADO' (fuera del catálogo)", alta('PAGADO')],
  ])('sello %s → { valor: null, confianza: 0, confiable: false }', async (_n, selloPagado) => {
    anthropicMock.mockResolvedValueOnce(respuesta({ ...base, selloPagado }));
    const r = await extraerReciboImpuesto(doc());
    expect(r.selloPagado).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it("'FALSE' se normaliza a 'false'; en 'media' NO es confiable y NO fuerza la segunda pasada", async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({ ...base, selloPagado: { valor: 'FALSE', confianza: 'media' } }));
    const r = await extraerReciboImpuesto(doc());
    expect(anthropicMock).toHaveBeenCalledTimes(1); // selloPagado no está en la escalación
    expect(r.selloPagado).toEqual({ valor: 'false', confianza: 0.6, confiable: false });
  });

  it('el recibo de caja NO pide el sello (su prompt y su extractor no cambian)', () => {
    expect(PROMPT_RECIBO_CAJA).not.toMatch(/selloPagado/);
  });
});

describe('extraerVehiculoFacturaVenta — número, fecha y avalúo (HU #14293)', () => {
  const vacios = Object.fromEntries(
    ['vin', 'marca', 'linea', 'anioVehiculo', 'color', 'cilindrada', 'clase', 'direccion', 'municipio', 'departamento']
      .map((c) => [c, { valor: null, confianza: null }]),
  );
  /** VIN, año y marca en alta: sin escalación, una sola pasada. */
  const conDatos = (datos: Record<string, unknown>) => respuesta({
    ...vacios,
    vin: { valor: '9ABCD1234EF567890', confianza: 'alta' }, anioVehiculo: { valor: '2026', confianza: 'alta' },
    marca: { valor: 'MARCAX', confianza: 'alta' }, ...datos,
  });
  const alta = (valor: unknown) => ({ valor, confianza: 'alta' });

  it.each([
    ['plantilla B', 'FV99 1234', '2030-01-31', '$ 1,234,567.89', 'FV991234', '2030-01-31', '1234567.89'],
    ['plantilla C', 'FC991234', '31/01/2030 14:05:00', '1.234.567,89', 'FC991234', '2030-01-31', '1234567.89'],
    ['plantilla D', 'ZZ 1234', '31/01/2030, 15:48', '1,000,000.00', 'ZZ1234', '2030-01-31', '1000000.00'],
    ['otro emisor con 0', 'ZZ-77', '31/01/2030', '0', 'ZZ-77', '2030-01-31', '0'],
  ])('%s: normaliza los tres con los normalizadores del parser', async (_n, numero, fecha, avaluo, eNumero, eFecha, eAvaluo) => {
    anthropicMock.mockResolvedValueOnce(conDatos({ numeroFactura: alta(numero), fechaFactura: alta(fecha), avaluoComercial: alta(avaluo) }));
    const r = await extraerVehiculoFacturaVenta(doc());
    expect(r.numeroFactura).toMatchObject({ valor: eNumero, confiable: true });
    expect(r.fechaFactura).toMatchObject({ valor: eFecha, confiable: true });
    expect(r.avaluoComercial).toMatchObject({ valor: eAvaluo, confiable: true });
  });

  it('cada campo por separado: ambiguo, imposible o en confianza media no son fiables', async () => {
    anthropicMock.mockResolvedValueOnce(conDatos({
      numeroFactura: { valor: 'FV991234', confianza: 'media' }, fechaFactura: alta('31/02/2030'), avaluoComercial: alta('123,456'),
    }));
    const r = await extraerVehiculoFacturaVenta(doc());
    expect(r.numeroFactura).toMatchObject({ valor: 'FV991234', confiable: false });
    expect(r.fechaFactura).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.avaluoComercial).toEqual({ valor: null, confianza: 0, confiable: false });
    expect(r.vin).toMatchObject({ confiable: true });
  });

  it('sin el avalúo no se rellena con 0', async () => {
    anthropicMock.mockResolvedValueOnce(conDatos({}));
    const r = await extraerVehiculoFacturaVenta(doc());
    expect(r.avaluoComercial).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('los tres datos dudosos NO escalan a Sonnet', async () => {
    anthropicMock.mockResolvedValueOnce(conDatos({ numeroFactura: { valor: 'X1', confianza: 'baja' } }));
    await extraerVehiculoFacturaVenta(doc());
    expect(anthropicMock).toHaveBeenCalledTimes(1);
  });

  it('fallback local: no se le piden, quedan ausentes aunque el documento los traiga, y el resto sigue', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'upstream down' });
    textoDocumentoMock.mockResolvedValueOnce('FACTURA ZZ1234 FECHA DE VENTA 02/03/2030');
    camposDesdeTextoMock.mockReturnValueOnce({ vin: { valor: '9ABCD1234EF567890', confianza: 'alta' } });
    const r = await extraerVehiculoFacturaVenta(doc());
    const pedidos = camposDesdeTextoMock.mock.calls[0][1] as string[];
    for (const c of ['numeroFactura', 'fechaFactura', 'avaluoComercial']) {
      expect(pedidos, c).not.toContain(c);
      expect(r[c as 'numeroFactura'], c).toEqual({ valor: null, confianza: 0, confiable: false });
    }
    expect(pedidos).toContain('vin');
    expect(r.vin).toMatchObject({ valor: '9ABCD1234EF567890', confiable: true });
  });

  it('el fallback de los demás canales sigue pidiendo sus campos (SOAT no cambia)', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'upstream down' });
    textoDocumentoMock.mockResolvedValueOnce('texto');
    camposDesdeTextoMock.mockReturnValueOnce(crudoLocalSoat());
    await extraerFacturaSoat(doc());
    expect(camposDesdeTextoMock.mock.calls[0][1]).toContain('numeroPoliza');
  });

  it('el prompt lleva las definiciones de emisión y de valor antes de impuestos (AC2, AC3, AC4, AC9)', () => {
    const p = PROMPT_FACTURA_VENTA_VEHICULO;
    expect(p).toContain('"FV99 1234" → "FV991234"');
    expect(p).toMatch(/numeroFactura:[^\n]*NUNCA el número de resolución, la autorización DIAN ni la orden de compra/);
    expect(p).toMatch(/fechaFactura:[^\n]*EMISIÓN/);
    expect(p).toMatch(/fechaFactura:[^\n]*NUNCA la fecha de vencimiento, validación DIAN, recepción, generación, levante, declaración ni orden de compra/);
    expect(p).toMatch(/avaluoComercial:[^\n]*Subtotal Base gravable[^\n]*SUB TOTAL[^\n]*VALOR ANTES DE IMPUESTOS/);
    expect(p).toMatch(/avaluoComercial:[^\n]*NUNCA el total de la factura, NUNCA un valor con IVA/);
    expect(p).toMatch(/avaluoComercial:[^\n]*si no identificas esa fila con seguridad, devuelve null/);
    // Plantilla D: número con prefijo separado, `Expedición` y `Total Bruto` por encima de `Subtotal`.
    expect(p).toContain('"No. ZZ 1234" → "ZZ1234"');
    expect(p).toMatch(/numeroFactura:[^\n]*NUNCA del nombre del archivo/);
    expect(p).toMatch(/fechaFactura:[^\n]*"Expedición"/);
    expect(p).toMatch(/avaluoComercial:[^\n]*"Total Bruto", ese valor manda sobre "Subtotal" y "SUB TOTAL", tenga o no "Descuentos"/);
    expect(p).toMatch(/avaluoComercial:[^\n]*"Total Bruto" NO es el total de la factura/);
    expect(p).toMatch(/avaluoComercial:[^\n]*impuesto al consumo/);
    expect(p).toMatch(/avaluoComercial:[^\n]*NUNCA "Total a Pagar" ni la columna "Total" de la fila del producto/);
    expect(p).toContain('"avaluoComercial":{"valor":null,"confianza":null}');
    expect(p).toContain('NO extraigas nombre, documento, correo ni teléfono');
    expect(p).not.toContain('valorVehiculo');
  });
});
