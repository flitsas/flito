// Placa por tipo (Épica #14707, bloque 4; UX `docs/ux/flito-tramites-rediseno.md` §7.1). Único punto que
// interpreta el texto libre de `vehicles.tipo_servicio`.

import { describe, it, expect } from 'vitest';
import { esPlacaMoto, normalizarTipoServicio, variantePlaca } from '../src/vehiculo-placa';

describe('normalizarTipoServicio', () => {
  it('null, undefined, vacío y solo espacios → null', () => {
    expect(normalizarTipoServicio(null)).toBeNull();
    expect(normalizarTipoServicio(undefined)).toBeNull();
    expect(normalizarTipoServicio('')).toBeNull();
    expect(normalizarTipoServicio('   ')).toBeNull();
  });

  it('público con y sin tilde, en mayúsculas y con «Servicio» delante → publico', () => {
    for (const v of ['Publico', 'Público', 'PUBLICO', 'PÚBLICO', '  publico ', 'Servicio público', 'SERVICIO   PUBLICO']) {
      expect(normalizarTipoServicio(v), v).toBe('publico');
    }
  });

  it('particular, oficial y diplomático se reconocen sin importar tildes ni mayúsculas', () => {
    expect(normalizarTipoServicio('Particular')).toBe('particular');
    expect(normalizarTipoServicio('OFICIAL')).toBe('oficial');
    expect(normalizarTipoServicio('Diplomático')).toBe('diplomatico');
  });

  it('un valor desconocido no vacío → otro (no aborta, no se inventa)', () => {
    expect(normalizarTipoServicio('Especial')).toBe('otro');
    expect(normalizarTipoServicio('publico especial')).toBe('otro');
  });
});

describe('esPlacaMoto', () => {
  it('AAA00A es moto, también con espacio, guion o minúsculas', () => {
    expect(esPlacaMoto('MNB22F')).toBe(true);
    expect(esPlacaMoto('MNB 22F')).toBe(true);
    expect(esPlacaMoto('mnb-22f')).toBe(true);
  });

  it('el formato viejo AAA45 y la placa de carro AAA000 NO son moto', () => {
    expect(esPlacaMoto('ABC45')).toBe(false);
    expect(esPlacaMoto('KLM482')).toBe(false);
    expect(esPlacaMoto('MNB222')).toBe(false);
  });

  it('sin placa no es moto', () => {
    expect(esPlacaMoto(null)).toBe(false);
    expect(esPlacaMoto(undefined)).toBe(false);
    expect(esPlacaMoto('')).toBe(false);
  });
});

describe('variantePlaca', () => {
  it('sin dato de servicio: particular o moto según la placa', () => {
    expect(variantePlaca('KLM482', null)).toBe('particular');
    expect(variantePlaca('MNB22F', null)).toBe('moto');
  });

  it('servicio público pinta blanca la placa de carro', () => {
    expect(variantePlaca('TRE664', 'Público')).toBe('publico');
  });

  it('precedencia: en una moto pública manda el servicio y se conserva la señal de moto', () => {
    expect(variantePlaca('MNB22F', 'Publico')).toBe('moto-publico');
  });

  it('oficial, diplomático y otro NO cambian el color (quedan como particular)', () => {
    expect(variantePlaca('KLM482', 'Oficial')).toBe('particular');
    expect(variantePlaca('KLM482', 'Diplomático')).toBe('particular');
    expect(variantePlaca('KLM482', 'Especial')).toBe('particular');
    expect(variantePlaca('MNB22F', 'Oficial')).toBe('moto');
  });
});
