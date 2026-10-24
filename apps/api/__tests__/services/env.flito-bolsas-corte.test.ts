// HU #13902 (AC1, ADR-0029 D12) — `FLITO_BOLSAS_CORTE_COMPROBANTES`: opcional, se despliega sin valor y
// un valor que no sea una fecha AAAA-MM-DD real tumba el arranque. Cada caso re-parsea env.ts con
// vi.resetModules() porque `env` se evalúa al importar (patrón de env.ops08.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const VAR = 'FLITO_BOLSAS_CORTE_COMPROBANTES';

beforeEach(() => { delete process.env[VAR]; vi.resetModules(); });
afterEach(() => { delete process.env[VAR]; });

describe('FLITO_BOLSAS_CORTE_COMPROBANTES — AC1: el corte se despliega apagado', () => {
  it('TC-01 · sin la variable → undefined (el gancho no descuenta y la liquidación sigue igual)', async () => {
    const { env } = await import('../../src/config/env.js');
    expect(env.FLITO_BOLSAS_CORTE_COMPROBANTES).toBeUndefined();
  });

  it('TC-01 · vacía (`VAR=` en un compose) cuenta como sin valor', async () => {
    process.env[VAR] = '';
    const { env } = await import('../../src/config/env.js');
    expect(env.FLITO_BOLSAS_CORTE_COMPROBANTES).toBeUndefined();
  });

  it('TC-02 · AAAA-MM-DD válida se respeta tal cual', async () => {
    process.env[VAR] = '2026-12-01';
    const { env } = await import('../../src/config/env.js');
    expect(env.FLITO_BOLSAS_CORTE_COMPROBANTES).toBe('2026-12-01');
  });

  it.each(['01/12/2026', '2026-12-1', '2026-12-01T00:00', 'mañana', '2026-02-30', '2026-13-01'])(
    'TC-02 · %s → el arranque falla con error de configuración', async (valor) => {
      process.env[VAR] = valor;
      await expect(import('../../src/config/env.js')).rejects.toThrow(/FLITO_BOLSAS_CORTE_COMPROBANTES/);
    },
  );
});
