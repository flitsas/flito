import type { RiskLevel } from '../risk.service.js';

// Cálculo de risk_level para empleados LAFT.
// Patrón paralelo a counterparties pero con 3 factores en vez de 4 (persona/canal/zona),
// alineado con la matriz UIAF 122/2021 para personal interno.
//
// Score = suma de los tres factores (cada uno 1=bajo, 2=medio, 3=alto).
// 3-4 → bajo (revisión 12m default), 5-6 → medio (12m), 7-9 → alto (6m).
//
// La caja de "antecedentes con hallazgo" o "PEP=true" eleva el riesgo a alto
// independientemente de los factores (regla §10 política UIAF: PEP siempre alto).

export interface EmpFactor {
  // El JSONB de cada factor puede traer { value, ... } u otra estructura libre.
  // Aquí sólo nos importa el campo numérico `value` 1..3.
  value?: number;
  [k: string]: unknown;
}

export interface EmpRiskInput {
  factorPersona?: EmpFactor | null;
  factorCanal?: EmpFactor | null;
  factorZona?: EmpFactor | null;
  pep: boolean;
  antecedentesResultado?: { procuraduria?: string; policia?: string; contraloria?: string } | null;
}

export interface EmpRiskAssessment {
  level: RiskLevel;
  score: number;
  nextReviewMonths: number;
  reasons: string[];
}

function valueOf(f: EmpFactor | null | undefined): number {
  if (!f || typeof f.value !== 'number') return 1;
  if (f.value < 1 || f.value > 3) return 1;
  return f.value;
}

function antecedentesHasHit(r: EmpRiskInput['antecedentesResultado']): boolean {
  if (!r) return false;
  return Object.values(r).some((v) => v && String(v).toLowerCase() !== 'limpio');
}

export function assessEmployeeRisk(input: EmpRiskInput): EmpRiskAssessment {
  const fp = valueOf(input.factorPersona);
  const fc = valueOf(input.factorCanal);
  const fz = valueOf(input.factorZona);
  const score = fp + fc + fz;
  const reasons: string[] = [];

  let level: RiskLevel;
  if (score >= 7) { level = 'alto'; reasons.push(`score factores=${score} ≥ 7`); }
  else if (score >= 5) { level = 'medio'; reasons.push(`score factores=${score} (5-6)`); }
  else { level = 'bajo'; reasons.push(`score factores=${score} (3-4)`); }

  // Reglas de elevación independientes de score.
  if (input.pep) {
    if (level !== 'alto') reasons.push('PEP=true → elevado a alto');
    level = 'alto';
  }
  if (antecedentesHasHit(input.antecedentesResultado)) {
    if (level !== 'alto') reasons.push('antecedentes con hallazgo → elevado a alto');
    level = 'alto';
  }

  // ReKYC: alto cada 6m, medio/bajo cada 12m (UIAF 122/2021 mínimo anual).
  const nextReviewMonths = level === 'alto' ? 6 : 12;
  return { level, score, nextReviewMonths, reasons };
}

/**
 * Devuelve la próxima fecha de reKYC en formato YYYY-MM-DD.
 * Equivale a `nextReviewDate` de risk.service.ts pero con default 12m.
 */
export function nextEmployeeReviewDate(months = 12, from: Date = new Date()): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
