import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestWithRetryMock = vi.fn();

vi.mock('../../src/shared/upstream.js', () => ({
  requestWithRetry: requestWithRetryMock,
  UpstreamError: class UpstreamError extends Error {},
}));

// Objeto mutable (hoisted) para poder probar la deduplicación del probe de Dr. Flit (HU #13856).
const envMock = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_MODEL_HAIKU: 'claude-haiku-test',
  ANTHROPIC_MODEL_SONNET: 'claude-sonnet-test',
  ANTHROPIC_MODEL_DRFLIT: 'claude-drflit-test',
}));

vi.mock('../../src/config/env.js', () => ({ env: envMock }));

beforeEach(() => {
  requestWithRetryMock.mockReset();
  envMock.ANTHROPIC_MODEL_DRFLIT = 'claude-drflit-test';
});

const modeloProbado = (i: number) => JSON.parse(requestWithRetryMock.mock.calls[i]![0].body).model;

describe('anthropic-health', () => {
  it('los tres modelos 200 → status ok', async () => {
    requestWithRetryMock.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.status).toBe('ok');
    expect(r.models).toHaveLength(3);
    expect(r.models.every((m) => m.status === 'ok')).toBe(true);
  });

  it('HU #13856 AC9: el probe diario revisa ANTHROPIC_MODEL_DRFLIT', async () => {
    requestWithRetryMock.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.models.map((m) => m.model)).toEqual(['claude-haiku-test', 'claude-sonnet-test', 'claude-drflit-test']);
    expect(modeloProbado(2)).toBe('claude-drflit-test');
  });

  it('HU #13856: si ANTHROPIC_MODEL_DRFLIT coincide con el de Haiku no se prueba dos veces', async () => {
    envMock.ANTHROPIC_MODEL_DRFLIT = 'claude-haiku-test';
    requestWithRetryMock.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.models.map((m) => m.model)).toEqual(['claude-haiku-test', 'claude-sonnet-test']);
    expect(requestWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it('HU #13856: el modelo de Dr. Flit retirado (404) degrada el reporte', async () => {
    requestWithRetryMock
      .mockResolvedValueOnce({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 })
      .mockResolvedValueOnce({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 })
      .mockResolvedValueOnce({
        statusCode: 404, buffer: Buffer.from(JSON.stringify({ error: { type: 'not_found_error' } })), attempts: 1,
      });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.status).toBe('degraded');
    expect(r.models[2]).toMatchObject({ model: 'claude-drflit-test', status: 'error', errorType: 'not_found_error' });
  });

  it('sonnet 404 not_found → status degraded', async () => {
    requestWithRetryMock
      .mockResolvedValueOnce({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 })
      .mockResolvedValueOnce({
        statusCode: 404,
        buffer: Buffer.from(JSON.stringify({ error: { type: 'not_found_error' } })),
        attempts: 1,
      })
      .mockResolvedValueOnce({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.status).toBe('degraded');
    expect(r.models[1].errorType).toBe('not_found_error');
  });

});
