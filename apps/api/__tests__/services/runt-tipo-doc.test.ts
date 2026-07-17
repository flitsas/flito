import { describe, it, expect } from 'vitest';
import { mapTipoDocUiToRunt, tiposPersonaAIntentar, tiposVehiculoAIntentar } from '../../src/modules/runt/runt-tipo-doc.js';

describe('runt-tipo-doc', () => {
  it('mapea CC → C', () => {
    expect(mapTipoDocUiToRunt('CC')).toBe('C');
    expect(mapTipoDocUiToRunt('cc')).toBe('C');
  });

  it('mapea CE, TI, PAS, PPT', () => {
    expect(mapTipoDocUiToRunt('CE')).toBe('E');
    expect(mapTipoDocUiToRunt('TI')).toBe('T');
    expect(mapTipoDocUiToRunt('PAS')).toBe('P');
    expect(mapTipoDocUiToRunt('PPT')).toBe('Y');
    expect(mapTipoDocUiToRunt('NIT')).toBe('N');
  });

  it('tiposPersonaAIntentar pone C primero cuando UI es CC', () => {
    expect(tiposPersonaAIntentar('CC')).toEqual(['C', 'T', 'E', 'Y', 'P']);
  });

  it('tiposVehiculoAIntentar pone C primero cuando UI es CC', () => {
    expect(tiposVehiculoAIntentar('CC')[0]).toBe('C');
    expect(tiposVehiculoAIntentar('CE')[0]).toBe('E');
  });

  it('sin tipo usa orden por defecto', () => {
    expect(tiposPersonaAIntentar()).toEqual(['C', 'T', 'E', 'Y', 'P']);
  });
});
