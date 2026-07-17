import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestWithRetryMock = vi.fn();

vi.mock('../../src/shared/upstream.js', () => ({
  requestWithRetry: requestWithRetryMock,
  UpstreamError: class UpstreamError extends Error {},
}));

vi.mock('../../src/config/env.js', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_MODEL_HAIKU: 'claude-haiku-test',
    ANTHROPIC_MODEL_SONNET: 'claude-sonnet-test',
  },
}));

beforeEach(() => {
  requestWithRetryMock.mockReset();
});

describe('anthropic-health', () => {
  it('ambos modelos 200 → status ok', async () => {
    requestWithRetryMock.mockResolvedValue({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.status).toBe('ok');
    expect(r.models).toHaveLength(2);
    expect(r.models.every((m) => m.status === 'ok')).toBe(true);
  });

  it('sonnet 404 not_found → status degraded', async () => {
    requestWithRetryMock
      .mockResolvedValueOnce({ statusCode: 200, buffer: Buffer.from('{}'), attempts: 1 })
      .mockResolvedValueOnce({
        statusCode: 404,
        buffer: Buffer.from(JSON.stringify({ error: { type: 'not_found_error' } })),
        attempts: 1,
      });
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const r = await runAnthropicHealthCheckOnce();
    expect(r.status).toBe('degraded');
    expect(r.models[1].errorType).toBe('not_found_error');
  });

});
