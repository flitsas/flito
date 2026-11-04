// HU #14291 (R9): valores obtenidos ejecutando las dos copias originales (`round2` de `liquidacion` y
// `redondear` de `flito-liquidacion`), que daban lo mismo en todos. `toBe` usa `Object.is`: distingue -0.
import { describe, it, expect } from 'vitest';
import { redondear } from '../../src/shared/utils/redondeo.js';

describe('redondear', () => {
  it.each([
    [0, 0],
    [-0, -0],
    [1, 1],
    [1.005, 1],
    [1.255, 1.25],
    [1.115, 1.12],
    [2.675, 2.68],
    [0.1 + 0.2, 0.3],
    [100.004, 100],
    [100.005, 100.01],
    [0.004, 0],
    [0.005, 0.01],
    [1234567.895, 1234567.9],
    [999999999999.99, 999999999999.99],
  ])('positivos y cero: %s da %s', (entrada, esperado) => {
    expect(redondear(entrada)).toBe(esperado);
  });

  it.each([
    [-1.005, -1],
    [-1.006, -1.01],
    [-1.555, -1.55],
    [-0.001, -0],
    [-0.005, -0],
  ])('negativos: %s da %s', (entrada, esperado) => {
    expect(redondear(entrada)).toBe(esperado);
  });

  it('valores no numéricos que dejan pasar los llamadores', () => {
    expect(redondear(NaN)).toBeNaN();
    expect(redondear(Infinity)).toBe(Infinity);
    expect(redondear(null as unknown as number)).toBe(0);
    expect(redondear(undefined as unknown as number)).toBeNaN();
  });
});
