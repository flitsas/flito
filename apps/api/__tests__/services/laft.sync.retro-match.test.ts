import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: vi.fn(),
    delete: vi.fn(),
    transaction: transactionMock,
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/modules/jornadas/notify.js', () => ({
  getAdminEmails: vi.fn().mockResolvedValue(['admin@kyverum.com']),
}));

beforeEach(() => {
  executeMock.mockReset();
  insertMock.mockReset();
  transactionMock.mockReset();
  selectMock.mockReset();
});

describe('laft/sync/retro-match — runRetroMatch', () => {
  it('addedSourceIds vacío retorna 0 sin tocar BD', async () => {
    const { runRetroMatch } = await import('../../src/modules/laft/sync/retro-match.service.js');
    const r = await runRetroMatch({ listId: 1, listCode: 'OFAC', listName: 'OFAC SDN', binding: true, addedSourceIds: [] });
    expect(r.newMatches).toEqual(0);
    expect(executeMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('hits con score >= 85 generan list_check + unusual_operation por contraparte', async () => {
    // Mock pg query: 2 hits, mismo cp_id 100, contra 2 entries diferentes (consolidados a 1 unusual_op)
    executeMock.mockResolvedValueOnce({
      rows: [
        { cp_id: 100, cp_full_name: 'Vladimir Aleman', cp_doc_number: '11111', entry_id: 50, entry_full_name: 'VLADIMIR ALEMAN', entry_doc_number: null, score: 96, kind: 'name_strong' },
        { cp_id: 100, cp_full_name: 'Vladimir Aleman', cp_doc_number: '11111', entry_id: 51, entry_full_name: 'VLADIMIRO ALEMAN', entry_doc_number: null, score: 88, kind: 'name_strong' },
      ],
    });

    const txInsertCalls: Array<{ table: string; values: unknown }> = [];
    transactionMock.mockImplementationOnce(async (fn: any) => {
      const tx = {
        insert: (table: any) => ({
          values: (vals: unknown) => {
            const tableName = table?._?.name ?? table?.name ?? 'unknown';
            txInsertCalls.push({ table: tableName, values: vals });
            return Promise.resolve(undefined);
          },
        }),
      };
      await fn(tx);
    });

    // outbox notification insert (fuera de la TX)
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const { runRetroMatch } = await import('../../src/modules/laft/sync/retro-match.service.js');
    const r = await runRetroMatch({
      listId: 1,
      listCode: 'OFAC',
      listName: 'OFAC SDN',
      binding: true,
      addedSourceIds: ['NEW-1', 'NEW-2'],
    });

    expect(r.newMatches).toEqual(1); // 2 hits sobre la misma contraparte = 1 unusual_op
    // 2 list_checks + 1 unusual_op = 3 inserts dentro de la transacción
    expect(txInsertCalls.length).toEqual(3);
  });

  it('hits con score < 85 se filtran (no generan registros)', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { cp_id: 200, cp_full_name: 'X', cp_doc_number: '999', entry_id: 80, entry_full_name: 'Y', entry_doc_number: null, score: 70, kind: 'name_partial' },
      ],
    });

    const { runRetroMatch } = await import('../../src/modules/laft/sync/retro-match.service.js');
    const r = await runRetroMatch({
      listId: 1, listCode: 'UN', listName: 'UN List', binding: true, addedSourceIds: ['IND-X'],
    });
    expect(r.newMatches).toEqual(0);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('múltiples contrapartes con hits → múltiples unusual_operations', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { cp_id: 1, cp_full_name: 'A', cp_doc_number: '1', entry_id: 10, entry_full_name: 'A1', entry_doc_number: null, score: 100, kind: 'doc_exact' },
        { cp_id: 2, cp_full_name: 'B', cp_doc_number: '2', entry_id: 11, entry_full_name: 'B1', entry_doc_number: null, score: 92, kind: 'name_strong' },
        { cp_id: 3, cp_full_name: 'C', cp_doc_number: '3', entry_id: 12, entry_full_name: 'C1', entry_doc_number: null, score: 87, kind: 'name_strong' },
      ],
    });

    const txInsertCalls: Array<{ values: unknown }> = [];
    transactionMock.mockImplementationOnce(async (fn: any) => {
      const tx = {
        insert: () => ({
          values: (vals: unknown) => {
            txInsertCalls.push({ values: vals });
            return Promise.resolve(undefined);
          },
        }),
      };
      await fn(tx);
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const { runRetroMatch } = await import('../../src/modules/laft/sync/retro-match.service.js');
    const r = await runRetroMatch({
      listId: 1, listCode: 'EU', listName: 'EU Sanctions', binding: true, addedSourceIds: ['EU-A', 'EU-B', 'EU-C'],
    });
    expect(r.newMatches).toEqual(3);
    // 3 list_checks + 3 unusual_operations = 6 inserts
    expect(txInsertCalls.length).toEqual(6);
  });
});
