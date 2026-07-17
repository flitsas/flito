import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const executeMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: executeMock,
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

beforeEach(() => {
  executeMock.mockReset();
  selectMock.mockReset();
});

describe('laft/match.service — normalizeName', () => {
  it('quita tildes, mayúsculas, alfanuméricos, compacta espacios', async () => {
    const { normalizeName } = await import('../../src/modules/laft/match.service.js');
    expect(normalizeName('José  Pérez García')).toBe('JOSE PEREZ GARCIA');
    expect(normalizeName('María-Ñoño')).toBe('MARIA NONO'); // NFD: Ñ → N+tilde, tilde se quita, N queda
    expect(normalizeName("O'Brien & Co.")).toBe('O BRIEN CO');
    expect(normalizeName('  Juan   ')).toBe('JUAN'); // trim + colapsa
  });

  it('string vacío → vacío', async () => {
    const { normalizeName } = await import('../../src/modules/laft/match.service.js');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
});

describe('laft/match.service — normalizeDoc', () => {
  it('quita guiones/puntos, mayúsculas', async () => {
    const { normalizeDoc } = await import('../../src/modules/laft/match.service.js');
    expect(normalizeDoc('900.123.456-7')).toBe('9001234567');
    expect(normalizeDoc('AbC-123')).toBe('ABC123');
  });

  it('null/undefined/vacío → "" (no throw)', async () => {
    const { normalizeDoc } = await import('../../src/modules/laft/match.service.js');
    expect(normalizeDoc(null)).toBe('');
    expect(normalizeDoc(undefined)).toBe('');
    expect(normalizeDoc('')).toBe('');
  });
});

describe('laft/match.service — checkAllLists', () => {
  it('nombre normalizado < 2 chars → array vacío sin tocar BD', async () => {
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: '900', fullName: 'A' });
    expect(r).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('nombre vacío tras normalizar → array vacío', async () => {
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: '900', fullName: '!@#$' });
    expect(r).toEqual([]);
  });

  it('formato {rows: [...]} (node-pg) → mapea correctamente', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { list_id: 1, list_code: 'OFAC', list_name: 'OFAC SDN', binding: true, entry_id: 5, entry_full_name: 'PABLO ESCOBAR', entry_doc_number: '70123456', score: 100, kind: 'doc_exact' },
      ],
    });
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: '70123456', fullName: 'Pablo Escobar' });
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true,
      score: 100, kind: 'doc_exact',
      entryId: 5, entryName: 'PABLO ESCOBAR', entryDoc: '70123456',
    });
  });

  it('entry sin match (entry_id null) → mapea con nulls + kind=no_match', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { list_id: 2, list_code: 'UN', list_name: 'UNSC', binding: true, entry_id: null, entry_full_name: null, entry_doc_number: null, score: 0, kind: 'no_match' },
      ],
    });
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: '999', fullName: 'Pepito Random' });
    expect(r[0]).toEqual({
      listId: 2, listCode: 'UN', listName: 'UNSC', binding: true,
      score: 0, kind: 'no_match',
      entryId: null, entryName: null, entryDoc: null,
    });
  });

  it('múltiples listas → ordenadas por score desc en el resultado', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { list_id: 1, list_code: 'OFAC', list_name: 'OFAC', binding: true, entry_id: 1, entry_full_name: 'X', entry_doc_number: 'D1', score: 90, kind: 'name_strong' },
        { list_id: 2, list_code: 'UN', list_name: 'UN', binding: true, entry_id: null, entry_full_name: null, entry_doc_number: null, score: 0, kind: 'no_match' },
      ],
    });
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: '900', fullName: 'Juan Test' });
    expect(r).toHaveLength(2);
    expect(r[0].score).toBe(90);
    expect(r[1].score).toBe(0);
  });

  it('formato iterable directo (sin .rows wrapper) → también funciona', async () => {
    executeMock.mockResolvedValueOnce([
      { list_id: 1, list_code: 'PEP', list_name: 'PEP COL', binding: false, entry_id: 9, entry_full_name: 'JUAN', entry_doc_number: 'D', score: 85, kind: 'name_strong' },
    ]);
    const { checkAllLists } = await import('../../src/modules/laft/match.service.js');
    const r = await checkAllLists({ docNumber: 'D', fullName: 'Juan' });
    expect(r).toHaveLength(1);
    expect(r[0].listCode).toBe('PEP');
  });
});

describe('laft/match.service — decideFromMatches (decisión de bloqueo)', () => {
  it('doc_exact en lista vinculante → BLOQUEAR automáticamente', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true, score: 100, kind: 'doc_exact', entryId: 1, entryName: 'X', entryDoc: 'D' },
    ]);
    expect(r.shouldBlock).toBe(true);
    expect(r.needsReview).toBe(false);
    expect(r.reason).toMatch(/Coincidencia exacta.*OFAC SDN/);
    expect(r.bindingMatches).toHaveLength(1);
  });

  it('name_strong (score≥85) en vinculante → revisión humana, NO bloqueo', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true, score: 88, kind: 'name_strong', entryId: 1, entryName: 'X', entryDoc: null },
    ]);
    expect(r.shouldBlock).toBe(false);
    expect(r.needsReview).toBe(true);
    expect(r.reason).toMatch(/revisión humana/i);
    expect(r.reason).toContain('OFAC');
  });

  it('match en lista de REFERENCIA (binding=false) → no bloqueo, no review (DD intensificada manual)', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 5, listCode: 'PEP', listName: 'PEP', binding: false, score: 95, kind: 'name_strong', entryId: 1, entryName: 'X', entryDoc: null },
    ]);
    expect(r.shouldBlock).toBe(false);
    expect(r.needsReview).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.bindingMatches).toEqual([]);
  });

  it('name_partial (score 60-84) en vinculante → no review (no llega al threshold 85)', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 70, kind: 'name_partial', entryId: 1, entryName: 'X', entryDoc: null },
    ]);
    expect(r.shouldBlock).toBe(false);
    expect(r.needsReview).toBe(false);
  });

  it('mix: doc_exact (binding) + name_partial → prioriza el doc_exact (bloquear)', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 100, kind: 'doc_exact', entryId: 1, entryName: 'X', entryDoc: 'D' },
      { listId: 2, listCode: 'PEP', listName: 'PEP', binding: false, score: 75, kind: 'name_partial', entryId: 2, entryName: 'Y', entryDoc: null },
    ]);
    expect(r.shouldBlock).toBe(true);
  });

  it('múltiples bindings con name_strong → reason contiene todos los códigos', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([
      { listId: 1, listCode: 'OFAC', listName: 'OFAC', binding: true, score: 90, kind: 'name_strong', entryId: 1, entryName: 'X', entryDoc: null },
      { listId: 2, listCode: 'UN', listName: 'UN', binding: true, score: 87, kind: 'name_strong', entryId: 2, entryName: 'Y', entryDoc: null },
    ]);
    expect(r.needsReview).toBe(true);
    expect(r.reason).toContain('OFAC');
    expect(r.reason).toContain('UN');
    expect(r.bindingMatches).toHaveLength(2);
  });

  it('array vacío → sin bloqueo, sin review', async () => {
    const { decideFromMatches } = await import('../../src/modules/laft/match.service.js');
    const r = decideFromMatches([]);
    expect(r).toEqual({ shouldBlock: false, reason: null, needsReview: false, bindingMatches: [] });
  });
});

describe('laft/match.service — getListsWithCounts', () => {
  it('mapea filas a estructura pública', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, code: 'OFAC', name: 'OFAC SDN', binding: true, totalEntries: 10000, lastSyncedAt: new Date('2026-05-01'), active: true },
      { id: 2, code: 'UN', name: 'UNSC', binding: true, totalEntries: 500, lastSyncedAt: null, active: false },
    ]));
    const { getListsWithCounts } = await import('../../src/modules/laft/match.service.js');
    const r = await getListsWithCounts();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ id: 1, code: 'OFAC', binding: true, totalEntries: 10000, active: true });
    expect(r[1].lastSyncedAt).toBeNull();
  });

  it('lista vacía → []', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const { getListsWithCounts } = await import('../../src/modules/laft/match.service.js');
    expect(await getListsWithCounts()).toEqual([]);
  });
});
