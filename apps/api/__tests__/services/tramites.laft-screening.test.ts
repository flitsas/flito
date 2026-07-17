// EPIC TRAM-INNOV · B6 (Sprint C) — screening LAFT en pre-vuelo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MatchResult } from '../../src/modules/laft/match.service.js';

const { checkAllListsMock } = vi.hoisted(() => ({ checkAllListsMock: vi.fn() }));

// Mock parcial: checkAllLists mockeado; decideFromMatches real (pura).
vi.mock('../../src/modules/laft/match.service.js', async (orig) => ({
  ...(await orig()),
  checkAllLists: checkAllListsMock,
}));
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

import { mapScreening, screenParte, docLast4 } from '../../src/modules/tramites/laft-screening.js';

function m(over: Partial<MatchResult>): MatchResult {
  return { listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true, score: 0, kind: 'no_match', entryId: null, entryName: null, entryDoc: null, ...over };
}

beforeEach(() => { checkAllListsMock.mockReset(); });

describe('B6 · mapScreening (puro)', () => {
  it('sin coincidencias significativas → green', () => {
    const r = mapScreening([m({ score: 30, kind: 'no_match' })]);
    expect(r.status).toBe('green');
    expect(r.matches).toBe(0);
    expect(r.topSignal).toBeNull();
  });

  it('coincidencia de referencia (no vinculante, score 70) → yellow', () => {
    const r = mapScreening([m({ binding: false, listCode: 'INTERPOL', score: 70, kind: 'name_partial' })]);
    expect(r.status).toBe('yellow');
    expect(r.matches).toBe(1);
    expect(r.topSignal).toMatch(/INTERPOL · name_partial \(70\)/);
  });

  it('doc_exact en lista vinculante → red (shouldBlock)', () => {
    const r = mapScreening([m({ binding: true, score: 100, kind: 'doc_exact' })]);
    expect(r.status).toBe('red');
  });

  it('name_strong (≥85) en lista vinculante → red (needsReview)', () => {
    const r = mapScreening([m({ binding: true, score: 90, kind: 'name_strong' })]);
    expect(r.status).toBe('red');
  });

  it('topSignal y matches NO exponen nombres/cédulas de la contraparte', () => {
    const r = mapScreening([m({ binding: true, score: 100, kind: 'doc_exact', entryName: 'JUAN PEREZ', entryDoc: '123456' })]);
    expect(JSON.stringify(r)).not.toMatch(/JUAN PEREZ|123456/);
  });
});

describe('B6 · screenParte', () => {
  it('sin documento → null (no aplica)', async () => {
    expect(await screenParte(undefined, 'Juan Perez')).toBeNull();
  });

  it('documento sin nombre → unknown (no llama a LAFT)', async () => {
    const r = await screenParte('1020304050', '');
    expect(r).toEqual({ status: 'unknown', matches: 0, topSignal: null });
    expect(checkAllListsMock).not.toHaveBeenCalled();
  });

  it('doc + nombre con hit vinculante → red', async () => {
    checkAllListsMock.mockResolvedValue([m({ binding: true, score: 100, kind: 'doc_exact' })]);
    const r = await screenParte('1020304050', 'Juan Perez');
    expect(r?.status).toBe('red');
    expect(checkAllListsMock).toHaveBeenCalledWith({ docNumber: '1020304050', fullName: 'Juan Perez' });
  });

  it('LAFT falla → degradación a unknown (no lanza)', async () => {
    checkAllListsMock.mockRejectedValue(new Error('db down'));
    const r = await screenParte('1020304050', 'Juan Perez');
    expect(r).toEqual({ status: 'unknown', matches: 0, topSignal: null });
  });
});

describe('B6 · docLast4', () => {
  it('devuelve últimos 4 dígitos, null si <4', () => {
    expect(docLast4('1.020.304.050')).toBe('4050');
    expect(docLast4('12')).toBeNull();
    expect(docLast4(undefined)).toBeNull();
  });
});
