// TRAM-TRASPASO-F1 — workflow STT + radicado (lógica pura de shared-types).

import { describe, it, expect } from 'vitest';
import {
  formatRadicado, puedeTransicionarStt, transicionesDesde, isEstadoSttTraspaso,
} from '@operaciones/shared-types';

describe('formatRadicado', () => {
  it('formatea TD-YYYY-NNNNN con padding', () => {
    expect(formatRadicado(1, 2026)).toBe('TD-2026-00001');
    expect(formatRadicado(42, 2026)).toBe('TD-2026-00042');
    expect(formatRadicado(12345, 2027)).toBe('TD-2027-12345');
  });
});

describe('puedeTransicionarStt', () => {
  it('radicado → en_validacion / subsanacion permitido', () => {
    expect(puedeTransicionarStt('radicado', 'en_validacion')).toBe(true);
    expect(puedeTransicionarStt('radicado', 'subsanacion')).toBe(true);
  });
  it('subsanacion ↔ en_validacion (ida y vuelta)', () => {
    expect(puedeTransicionarStt('en_validacion', 'subsanacion')).toBe(true);
    expect(puedeTransicionarStt('subsanacion', 'en_validacion')).toBe(true);
  });
  it('saltos inválidos rechazados', () => {
    expect(puedeTransicionarStt('radicado', 'entregado')).toBe(false);
    expect(puedeTransicionarStt('radicado', 'aprobado')).toBe(false);
  });
  it('estados terminales no transicionan', () => {
    expect(puedeTransicionarStt('entregado', 'en_validacion')).toBe(false);
    expect(puedeTransicionarStt('anulado', 'radicado')).toBe(false);
  });
  it('estado no-STT → false', () => {
    expect(puedeTransicionarStt('borrador', 'radicado')).toBe(false);
    expect(isEstadoSttTraspaso('borrador')).toBe(false);
    expect(isEstadoSttTraspaso('subsanacion')).toBe(true);
  });
});

describe('transicionesDesde', () => {
  it('lista los siguientes estados válidos', () => {
    expect(transicionesDesde('radicado')).toContain('en_validacion');
    expect(transicionesDesde('entregado')).toEqual([]);
    expect(transicionesDesde('borrador')).toEqual([]);
  });
});
