import { describe, it, expect } from 'vitest';
import { summarizeRuntMultasComparendos } from '@operaciones/shared-types';

describe('summarizeRuntMultasComparendos', () => {
  it('objeto tieneMultas NO → sin comparendos', () => {
    const r = summarizeRuntMultasComparendos({ tieneMultas: 'NO', valorTotal: 0 });
    expect(r).toEqual({ resolved: true, total: 0, totalMonto: 0 });
  });

  it('objeto tieneMultas SI → comparendos', () => {
    const r = summarizeRuntMultasComparendos({ tieneMultas: 'SI', totalMultas: 2, valorTotal: 150000 });
    expect(r?.total).toBe(2);
    expect(r?.totalMonto).toBe(150000);
  });

  it('array vacío → sin comparendos', () => {
    expect(summarizeRuntMultasComparendos([])).toEqual({ resolved: true, total: 0, totalMonto: 0 });
  });

  it('null → no resuelto', () => {
    expect(summarizeRuntMultasComparendos(null)).toBeNull();
  });
});
