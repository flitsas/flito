import { describe, it, expect } from 'vitest';
import { assessRisk, nextReviewDate, isValidFactor } from '../../src/modules/laft/risk.service.js';

describe('laft/risk.service — assessRisk', () => {
  it('score 4-6 → bajo, revisión 24m', () => {
    expect(assessRisk({ counterparty: 1, product: 1, channel: 1, jurisdiction: 1 }))
      .toEqual({ level: 'bajo', score: 4, nextReviewMonths: 24 });
    expect(assessRisk({ counterparty: 2, product: 2, channel: 1, jurisdiction: 1 }))
      .toEqual({ level: 'bajo', score: 6, nextReviewMonths: 24 });
  });

  it('score 7-9 → medio, revisión 12m', () => {
    expect(assessRisk({ counterparty: 2, product: 2, channel: 2, jurisdiction: 1 }))
      .toEqual({ level: 'medio', score: 7, nextReviewMonths: 12 });
    expect(assessRisk({ counterparty: 3, product: 3, channel: 2, jurisdiction: 1 }))
      .toEqual({ level: 'medio', score: 9, nextReviewMonths: 12 });
  });

  it('score 10-12 → alto, revisión 6m', () => {
    expect(assessRisk({ counterparty: 3, product: 3, channel: 3, jurisdiction: 1 }))
      .toEqual({ level: 'alto', score: 10, nextReviewMonths: 6 });
    expect(assessRisk({ counterparty: 3, product: 3, channel: 3, jurisdiction: 3 }))
      .toEqual({ level: 'alto', score: 12, nextReviewMonths: 6 });
  });

  it('límites exactos: 6→bajo, 7→medio, 9→medio, 10→alto', () => {
    expect(assessRisk({ counterparty: 3, product: 1, channel: 1, jurisdiction: 1 }).level).toBe('bajo'); // 6
    expect(assessRisk({ counterparty: 1, product: 2, channel: 2, jurisdiction: 2 }).level).toBe('medio'); // 7
    expect(assessRisk({ counterparty: 3, product: 3, channel: 2, jurisdiction: 1 }).level).toBe('medio'); // 9
    expect(assessRisk({ counterparty: 3, product: 3, channel: 3, jurisdiction: 1 }).level).toBe('alto'); // 10
  });
});

describe('laft/risk.service — nextReviewDate', () => {
  // NOTA: Usamos new Date(YYYY, M-1, D) (local midnight) en vez de ISO strings ('YYYY-MM-DDTZ')
  // para evitar shifts de timezone (Bogotá UTC-5 → fecha aparente -1 día con ISO Z).
  it('suma N meses a la fecha base y devuelve YYYY-MM-DD', () => {
    const base = new Date(2026, 0, 15, 12, 0, 0); // 2026-01-15 mediodía local
    const r = nextReviewDate(6, base);
    expect(r).toBe('2026-07-15');
  });

  it('cruza año correctamente (oct + 12m)', () => {
    const base = new Date(2026, 9, 1, 12, 0, 0);
    expect(nextReviewDate(12, base)).toBe('2027-10-01');
  });

  it('cruza año (dic + 1m → ene siguiente)', () => {
    const base = new Date(2026, 11, 15, 12, 0, 0);
    expect(nextReviewDate(1, base)).toBe('2027-01-15');
  });

  it('sin from explícito → usa Date.now()', () => {
    const r = nextReviewDate(6);
    expect(r).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const yearAhead = new Date(r);
    expect(yearAhead.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('laft/risk.service — isValidFactor', () => {
  it('1, 2, 3 → true', () => {
    expect(isValidFactor(1)).toBe(true);
    expect(isValidFactor(2)).toBe(true);
    expect(isValidFactor(3)).toBe(true);
  });

  it('0, 4, NaN, decimal, string, null, undefined → false', () => {
    expect(isValidFactor(0)).toBe(false);
    expect(isValidFactor(4)).toBe(false);
    expect(isValidFactor(NaN)).toBe(false);
    expect(isValidFactor(2.5)).toBe(false);
    expect(isValidFactor('2')).toBe(false);
    expect(isValidFactor(null)).toBe(false);
    expect(isValidFactor(undefined)).toBe(false);
  });
});
