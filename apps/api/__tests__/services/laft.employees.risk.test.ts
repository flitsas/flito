import { describe, it, expect } from 'vitest';
import { assessEmployeeRisk, nextEmployeeReviewDate } from '../../src/modules/laft/employees/employees.service.js';

describe('laft/employees risk — assessEmployeeRisk', () => {
  it('todos en 1 → bajo, 12m', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 1 }, factorCanal: { value: 1 }, factorZona: { value: 1 },
      pep: false, antecedentesResultado: null,
    });
    expect(r.level).toBe('bajo');
    expect(r.score).toBe(3);
    expect(r.nextReviewMonths).toBe(12);
  });

  it('score 5-6 → medio', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 2 }, factorCanal: { value: 2 }, factorZona: { value: 2 },
      pep: false, antecedentesResultado: null,
    });
    expect(r.level).toBe('medio');
    expect(r.score).toBe(6);
  });

  it('score 7+ → alto, 6m', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 3 }, factorCanal: { value: 3 }, factorZona: { value: 3 },
      pep: false, antecedentesResultado: null,
    });
    expect(r.level).toBe('alto');
    expect(r.nextReviewMonths).toBe(6);
  });

  it('PEP=true eleva a alto independientemente de score', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 1 }, factorCanal: { value: 1 }, factorZona: { value: 1 },
      pep: true, antecedentesResultado: null,
    });
    expect(r.level).toBe('alto');
    expect(r.reasons.some((x) => /PEP/.test(x))).toBe(true);
  });

  it('antecedentes con hallazgo eleva a alto', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 1 }, factorCanal: { value: 1 }, factorZona: { value: 1 },
      pep: false,
      antecedentesResultado: { procuraduria: 'limpio', policia: 'inhabilidad', contraloria: 'limpio' },
    });
    expect(r.level).toBe('alto');
  });

  it('antecedentes "limpio" en todos → no eleva', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 1 }, factorCanal: { value: 1 }, factorZona: { value: 1 },
      pep: false,
      antecedentesResultado: { procuraduria: 'limpio', policia: 'limpio', contraloria: 'limpio' },
    });
    expect(r.level).toBe('bajo');
  });

  it('factor con value fuera de rango → tratado como 1 (defensa)', () => {
    const r = assessEmployeeRisk({
      factorPersona: { value: 99 } as any, factorCanal: null, factorZona: undefined,
      pep: false, antecedentesResultado: null,
    });
    // 1+1+1=3 → bajo
    expect(r.level).toBe('bajo');
  });
});

describe('laft/employees risk — nextEmployeeReviewDate', () => {
  it('formato YYYY-MM-DD', () => {
    expect(nextEmployeeReviewDate(12)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('default 12m suma 1 año', () => {
    const from = new Date('2026-05-08T00:00:00Z');
    const r = nextEmployeeReviewDate(12, from);
    expect(r.startsWith('2027-05')).toBe(true);
  });

  it('6m suma 6 meses', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    const r = nextEmployeeReviewDate(6, from);
    expect(r.startsWith('2026-07')).toBe(true);
  });
});
