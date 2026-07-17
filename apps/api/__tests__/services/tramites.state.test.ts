import { describe, it, expect } from 'vitest';
// Módulo PURO (sin db/metrics/red) → testeable sin mocks ni side-effects.
import { isValidTransition, VALID_ESTADOS, VALID_TRANSITIONS } from '../../src/modules/tramites/tramites.state.js';

describe('TRAM-12a · máquina de estados del trámite', () => {
  it('transiciones válidas conocidas', () => {
    expect(isValidTransition('borrador', 'enviado_transito')).toBe(true);
    expect(isValidTransition('recibido_transito', 'placa_preasignada')).toBe(true);
    expect(isValidTransition('placa_preasignada', 'solicitud_soat')).toBe(true);
  });

  it('transiciones inválidas', () => {
    expect(isValidTransition('borrador', 'completado')).toBe(false);
    expect(isValidTransition('enviado_transito', 'borrador')).toBe(false);
    expect(isValidTransition('enviado_transito', 'rechazado')).toBe(true);
    expect(isValidTransition('completado', 'borrador')).toBe(false);
    expect(isValidTransition('estado_inexistente', 'borrador')).toBe(false);
  });

  it('todo destino de VALID_TRANSITIONS es un estado válido del enum', () => {
    const valid = new Set<string>(VALID_ESTADOS);
    for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
      expect(valid.has(from)).toBe(true);
      for (const to of tos) expect(valid.has(to)).toBe(true);
    }
  });
});
