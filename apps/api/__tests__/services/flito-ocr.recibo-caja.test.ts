// HU #12591 — `extraerReciboCaja`: el extractor del recibo de caja de ventanilla. Tres campos y
// ninguna placa (el impuesto ya está identificado), devueltos en la forma `ExtraccionImpuesto` para
// que conciliar/revisión/pantalla funcionen sin tipo nuevo. Calco de flito-ocr.service.test.ts:
// `anthropicMessages` mockeado, sin red ni API key. Este archivo NO muta el reloj (AC8).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CampoImpuesto } from '@operaciones/shared-types';

process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const { extraerReciboCaja, OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { PROMPT_RECIBO_CAJA, PROMPT_RECIBO_IMPUESTO } = await import('../../src/modules/flito-ocr/flito-ocr.prompts.js');

function respuesta(obj: Record<string, unknown>) {
  return { ok: true as const, data: { content: [{ text: JSON.stringify(obj) }] } };
}
const doc = (umbral = 0.85) => ({ nombreArchivo: 'caja.pdf', contentType: 'application/pdf', contenido: Buffer.from('%PDF-caja'), umbral });

/** El texto del prompt que viajó en la llamada N (0-based). */
function promptDeLlamada(n: number): string {
  const payload = anthropicMock.mock.calls[n]![0] as { messages: { content: { type: string; text?: string }[] }[] };
  return payload.messages[0]!.content.find((c) => c.type === 'text')!.text!;
}

beforeEach(() => anthropicMock.mockReset());

describe('extraerReciboCaja — prompt propio y tres campos', () => {
  it('usa PROMPT_RECIBO_CAJA (no el de la declaración) y pide exactamente valorTotal, fechaPago y numeroRecibo, sin placa', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      valorTotal: { valor: '$ 350.000', confianza: 'alta' },
      fechaPago: { valor: '10/09/2026', confianza: 'alta' },
      numeroRecibo: { valor: 'rc-778', confianza: 'alta' },
    }));

    const r = await extraerReciboCaja(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(promptDeLlamada(0)).toBe(PROMPT_RECIBO_CAJA);
    expect(PROMPT_RECIBO_CAJA).not.toBe(PROMPT_RECIBO_IMPUESTO);
    expect(PROMPT_RECIBO_CAJA).not.toMatch(/"placa"/);
    expect(PROMPT_RECIBO_CAJA).toMatch(/"valorTotal":\{"valor":null,"confianza":null\},"fechaPago":\{"valor":null,"confianza":null\},"numeroRecibo":\{"valor":null,"confianza":null\}/);
    expect(Object.keys(r).sort()).toEqual([CampoImpuesto.FECHA_PAGO, CampoImpuesto.NUMERO_RECIBO, CampoImpuesto.VALOR_TOTAL].sort());
    expect(r).not.toHaveProperty(CampoImpuesto.PLACA);
    expect(r).not.toHaveProperty(CampoImpuesto.ANIO_GRAVABLE);
  });

  it('normaliza: pesos → entero, fecha dd/mm/yyyy → ISO, número de recibo exacto en mayúsculas; alta → confiable', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      valorTotal: { valor: '$ 350.000', confianza: 'alta' },
      fechaPago: { valor: '10/09/2026', confianza: 'alta' },
      numeroRecibo: { valor: 'rc-778', confianza: 'alta' },
    }));

    const r = await extraerReciboCaja(doc());

    expect(r[CampoImpuesto.VALOR_TOTAL]).toEqual({ valor: '350000', confianza: 0.95, confiable: true });
    expect(r[CampoImpuesto.FECHA_PAGO]).toEqual({ valor: '2026-09-10', confianza: 0.95, confiable: true });
    expect(r[CampoImpuesto.NUMERO_RECIBO]).toEqual({ valor: 'RC-778', confianza: 0.95, confiable: true });
  });

  it('valorTotal en media escala a la segunda pasada (solo el valor decide) y con umbral 0.85 NO es confiable', async () => {
    anthropicMock.mockResolvedValue(respuesta({
      valorTotal: { valor: '350000', confianza: 'media' },
      fechaPago: { valor: null, confianza: null },
      numeroRecibo: { valor: 'RC-1', confianza: 'alta' },
    }));

    const r = await extraerReciboCaja(doc());

    expect(anthropicMock).toHaveBeenCalledTimes(2);
    expect(promptDeLlamada(1)).toBe(PROMPT_RECIBO_CAJA);
    expect(r[CampoImpuesto.VALOR_TOTAL]).toEqual({ valor: '350000', confianza: 0.6, confiable: false });
    expect(r[CampoImpuesto.FECHA_PAGO]).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('fechaPago en media con valorTotal en alta NO escala: la fecha no es campo de escalación', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta({
      valorTotal: { valor: '350000', confianza: 'alta' },
      fechaPago: { valor: '2026-09-10', confianza: 'media' },
      numeroRecibo: { valor: null, confianza: null },
    }));
    const r = await extraerReciboCaja(doc());
    expect(anthropicMock).toHaveBeenCalledTimes(1);
    expect(r[CampoImpuesto.FECHA_PAGO]).toEqual({ valor: '2026-09-10', confianza: 0.6, confiable: false });
  });

  it('respuesta no parseable → los tres campos a null, sin confianza', async () => {
    anthropicMock.mockResolvedValue({ ok: true, data: { content: [{ text: 'no es json' }] } });
    const r = await extraerReciboCaja(doc());
    for (const c of [CampoImpuesto.VALOR_TOTAL, CampoImpuesto.FECHA_PAGO, CampoImpuesto.NUMERO_RECIBO]) {
      expect(r[c]).toEqual({ valor: null, confianza: 0, confiable: false });
    }
  });

  it('upstream caído (ok:false) → OcrNoDisponibleError con el status del cliente', async () => {
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'El servicio de OCR no está disponible' });
    await expect(extraerReciboCaja(doc())).rejects.toBeInstanceOf(OcrNoDisponibleError);
    anthropicMock.mockResolvedValueOnce({ ok: false, status: 503, message: 'x' });
    await expect(extraerReciboCaja(doc())).rejects.toMatchObject({ status: 503, message: 'x' });
  });

  it('este spec no muta el reloj (AC8)', () => {
    const propio = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(propio).not.toMatch(/vi\.(setSystemTime|useFakeTimers)\(/);
  });
});
