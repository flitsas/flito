// TRAM-INNOV-B3 — check de pre-vuelo `firma_compraventa` (lógica pura de shared-types).
// Vive en apps/api porque shared-types no tiene runner vitest propio (mismo patrón
// que tramites.tipologia-matriz.test.ts).

import { describe, it, expect } from 'vitest';
import { derivaFirmaCompraventaCheck } from '@operaciones/shared-types';

describe('derivaFirmaCompraventaCheck', () => {
  it('tipología != traspaso_standard → null (no aplica)', () => {
    expect(derivaFirmaCompraventaCheck({ tipologiaCodigo: 'sucesion', firmas: [] })).toBeNull();
    expect(derivaFirmaCompraventaCheck({ tipologiaCodigo: null, firmas: [] })).toBeNull();
  });

  it('comprador y vendedor firmada → ok', () => {
    const c = derivaFirmaCompraventaCheck({
      tipologiaCodigo: 'traspaso_standard',
      firmas: [{ rol: 'comprador', estado: 'firmada' }, { rol: 'vendedor', estado: 'firmada' }],
    });
    expect(c?.status).toBe('ok');
    expect(c?.key).toBe('firma_compraventa');
  });

  it('una parte rechazada → fail', () => {
    const c = derivaFirmaCompraventaCheck({
      tipologiaCodigo: 'traspaso_standard',
      firmas: [{ rol: 'comprador', estado: 'firmada' }, { rol: 'vendedor', estado: 'rechazada' }],
    });
    expect(c?.status).toBe('fail');
  });

  it('falta una firma → warn con detalle', () => {
    const c = derivaFirmaCompraventaCheck({
      tipologiaCodigo: 'traspaso_standard',
      firmas: [{ rol: 'comprador', estado: 'firmada' }],
    });
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/vendedor/);
  });

  it('sin firmas → warn (faltan ambas)', () => {
    const c = derivaFirmaCompraventaCheck({ tipologiaCodigo: 'traspaso_standard', firmas: [] });
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/comprador/);
    expect(c?.message).toMatch(/vendedor/);
  });
});
