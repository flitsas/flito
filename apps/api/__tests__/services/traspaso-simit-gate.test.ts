import { describe, expect, it } from 'vitest';
import { validateTraspasoSimitComprador } from '../../src/modules/tramites/traspaso-simit-gate.js';

describe('validateTraspasoSimitComprador', () => {
  it('rechaza sin consulta SIMIT', () => {
    const r = validateTraspasoSimitComprador({}, { documento: '222' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/obligatoria/i);
  });

  it('rechaza documento distinto al consultado', () => {
    const r = validateTraspasoSimitComprador(
      { _simitComprador: { documento: '111', consultado: true, total: 0 } },
      { documento: '222' },
    );
    expect(r.ok).toBe(false);
  });

  it('rechaza comparendos pendientes', () => {
    const r = validateTraspasoSimitComprador(
      { _simitComprador: { documento: '222', consultado: true, total: 2 } },
      { documento: '222' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/comparendos/i);
  });

  it('acepta consulta limpia', () => {
    const r = validateTraspasoSimitComprador(
      { _simitComprador: { documento: '222', consultado: true, total: 0 } },
      { documento: '222' },
    );
    expect(r.ok).toBe(true);
  });
});
