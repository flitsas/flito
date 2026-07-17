// FLOTA-OCR-GOLDEN — regresión del pipeline OCR de impuesto vehicular (flota).
//
// Corre el golden-set de fixtures ANONIMIZADAS (apps/api/__tests__/fixtures/ocr/golden/)
// contra `extractSinglePage`, con la red MOCKEADA (CI sin red): cada fixture trae la(s)
// respuesta(s) grabada(s) del modelo (Haiku y, si aplica, Sonnet). El test verifica:
//   1. Extracción correcta de campos clave por caso (placa/modelo/impuesto/total).
//   2. GATE: el promedio de `_confidence_avg` no cae > `gateDropPp` puntos vs baseline.
//
// Regenerar baseline (intencional, revisando el diff):
//   UPDATE_OCR_GOLDEN=1 npm run test -w apps/api -- ocr.golden
//
// Ver docs/FLOTA-OCR-GOLDEN.md.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Mocks de red + pdf-lib (mismo seam que ocr.pipeline.test.ts) ---
const httpsRequestMock = vi.fn();
vi.mock('https', () => ({ default: { request: httpsRequestMock }, request: httpsRequestMock }));

const pdfPageMock = { getRotation: vi.fn().mockReturnValue({ angle: 0 }), setRotation: vi.fn() };
const pdfDocMock = {
  copyPages: vi.fn().mockResolvedValue([{}]),
  addPage: vi.fn(),
  getPage: vi.fn().mockReturnValue(pdfPageMock),
  save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
};
vi.mock('pdf-lib', () => ({ PDFDocument: { create: vi.fn().mockResolvedValue(pdfDocMock) }, degrees: (n: number) => n }));

// Encola las respuestas Anthropic de un caso. Tras agotarlas, cualquier llamada
// EXTRA (regresión que dispara una pasada no prevista) falla en voz alta en vez
// de colgar el test.
function mockAnthropicSequence(texts: string[]) {
  httpsRequestMock.mockReset();
  const respond = (body: string) => (_opts: any, cb: any) => {
    const res = new EventEmitter();
    setImmediate(() => { res.emit('data', body); res.emit('end'); });
    cb(res);
    return { setTimeout: vi.fn(), on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
  };
  for (const t of texts) {
    httpsRequestMock.mockImplementationOnce(respond(JSON.stringify({ content: [{ text: t }] })));
  }
  httpsRequestMock.mockImplementation(
    respond(JSON.stringify({ error: { message: 'golden: llamada OCR inesperada (más pasadas de las grabadas)' } })),
  );
}

// --- Carga del golden-set ---
const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr', 'golden');

interface GoldenCase {
  id: string;
  descripcion: string;
  responses: { tier: 'haiku' | 'sonnet'; payload: Record<string, unknown> }[];
  expected: {
    documentType: string;
    modelTier: 'haiku' | 'sonnet';
    confidenceMin: number;
    mathCheck?: string;
    fields: { placa: string; modelo: number; impuesto: number | null; totalPagar: number };
  };
}

interface Baseline {
  metric: string;
  gateDropPp: number;
  aggregate: number;
  perCase: Record<string, number>;
}

function loadCases(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'baseline.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(GOLDEN_DIR, f), 'utf-8')) as GoldenCase);
}

const CASES = loadCases();
const BASELINE: Baseline = JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'baseline.json'), 'utf-8'));
const UPDATE = !!process.env.UPDATE_OCR_GOLDEN;

// Resultados acumulados de correr cada caso una vez.
const results: Record<string, any> = {};

beforeAll(async () => {
  const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
  for (const c of CASES) {
    mockAnthropicSequence(c.responses.map((r) => JSON.stringify(r.payload)));
    results[c.id] = await extractSinglePage({} as any, 0);
  }
});

describe('FLOTA-OCR-GOLDEN · golden-set', () => {
  it('hay al menos 5 casos y un baseline coherente', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(5);
    expect(BASELINE.metric).toBe('confidence_avg');
    expect(Object.keys(BASELINE.perCase).sort()).toEqual(CASES.map((c) => c.id).sort());
  });

  describe('extracción por caso (campos clave + tier de modelo)', () => {
    it.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const r = results[c.id];
      expect(r, `caso ${c.id} no produjo extracción`).not.toBeNull();
      expect(r._documentType).toBe(c.expected.documentType);
      expect(r._model).toContain(c.expected.modelTier);
      expect(r.placa.valor).toBe(c.expected.fields.placa);
      expect(r.modelo.valor).toBe(c.expected.fields.modelo);
      expect(r.r2_impuesto.valor).toBe(c.expected.fields.impuesto);
      expect(r.r11_totalPagar.valor).toBe(c.expected.fields.totalPagar);
      if (c.expected.mathCheck) expect(r._math_check).toBe(c.expected.mathCheck);
    });
  });

  describe('confianza por caso (no cae > gateDropPp vs baseline)', () => {
    it.each(CASES.map((c) => [c.id, c] as const))('%s confianza', (_id, c) => {
      const conf = results[c.id]._confidence_avg as number;
      expect(conf).toBeGreaterThanOrEqual(c.expected.confidenceMin);
      if (!UPDATE) {
        const floor = BASELINE.perCase[c.id] - BASELINE.gateDropPp;
        expect(conf, `caso ${c.id}: confianza ${conf} < piso ${floor}`).toBeGreaterThanOrEqual(floor);
      }
    });
  });

  it(`GATE: confidence_avg agregado no cae > ${BASELINE.gateDropPp}pp vs baseline (${BASELINE.aggregate})`, () => {
    const confs = CASES.map((c) => results[c.id]._confidence_avg as number);
    const aggregate = Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10;

    if (UPDATE) {
      const perCase: Record<string, number> = {};
      for (const c of CASES) perCase[c.id] = results[c.id]._confidence_avg;
      const next = { ...BASELINE, aggregate, perCase };
      writeFileSync(path.join(GOLDEN_DIR, 'baseline.json'), JSON.stringify(next, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.log(`[UPDATE_OCR_GOLDEN] baseline reescrito: aggregate=${aggregate}`);
      return;
    }

    expect(aggregate, `confidence_avg agregado ${aggregate} cayó > ${BASELINE.gateDropPp}pp bajo baseline ${BASELINE.aggregate}`)
      .toBeGreaterThanOrEqual(BASELINE.aggregate - BASELINE.gateDropPp);
  });
});
