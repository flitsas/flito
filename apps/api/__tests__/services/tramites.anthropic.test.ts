import { describe, it, expect, beforeEach } from 'vitest';
import { anthropicMessages } from '../../src/modules/tramites/anthropic.js';
import { registry } from '../../src/shared/metrics.js';
import { env } from '../../src/config/env.js';

// Forzar rama no_key: setup.ts no define la key, pero dotenv puede cargarla desde
// apps/api/.env en dev local. Sin esto el test golpea la red y registra result=error.
describe('TRAM-11 · anthropicMessages — error path (sin key, sin red)', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = undefined;
  });
  it('sin API key → {ok:false, status 503, mensaje usable} (degradación graceful)', async () => {
    const r = await anthropicMessages({ model: 'x', messages: [] }, 'ocr');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.message).toMatch(/manual/i);
    }
  });

  it('incrementa el counter tram_anthropic_request_total', async () => {
    await anthropicMessages({ model: 'x', messages: [] }, 'biometric');
    const out = await registry.metrics();
    expect(out).toContain('tram_anthropic_request_total');
    expect(out).toMatch(/tram_anthropic_request_total\{op="biometric",result="no_key"\}\s+\d/);
  });
});
