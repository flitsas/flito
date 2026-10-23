// HU #13890 (ADR-0028 §8) — extractor de la fecha de expedición (Cámara, RUT, certificado bancario).
// El motor Anthropic está mockeado (`tramites/anthropic.js`): nada de red. Cubre la lectura de la fecha
// (AC1), el «sin fecha» (AC4), la escalada a Sonnet y el 429 del motor (AC9, lo propaga para reintentar).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const anthropicMock = vi.fn();
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const { extraerFechaExpedicion } = await import('../../src/modules/flito-ocr/flito-ocr-expedicion.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');

const DOC = { nombreArchivo: 'camara_comercio', contentType: 'application/pdf', contenido: Buffer.from('%PDF-1.4 x') };

function respuesta(valor: string | null, confianza: string | null) {
  return { ok: true, data: { content: [{ text: JSON.stringify({ fecha_expedicion: { valor, confianza } }) }] } };
}

beforeEach(() => anthropicMock.mockReset());

describe('extraerFechaExpedicion', () => {
  it('AC1 — Cámara legible: devuelve la fecha ISO y confiable, con una sola pasada', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta('03/10/2026', 'alta'));
    const r = await extraerFechaExpedicion(DOC, 'camara_comercio');
    expect(r).toEqual({ fecha: '2026-10-03', confiable: true });
    expect(anthropicMock).toHaveBeenCalledTimes(1);
    const payload = anthropicMock.mock.calls[0]![0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(payload.messages[0]!.content[1]!.text).toMatch(/EXISTENCIA Y REPRESENTACIÓN LEGAL/);
  });

  it('cada tipo usa su prompt (RUT y certificado bancario)', async () => {
    anthropicMock.mockResolvedValue(respuesta('2026-10-01', 'alta'));
    await extraerFechaExpedicion(DOC, 'rut');
    await extraerFechaExpedicion(DOC, 'certificado_bancario');
    const textos = anthropicMock.mock.calls.map((c) => (c[0] as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[1]!.text);
    expect(textos[0]).toMatch(/REGISTRO ÚNICO TRIBUTARIO/);
    expect(textos[1]).toMatch(/CERTIFICACIÓN BANCARIA/);
  });

  it('AC4 — sin fecha legible en ninguna pasada → fecha null, no confiable', async () => {
    anthropicMock.mockResolvedValue(respuesta(null, null));
    const r = await extraerFechaExpedicion(DOC, 'certificado_bancario');
    expect(r).toEqual({ fecha: null, confiable: false });
    expect(anthropicMock).toHaveBeenCalledTimes(2); // escaló a Sonnet antes de rendirse
  });

  it('dudosa en Haiku y nítida en Sonnet → gana Sonnet', async () => {
    anthropicMock.mockResolvedValueOnce(respuesta('01/10/2026', 'media')).mockResolvedValueOnce(respuesta('02/10/2026', 'alta'));
    expect(await extraerFechaExpedicion(DOC, 'rut')).toEqual({ fecha: '2026-10-02', confiable: true });
  });

  it('una fecha que no existe en el calendario no se acepta', async () => {
    anthropicMock.mockResolvedValue(respuesta('31/02/2026', 'alta'));
    expect(await extraerFechaExpedicion(DOC, 'rut')).toEqual({ fecha: null, confiable: false });
  });

  it('confianza media → la fecha sale pero NO es confiable', async () => {
    anthropicMock.mockResolvedValue(respuesta('01/10/2026', 'media'));
    expect(await extraerFechaExpedicion(DOC, 'rut')).toEqual({ fecha: '2026-10-01', confiable: false });
  });

  it('AC9 — el motor responde 429 → lanza OcrNoDisponibleError (quien llama reintenta)', async () => {
    anthropicMock.mockResolvedValue({ ok: false, status: 429, message: 'rate limited' });
    await expect(extraerFechaExpedicion(DOC, 'rut')).rejects.toBeInstanceOf(OcrNoDisponibleError);
  });

  it('la cédula no es un tipo admitido (D8): no llega al motor', async () => {
    await expect(extraerFechaExpedicion(DOC, 'cedula_representante' as never)).rejects.toThrow();
    expect(anthropicMock).not.toHaveBeenCalled();
  });
});
