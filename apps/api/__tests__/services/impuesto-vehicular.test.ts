import { describe, it, expect } from 'vitest';
import { consultarImpuestoVehicular } from '../../src/modules/tramites/impuesto-vehicular.js';
import {
  departamentoKeyFromOrganismoCodigo,
  impuestoIndicaPazSalvo,
} from '@operaciones/shared-types';

describe('departamentoKeyFromOrganismoCodigo', () => {
  it('05001 → antioquia', () => {
    expect(departamentoKeyFromOrganismoCodigo('05001')).toBe('antioquia');
  });
  it('17001 → caldas', () => {
    expect(departamentoKeyFromOrganismoCodigo('17001')).toBe('caldas');
  });
});

describe('impuestoIndicaPazSalvo', () => {
  it('estado Pagado → true', () => {
    expect(impuestoIndicaPazSalvo({ estadoPago: 'Pagado' })).toBe(true);
  });
  it('totalPagar 0 → true', () => {
    expect(impuestoIndicaPazSalvo({ totalPagar: 0 })).toBe(true);
  });
  it('pendiente con deuda → false', () => {
    expect(impuestoIndicaPazSalvo({ estadoPago: 'Pendiente', totalPagar: 500_000 })).toBe(false);
  });
});

describe('consultarImpuestoVehicular', () => {
  it('placa inválida → 400', async () => {
    const r = await consultarImpuestoVehicular({ placa: 'AB' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });

  it('Antioquia sin documento → manual con advertencia', async () => {
    const r = await consultarImpuestoVehicular({ placa: 'ABC123', organismoCodigo: '05001' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fuente).toBe('Manual');
      expect(r.advertencia).toMatch(/cédula/i);
    }
  });

  it('Antioquia con documento → manual (sin automatización headless)', async () => {
    const r = await consultarImpuestoVehicular({ placa: 'ABC123', organismoCodigo: '05001', docNumber: '1234567890' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fuente).toBe('Manual');
      expect(r.advertencia).toMatch(/Antioquia/i);
    }
  });
});
