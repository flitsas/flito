// OPS-08 — validación del schema Zod para las vars migradas desde process.env.
// Cada caso re-parsea env.ts con vi.resetModules() porque `env` se evalúa al importar.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OPS08_VARS = ['EMPRESA_NIT', 'RNDC_AMBIENTE', 'PRIVACY_RETENTION_CRON_ENABLED'] as const;

function clearOps08() {
  for (const k of OPS08_VARS) delete process.env[k];
}

beforeEach(() => { clearOps08(); vi.resetModules(); });
afterEach(() => { clearOps08(); });

describe('OPS-08 · env.ts schema', () => {
  it('defaults: EMPRESA_NIT=900000001, RNDC_AMBIENTE=sandbox, cron deshabilitado', async () => {
    const { env } = await import('../../src/config/env.js');
    expect(env.EMPRESA_NIT).toBe('900000001');
    expect(env.RNDC_AMBIENTE).toBe('sandbox');
    expect(env.PRIVACY_RETENTION_CRON_ENABLED).toBe(false);
  });

  it('PRIVACY_RETENTION_CRON_ENABLED=1 → boolean true', async () => {
    process.env.PRIVACY_RETENTION_CRON_ENABLED = '1';
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect(env.PRIVACY_RETENTION_CRON_ENABLED).toBe(true);
  });

  it('PRIVACY_RETENTION_CRON_ENABLED=0 / cualquier ≠1 → false', async () => {
    process.env.PRIVACY_RETENTION_CRON_ENABLED = '0';
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect(env.PRIVACY_RETENTION_CRON_ENABLED).toBe(false);
  });

  it('EMPRESA_NIT y RNDC_AMBIENTE válidos se respetan', async () => {
    process.env.EMPRESA_NIT = '901234567';
    process.env.RNDC_AMBIENTE = 'produccion';
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect(env.EMPRESA_NIT).toBe('901234567');
    expect(env.RNDC_AMBIENTE).toBe('produccion');
  });

  it('RNDC_AMBIENTE inválido → boot falla', async () => {
    process.env.RNDC_AMBIENTE = 'staging';
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow();
  });

  it('EMPRESA_NIT no numérico → boot falla', async () => {
    process.env.EMPRESA_NIT = 'no-es-nit';
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow();
  });
});
