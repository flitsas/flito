// FLITO OCR — motor de extracción. Verifica el CONTRATO y las REGLAS (mapeo de confianza, umbral,
// normalización, doble pasada, degradación), no la calidad del OCR: `anthropicMessages` está
// mockeado (los tests corren sin red ni API key). La calidad real del prompt se mide aparte con
// golden fixtures + ANTHROPIC_API_KEY (§8.4). Ver docs/MIGRACION_FLITO_A_OPERACIONES.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CampoImpuesto, CAMPO_IMPUESTO_LABEL } from '@operaciones/shared-types';

// Aísla el test de los flags de demo del .env (dotenv los carga vía env.ts): estos tests ejercitan la
// ruta de Anthropic (mockeada), no el stub ni el fallback local. Sin esto, OCR_STUB/OCR_LOCAL del .env
// desviarían la extracción y romperían el contrato que aquí se valida.
process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const {
  extraerFacturaSoat, extraerReciboImpuesto,
  placaDesdeNombre, normalizarPesos, normalizarFecha, OcrNoDisponibleError,
} = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { PROMPT_RECIBO_IMPUESTO, PROMPT_RECIBO_CAJA } = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');

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

beforeEach(() => anthropicMock.mockReset());

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

describe('flito-ocr — degradación y robustez', () => {
  it('anthropicMessages no disponible (sin key) → OcrNoDisponibleError', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'Servicio de IA no configurado' });
    await expect(extraerFacturaSoat(doc())).rejects.toBeInstanceOf(OcrNoDisponibleError);
  });

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
