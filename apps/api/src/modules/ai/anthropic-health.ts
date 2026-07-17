// INC-OCR-2026-05-12 action #4 — probe diario de modelos Anthropic configurados.
// Detecta deprecación (404 not_found_error) antes de que falle el OCR en silencio.

import { env } from '../../config/env.js';
import { requestWithRetry } from '../../shared/upstream.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('anthropic-health');

export type ModelProbe = {
  model: string;
  status: 'ok' | 'error' | 'skipped';
  statusCode?: number;
  errorType?: string;
};

export type AnthropicHealthReport = {
  status: 'ok' | 'degraded' | 'skipped';
  checkedAt: string;
  models: ModelProbe[];
};

async function probeModel(model: string): Promise<ModelProbe> {
  if (!env.ANTHROPIC_API_KEY) {
    return { model, status: 'skipped' };
  }

  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  try {
    const resp = await requestWithRetry({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs: 15_000,
      retries: 0,
    });

    if (resp.statusCode === 200) {
      return { model, status: 'ok', statusCode: 200 };
    }

    let errorType: string | undefined;
    try {
      const json = JSON.parse(resp.buffer.toString('utf8'));
      errorType = json?.error?.type;
    } catch { /* ignore */ }

    return { model, status: 'error', statusCode: resp.statusCode, errorType };
  } catch (e: any) {
    return { model, status: 'error', errorType: e?.message?.slice(0, 80) ?? 'network' };
  }
}

export async function runAnthropicHealthCheckOnce(): Promise<AnthropicHealthReport> {
  const models = [
    { key: 'haiku', id: env.ANTHROPIC_MODEL_HAIKU },
    { key: 'sonnet', id: env.ANTHROPIC_MODEL_SONNET },
  ];

  const probes: ModelProbe[] = [];
  for (const m of models) {
    const p = await probeModel(m.id);
    probes.push(p);
    if (p.status === 'ok') {
      log.info({ model: m.id, role: m.key }, 'anthropic model probe ok');
    } else if (p.status === 'error') {
      log.warn({ model: m.id, role: m.key, statusCode: p.statusCode, errorType: p.errorType }, 'anthropic model probe FAILED');
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    return { status: 'skipped', checkedAt: new Date().toISOString(), models: probes };
  }

  const anyError = probes.some((p) => p.status === 'error');
  return {
    status: anyError ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    models: probes,
  };
}
