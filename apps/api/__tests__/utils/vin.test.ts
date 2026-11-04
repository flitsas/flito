// HU #14291 (R3): valores obtenidos ejecutando las dos copias originales (`vehicles/vehiculo-historial.ts`
// y `tramites/lote.ts`), que daban lo mismo en todos.
import { describe, it, expect } from 'vitest';
import { normalizeVin } from '../../src/shared/utils/vin.js';

describe('normalizeVin', () => {
  it.each([
    ['vacío', '', ''],
    ['solo no alfanuméricos', '---', ''],
    ['guiones, barras y minúsculas', 'abc-123/xyz', 'ABC123XYZ'],
    ['espacios', 'wba 3a5c5 0df 123456', 'WBA3A5C50DF123456'],
    ['acentos y eñe se eliminan', 'ñáé-1', '1'],
    ['exactamente 17', 'A'.repeat(17), 'A'.repeat(17)],
    ['18 se corta a 17', 'A'.repeat(18), 'A'.repeat(17)],
    ['más de 17 se corta tras limpiar', 'abcdefghij1234567XYZ', 'ABCDEFGHIJ1234567'],
    ['el corte cuenta lo ya limpio', 'a-b-c-d-e-f-g-h-i-j-1-2-3-4-5-6-7-X', 'ABCDEFGHIJ1234567'],
  ])('%s', (_caso, entrada, esperado) => {
    expect(normalizeVin(entrada)).toBe(esperado);
  });

  it('null y undefined dan cadena vacía', () => {
    expect(normalizeVin(null as unknown as string)).toBe('');
    expect(normalizeVin(undefined as unknown as string)).toBe('');
  });
});
