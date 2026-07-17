// Cálculo de matriz de riesgo LAFT (§9.1–§9.2 política).
// 4 factores con valores 1 (bajo), 2 (medio), 3 (alto). Score = suma.
// Score 4-6 → bajo (revisión 24m) | 7-9 → medio (12m) | 10-12 → alto (6m + DD intensificada).

export type RiskLevel = 'bajo' | 'medio' | 'alto';

export interface RiskFactors {
  counterparty: number;
  product: number;
  channel: number;
  jurisdiction: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  nextReviewMonths: number;
}

export function assessRisk(f: RiskFactors): RiskAssessment {
  const score = f.counterparty + f.product + f.channel + f.jurisdiction;
  if (score >= 10) return { level: 'alto', score, nextReviewMonths: 6 };
  if (score >= 7) return { level: 'medio', score, nextReviewMonths: 12 };
  return { level: 'bajo', score, nextReviewMonths: 24 };
}

export function nextReviewDate(months: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function isValidFactor(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 3;
}
