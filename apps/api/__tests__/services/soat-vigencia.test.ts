// QA P1 — regla SOAT vigente (matrícula inicial no pide SOAT si ya hay uno activo).

import { describe, it, expect } from 'vitest';
import { soatVigenteDeRunt } from '../../src/modules/tramites/soat-vigencia.js';

const NOW = new Date('2026-06-16T00:00:00Z').getTime();

describe('soatVigenteDeRunt', () => {
  it('SOAT con póliza y vencimiento futuro → vigente (caso trámite 31)', () => {
    const veh = { soat: { numSoat: '1508006966552000', fechaVencimSoat: '2027-06-12T00:00:00.000-05:00', estado: 'VIGENTE' } };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(true);
  });

  it('SOAT vencido → NO vigente (manda la fecha, no el estado)', () => {
    const veh = { soat: { numSoat: '123', fechaVencimSoat: '2025-01-01T00:00:00.000-05:00', estado: 'VIGENTE' } };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(false);
  });

  it('sin número de póliza → NO vigente', () => {
    const veh = { soat: { fechaVencimSoat: '2027-06-12', estado: 'VIGENTE' } };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(false);
  });

  it('sin SOAT → NO vigente', () => {
    expect(soatVigenteDeRunt({}, NOW)).toBe(false);
    expect(soatVigenteDeRunt(null, NOW)).toBe(false);
  });

  it('sin fecha parseable pero estado VIGENTE + póliza → vigente', () => {
    const veh = { soat: { numSoat: '123', estado: 'VIGENTE' } };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(true);
  });

  it('sin fecha y estado distinto de VIGENTE → NO vigente', () => {
    const veh = { soat: { numSoat: '123', estado: 'NO VIGENTE' } };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(false);
  });

  it('soat como array → usa el primer elemento', () => {
    const veh = { soat: [{ numSoat: '123', fechaVencimSoat: '2027-06-12', estado: 'VIGENTE' }] };
    expect(soatVigenteDeRunt(veh, NOW)).toBe(true);
  });
});
