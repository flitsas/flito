import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock https.request — captura el body y simula response Anthropic.
const httpsRequestMock = vi.fn();
vi.mock('https', () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

// Mock pdf-lib — ensurePageUpright lo usa internamente. No podemos mockear ensurePageUpright
// directamente con importOriginal porque extractSinglePage la llama localmente (mismo módulo).
const pdfPageMock = {
  getRotation: vi.fn().mockReturnValue({ angle: 0 }),
  setRotation: vi.fn(),
};
const pdfDocMock = {
  copyPages: vi.fn().mockResolvedValue([{}]),
  addPage: vi.fn(),
  getPage: vi.fn().mockReturnValue(pdfPageMock),
  save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
};
vi.mock('pdf-lib', () => ({
  PDFDocument: { create: vi.fn().mockResolvedValue(pdfDocMock) },
  degrees: (n: number) => n,
}));

beforeEach(() => {
  httpsRequestMock.mockReset();
});

/**
 * Helper: simula una secuencia de respuestas Anthropic. Cada call siguiente devuelve la
 * próxima respuesta. La respuesta es el objeto Anthropic con content[0].text = JSON string.
 */
function queueAnthropicResponses(...responses: Array<{ text: string } | { error: string }>) {
  for (const resp of responses) {
    httpsRequestMock.mockImplementationOnce((_opts: any, cb: any) => {
      const res = new EventEmitter();
      setImmediate(() => {
        const body = 'error' in resp
          ? JSON.stringify({ error: { message: resp.error } })
          : JSON.stringify({ content: [{ text: resp.text }] });
        res.emit('data', body);
        res.emit('end');
      });
      cb(res);
      return {
        setTimeout: vi.fn(),
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
    });
  }
}

// JSON helper — formato esperado por extractSinglePage.
function makeExtractionJSON(overrides: Partial<{
  placa: string; marca: string; linea: string; modelo: number; clase: string;
  propietarioNombre: string; propietarioDocumento: string;
  r1_avaluoComercial: number; r2_impuesto: number; r5_totalCargo: number; r11_totalPagar: number;
  formularioNo: string; _documentType: string;
  conf: 'alta' | 'media' | 'baja';
}>): string {
  const c = overrides.conf ?? 'alta';
  const f = (v: any) => v == null ? `{"valor": null, "confianza": null}` : `{"valor": ${typeof v === 'number' ? v : `"${v}"`}, "confianza": "${c}"}`;
  return JSON.stringify({
    placa: JSON.parse(f(overrides.placa ?? 'ABC123')),
    marca: JSON.parse(f(overrides.marca ?? 'CHEVROLET')),
    linea: JSON.parse(f(overrides.linea ?? 'AVEO')),
    modelo: JSON.parse(f(overrides.modelo ?? 2020)),
    clase: JSON.parse(f(overrides.clase ?? 'AUTOMOVIL')),
    propietarioNombre: JSON.parse(f(overrides.propietarioNombre ?? 'PERSONA REAL ESPECIFICA')),
    propietarioDocumento: JSON.parse(f(overrides.propietarioDocumento ?? '70123456')),
    tipoDocumento: JSON.parse(f('CC')),
    celular: JSON.parse(f(null)),
    email: JSON.parse(f(null)),
    r1_avaluoComercial: JSON.parse(f(overrides.r1_avaluoComercial ?? 50_000_000)),
    r2_impuesto: JSON.parse(f(overrides.r2_impuesto ?? 1_000_000)),
    r5_totalCargo: JSON.parse(f(overrides.r5_totalCargo ?? 1_050_000)),
    r11_totalPagar: JSON.parse(f(overrides.r11_totalPagar ?? 1_100_000)),
    formularioNo: JSON.parse(f(overrides.formularioNo ?? '12345')),
    _documentType: overrides._documentType ?? 'individual',
  });
}

describe('flattenToLegacyShape — pure function', () => {
  it('mapea ConfidenceField a forma plana legacy', async () => {
    const { flattenToLegacyShape } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const result = flattenToLegacyShape({
      placa: { valor: 'XYZ789', confianza: 'alta' },
      marca: { valor: 'TOYOTA', confianza: 'alta' },
      linea: { valor: 'COROLLA', confianza: 'media' },
      modelo: { valor: 2018, confianza: 'alta' },
      clase: { valor: 'AUTOMOVIL', confianza: 'alta' },
      propietarioNombre: { valor: 'JUAN PÉREZ', confianza: 'alta' },
      propietarioDocumento: { valor: '70123456', confianza: 'alta' },
      tipoDocumento: { valor: 'CC', confianza: 'alta' },
      celular: { valor: '3001234567', confianza: 'media' },
      email: { valor: null, confianza: null },
      r1_avaluoComercial: { valor: 30_000_000, confianza: 'alta' },
      r2_impuesto: { valor: 600_000, confianza: 'alta' },
      r5_totalCargo: { valor: 650_000, confianza: 'alta' },
      r11_totalPagar: { valor: 680_000, confianza: 'alta' },
      formularioNo: { valor: '99999', confianza: 'alta' },
      _documentType: 'individual',
      _confidence_avg: 95,
      _math_check: 'ok',
      _warnings: [],
      _model: 'haiku',
      _page_rotated: false,
    });
    expect(result.placa).toBe('XYZ789');
    expect(result.marca).toBe('TOYOTA');
    expect(result.modelo).toBe(2018);
    expect(result.totalPagar).toBe(680_000);
    expect(result.email).toBe(''); // null → ''
    expect(result._confidence).toBe(95);
    expect(result._math_check).toBe('ok');
    expect(result.carroceria).toBe(''); // siempre vacío en legacy
    expect(result.cilindraje).toBe('');
    // PR (B): defaults cuando NO se setearon flags Sonnet
    expect(result._sonnet_attempted).toBe(false);
    expect(result._sonnet_errored).toBe(false);
    expect(result._sonnet_error_type).toBeUndefined();
  });

  it('valor null → string vacío en campos string', async () => {
    const { flattenToLegacyShape } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const allNull = {
      placa: { valor: null, confianza: null },
      marca: { valor: null, confianza: null },
      linea: { valor: null, confianza: null },
      modelo: { valor: null, confianza: null },
      clase: { valor: null, confianza: null },
      propietarioNombre: { valor: null, confianza: null },
      propietarioDocumento: { valor: null, confianza: null },
      tipoDocumento: { valor: null, confianza: null },
      celular: { valor: null, confianza: null },
      email: { valor: null, confianza: null },
      r1_avaluoComercial: { valor: null, confianza: null },
      r2_impuesto: { valor: null, confianza: null },
      r5_totalCargo: { valor: null, confianza: null },
      r11_totalPagar: { valor: null, confianza: null },
      formularioNo: { valor: null, confianza: null },
      _documentType: 'unknown' as const,
      _confidence_avg: 0,
      _math_check: 'skipped' as const,
      _warnings: ['warn1'],
      _model: 'haiku',
    };
    const r = flattenToLegacyShape(allNull);
    expect(r.placa).toBe('');
    expect(r.modelo).toBe(''); // null → ''  (pero declarado number en input)
    expect(r.avaluoComercial).toBe(0); // null → 0 en numéricos
    expect(r.totalPagar).toBe(0);
    expect(r._warnings).toEqual(['warn1']);
  });

  it('preserva _model, _math_check, _warnings, _page_rotated en metadata', async () => {
    const { flattenToLegacyShape } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = flattenToLegacyShape({
      placa: { valor: 'X', confianza: 'alta' },
      marca: { valor: null, confianza: null }, linea: { valor: null, confianza: null },
      modelo: { valor: null, confianza: null }, clase: { valor: null, confianza: null },
      propietarioNombre: { valor: null, confianza: null },
      propietarioDocumento: { valor: null, confianza: null },
      tipoDocumento: { valor: null, confianza: null },
      celular: { valor: null, confianza: null }, email: { valor: null, confianza: null },
      r1_avaluoComercial: { valor: null, confianza: null }, r2_impuesto: { valor: null, confianza: null },
      r5_totalCargo: { valor: null, confianza: null }, r11_totalPagar: { valor: null, confianza: null },
      formularioNo: { valor: null, confianza: null },
      _documentType: 'listado_concesionario',
      _confidence_avg: 50, _math_check: 'mismatch', _warnings: ['w1', 'w2'],
      _model: 'sonnet', _page_rotated: true,
    });
    expect(r._documentType).toBe('listado_concesionario');
    expect(r._model).toBe('sonnet');
    expect(r._math_check).toBe('mismatch');
    expect(r._warnings).toEqual(['w1', 'w2']);
    expect(r._page_rotated).toBe(true);
  });
});

describe('extractSinglePage — pipeline end-to-end con mocks', () => {
  it('documento tipo "listado_concesionario" → NO segunda pasada, warning específico', async () => {
    queueAnthropicResponses({
      text: makeExtractionJSON({ _documentType: 'listado_concesionario' }),
    });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);

    expect(r).not.toBeNull();
    expect(r!._documentType).toBe('listado_concesionario');
    expect(r!._warnings.some((w) => w.includes('listado_concesionario'))).toBe(true);
    // Solo una llamada (Haiku) — sin segunda pasada Sonnet
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it('documento "individual" alta confianza + math ok + sin warnings → NO segunda pasada', async () => {
    queueAnthropicResponses({
      text: makeExtractionJSON({
        placa: 'XYZ789',
        propietarioNombre: 'PEDRO MARTINEZ ESPECIFICO',
        propietarioDocumento: '70123456',
        r2_impuesto: 1_000_000,
        r5_totalCargo: 1_050_000,
        r11_totalPagar: 1_100_000,
        conf: 'alta',
      }),
    });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);

    expect(r!._documentType).toBe('individual');
    expect(r!._math_check).toBe('ok');
    expect(r!._warnings).toEqual([]);
    expect(r!._confidence_avg).toBeGreaterThanOrEqual(65);
    expect(r!._model).toBe('claude-haiku-4-5-20251001');
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it('parseJSONLoose: respuesta con bloque markdown ```json...``` → parsea correctamente', async () => {
    const inner = makeExtractionJSON({ conf: 'alta' });
    queueAnthropicResponses({ text: '```json\n' + inner + '\n```' });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r).not.toBeNull();
    expect(r!.placa.valor).toBe('ABC123');
  });

  it('parseJSONLoose: texto con preámbulo + JSON al final → extrae JSON con regex', async () => {
    const inner = makeExtractionJSON({ conf: 'alta' });
    queueAnthropicResponses({ text: 'Aquí están los datos: ' + inner + ' fin del texto' });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r).not.toBeNull();
  });

  it('respuesta no parseable → null', async () => {
    queueAnthropicResponses({ text: 'no es json para nada' });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r).toBeNull();
  });

  it('placa con formato inválido (ABC1234) → warning de formato + segunda pasada Sonnet', async () => {
    // Pasada 1: formato inválido → warning
    queueAnthropicResponses(
      { text: makeExtractionJSON({ placa: 'AB1234X' }) }, // formato no [A-Z]{3}\d{3}
      { text: makeExtractionJSON({ placa: 'XYZ123', conf: 'alta' }) }, // Sonnet corrige
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!._model).toBe('claude-sonnet-4-6');
    expect(r!.placa.valor).toBe('XYZ123');
  });

  it('hallucination: placa ABC123 → warning sospechosa + segunda pasada', async () => {
    // ABC123 está en HALLUCINATION_PATTERNS.placas
    queueAnthropicResponses(
      { text: makeExtractionJSON({ placa: 'ABC123' }) },
      { text: makeExtractionJSON({ placa: 'WTY998', conf: 'alta' }) },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!.placa.valor).toBe('WTY998');
  });

  it('hallucination: documento secuencial 1234567890 → warning + segunda pasada', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ propietarioDocumento: '1234567890' }) },
      { text: makeExtractionJSON({ propietarioDocumento: '70123456', conf: 'alta' }) },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!.propietarioDocumento.valor).toBe('70123456');
  });

  it('hallucination: nombre genérico "JUAN CARLOS GOMEZ" → warning + segunda pasada', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ propietarioNombre: 'JUAN CARLOS GOMEZ' }) },
      { text: makeExtractionJSON({ propietarioNombre: 'NOMBRE REAL ESPECIFICO', conf: 'alta' }) },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!.propietarioNombre.valor).toBe('NOMBRE REAL ESPECIFICO');
  });

  it('math mismatch (r5 ≈ r11 pero r2 ≠ r5) → segunda pasada', async () => {
    // r5=1_000_000, r11=1_000_000 (idénticos) y r2=200_000 (no cuadra) → mismatch
    queueAnthropicResponses(
      {
        text: makeExtractionJSON({
          r2_impuesto: 200_000, r5_totalCargo: 1_000_000, r11_totalPagar: 1_000_000, conf: 'alta',
          placa: 'ABZ555', // formato válido para no triggear placa
          propietarioDocumento: '70123456',
          propietarioNombre: 'PERSONA REAL',
        }),
      },
      {
        text: makeExtractionJSON({
          r2_impuesto: 1_000_000, r5_totalCargo: 1_050_000, r11_totalPagar: 1_100_000, conf: 'alta',
          placa: 'ABZ555',
          propietarioDocumento: '70123456',
          propietarioNombre: 'PERSONA REAL',
        }),
      },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!._math_check).toBe('ok'); // tras Sonnet
  });

  it('confianza baja en pasada 1 → segunda pasada Sonnet', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ placa: 'XYZ789', propietarioNombre: 'PERSONA REAL', propietarioDocumento: '70123456', conf: 'baja' }) },
      { text: makeExtractionJSON({ placa: 'XYZ789', propietarioNombre: 'PERSONA REAL', propietarioDocumento: '70123456', conf: 'alta' }) },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(r!._confidence_avg).toBeGreaterThanOrEqual(65);
  });

  it('Sonnet falla (throws) → devuelve resultado de Haiku + observabilidad PR (B)', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ placa: 'AB1234X', conf: 'baja' }) }, // baja conf → triggeam Sonnet
      { error: 'Sonnet rate limited' },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r).not.toBeNull();
    expect(r!._model).toBe('claude-haiku-4-5-20251001'); // se quedó con Haiku
    // PR (B) INC-OCR-2026-05-12: el catch ya NO es silencioso
    expect(r!._sonnet_attempted).toBe(true);
    expect(r!._sonnet_errored).toBe(true);
    expect(typeof r!._sonnet_error_type).toBe('string');
    expect(r!._warnings.some((w) => w.toLowerCase().includes('capa avanzada'))).toBe(true);
  });

  it('Sonnet pass exitoso → _sonnet_attempted=true sin _sonnet_errored (PR B)', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ placa: 'AB1234X' }) }, // primera invalida → triggea segunda
      { text: makeExtractionJSON({ placa: 'XYZ123', conf: 'alta' }) }, // sonnet ok
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r!._model).toBe('claude-sonnet-4-6');
    expect(r!._sonnet_attempted).toBe(true);
    expect(r!._sonnet_errored).toBeUndefined();
    expect(r!._sonnet_error_type).toBeUndefined();
  });

  it('modelo fuera de rango (1900) → warning detect_hallucinations', async () => {
    queueAnthropicResponses(
      { text: makeExtractionJSON({ modelo: 1900, placa: 'ABZ555', propietarioDocumento: '70123456', propietarioNombre: 'PERSONA REAL', conf: 'alta' }) },
      { text: makeExtractionJSON({ modelo: 2020, placa: 'ABZ555', propietarioDocumento: '70123456', propietarioNombre: 'PERSONA REAL', conf: 'alta' }) },
    );

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    await extractSinglePage({} as any, 0);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2); // segunda pasada por warning
  });

  it('normalizeField: documento se limpia de no-dígitos (CC.70.123.456 → 70123456)', async () => {
    queueAnthropicResponses({
      text: makeExtractionJSON({
        propietarioDocumento: 'CC.70.123.456',
        placa: 'ABZ555',
        propietarioNombre: 'PERSONA REAL',
        conf: 'alta',
      }),
    });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r!.propietarioDocumento.valor).toBe('70123456'); // limpiado
  });

  it('normalizeField: placa normaliza a uppercase + alfanumérico (abz-555 → ABZ555)', async () => {
    queueAnthropicResponses({
      text: makeExtractionJSON({
        placa: 'abz-555',
        propietarioNombre: 'PERSONA REAL',
        propietarioDocumento: '70123456',
        conf: 'alta',
      }),
    });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r!.placa.valor).toBe('ABZ555');
  });

  it('Anthropic devuelve error en pasada 1 → throws (capturado por try/catch del caller)', async () => {
    queueAnthropicResponses({ error: 'Rate limit' });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    await expect(extractSinglePage({} as any, 0)).rejects.toThrow(/Rate limit/);
  });

  it('_documentType inválido en respuesta → normaliza a "unknown"', async () => {
    queueAnthropicResponses({
      text: makeExtractionJSON({ _documentType: 'tipo_invalido_inventado' }),
    });

    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage({} as any, 0);
    expect(r!._documentType).toBe('unknown');
  });
});
