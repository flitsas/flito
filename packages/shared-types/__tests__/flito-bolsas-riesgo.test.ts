import { describe, it, expect } from 'vitest';
import {
  NivelRiesgoBolsa, nivelRiesgoDe, porcentajeSaldo,
  UMBRAL_RIESGO_BAJO, UMBRAL_RIESGO_CRITICO,
} from '../src/flito-bolsas';

// Nivel de riesgo del saldo prepago (HU #11125, Feature #11120 §7).
//
// Vive en shared-types y no en el backend porque el tablero pinta el mismo nivel que calcula la API.
// Por eso se prueba aquí la regla pura: si un día alguien duplica los umbrales en la web, estos
// tests siguen siendo el único sitio donde están escritos una sola vez.

describe('nivelRiesgoDe — la tabla de umbrales del AC1', () => {
  // Base de 100.000 para que el porcentaje se lea directo en el saldo.
  const BASE = 100000;

  it('40 % de la última recarga → normal', () => {
    expect(nivelRiesgoDe(40000, BASE)).toBe(NivelRiesgoBolsa.NORMAL);
  });

  it('25 % → saldo bajo', () => {
    expect(nivelRiesgoDe(25000, BASE)).toBe(NivelRiesgoBolsa.BAJO);
  });

  it('8 % → saldo crítico', () => {
    expect(nivelRiesgoDe(8000, BASE)).toBe(NivelRiesgoBolsa.CRITICO);
  });

  it('saldo cero → agotada', () => {
    expect(nivelRiesgoDe(0, BASE)).toBe(NivelRiesgoBolsa.AGOTADA);
  });

  it('saldo negativo también es agotada, no un nivel aparte', () => {
    // La bolsa puede quedar en negativo cuando el organismo ya aprobó el gasto; para el panel es
    // el mismo caso urgente que el cero.
    expect(nivelRiesgoDe(-250000, BASE)).toBe(NivelRiesgoBolsa.AGOTADA);
  });
});

describe('nivelRiesgoDe — los bordes exactos de cada umbral', () => {
  const BASE = 100000;

  it('justo en el 30 % todavía es bajo, y un peso más ya es normal', () => {
    expect(UMBRAL_RIESGO_BAJO).toBe(30);
    expect(nivelRiesgoDe(30000, BASE)).toBe(NivelRiesgoBolsa.BAJO);
    expect(nivelRiesgoDe(30001, BASE)).toBe(NivelRiesgoBolsa.NORMAL);
  });

  it('justo en el 10 % ya es crítico, y un peso más es solo bajo', () => {
    expect(UMBRAL_RIESGO_CRITICO).toBe(10);
    expect(nivelRiesgoDe(10000, BASE)).toBe(NivelRiesgoBolsa.CRITICO);
    expect(nivelRiesgoDe(10001, BASE)).toBe(NivelRiesgoBolsa.BAJO);
  });

  it('un saldo por encima de la última recarga es normal', () => {
    expect(nivelRiesgoDe(250000, BASE)).toBe(NivelRiesgoBolsa.NORMAL);
  });
});

describe('nivelRiesgoDe — sin base contra la que comparar', () => {
  it('sin recargas previas → sin_recargas, aunque el saldo sea cero', () => {
    // Un cliente que nunca ha recargado no es lo mismo que uno que se quedó sin saldo: mezclarlos
    // llenaría el panel de alertas de clientes que aún no han empezado a operar.
    expect(nivelRiesgoDe(0, null)).toBe(NivelRiesgoBolsa.SIN_RECARGAS);
    expect(nivelRiesgoDe(500000, null)).toBe(NivelRiesgoBolsa.SIN_RECARGAS);
  });

  it('última recarga en 0 → sin_recargas, sin dividir por cero', () => {
    // El dato existe pero no sirve de base. Sin este corte saldría un Infinity o un NaN de la
    // división, y el nivel dependería de cómo se comparara ese NaN.
    expect(nivelRiesgoDe(500000, 0)).toBe(NivelRiesgoBolsa.SIN_RECARGAS);
    expect(nivelRiesgoDe(0, 0)).toBe(NivelRiesgoBolsa.SIN_RECARGAS);
  });

  it('una última recarga negativa tampoco sirve de base', () => {
    expect(nivelRiesgoDe(100, -5000)).toBe(NivelRiesgoBolsa.SIN_RECARGAS);
  });
});

describe('porcentajeSaldo — lo que se pinta junto al nivel', () => {
  it('redondea a un decimal', () => {
    expect(porcentajeSaldo(33333, 100000)).toBe(33.3);
    expect(porcentajeSaldo(50000, 100000)).toBe(50);
  });

  it('sin base devuelve null, no cero: son cosas distintas', () => {
    // Un cero se pintaría como «0 % de su recarga»; null es «no hay recarga contra la que medir».
    expect(porcentajeSaldo(500000, null)).toBeNull();
    expect(porcentajeSaldo(500000, 0)).toBeNull();
  });

  it('un saldo negativo da porcentaje negativo', () => {
    expect(porcentajeSaldo(-20000, 100000)).toBe(-20);
  });

  it('concuerda con el nivel: el porcentaje del borde crítico es 10', () => {
    // El panel muestra los dos juntos; que uno diga «crítico» y el otro «12 %» sería un fallo
    // silencioso de confianza.
    expect(porcentajeSaldo(10000, 100000)).toBe(UMBRAL_RIESGO_CRITICO);
    expect(nivelRiesgoDe(10000, 100000)).toBe(NivelRiesgoBolsa.CRITICO);
  });
});
