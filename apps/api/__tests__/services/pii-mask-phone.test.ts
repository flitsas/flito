// Feature #14324 — `maskPhone`: la parte visible está acotada a cualquier longitud y nunca lanza. Antes, con 7 dígitos devolvía
// el número en claro, con 8 mostraba 7, y con 5 o 6 lanzaba RangeError.
import { describe, it, expect } from 'vitest';
import { maskPhone, maskPII } from '../../src/shared/utils/pii.js';

describe('maskPhone', () => {
  it.each([
    ['1', '*'],
    ['1234', '****'],
    ['12345', '***45'],
    ['123456', '****56'],
    ['1234567', '*****67'],
    ['12345678', '******78'],
    ['123456789', '*******89'],
    ['3103334567', '310***4567'],
    ['57310333456', '573****3456'],
    ['573103334567', '573*****4567'],
    ['+57 300 342 7829', '573*****7829'],
  ])('%s → %s', (entrada, salida) => {
    expect(maskPhone(entrada)).toBe(salida);
  });

  it.each([[null], [undefined], [''], ['sin numero']])('%j no tiene dígitos → cadena vacía', (entrada) => {
    expect(maskPhone(entrada)).toBe('');
  });

  it('a cualquier longitud no lanza, no muestra el número y nunca más de 7 dígitos', () => {
    for (let largo = 0; largo <= 40; largo += 1) {
      const numero = '1234567890'.repeat(4).slice(0, largo);
      const mascara = maskPhone(numero);
      expect(mascara.length).toBe(largo);
      expect(mascara.replace(/\*/g, '').length).toBeLessThanOrEqual(7);
      if (largo > 0) expect(mascara).not.toBe(numero);
    }
  });

  it('maskPII usa la misma regla y conserva el formato de 10 dígitos', () => {
    expect(maskPII({ telefono: '3103334567', celular: '4441234' })).toEqual({ telefono: '310***4567', celular: '*****34' });
  });
});
