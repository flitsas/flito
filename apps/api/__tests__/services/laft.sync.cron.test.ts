import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    transaction: transactionMock,
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

const fetchOfacMock = vi.fn();
const fetchUnMock = vi.fn();
const fetchEuMock = vi.fn();
vi.mock('../../src/modules/laft/sync/ofac.sync.js', () => ({
  fetchOfac: fetchOfacMock, _internal: {},
}));
vi.mock('../../src/modules/laft/sync/un.sync.js', () => ({
  fetchUn: fetchUnMock, _internal: {},
}));
vi.mock('../../src/modules/laft/sync/eu.sync.js', () => ({
  fetchEu: fetchEuMock, _internal: {},
}));

const applyDiffMock = vi.fn();
vi.mock('../../src/modules/laft/sync/diff.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/laft/sync/diff.service.js')>();
  return { ...actual, applyDiff: applyDiffMock };
});

const runRetroMatchMock = vi.fn();
vi.mock('../../src/modules/laft/sync/retro-match.service.js', () => ({
  runRetroMatch: runRetroMatchMock,
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  transactionMock.mockReset();
  executeMock.mockReset();
  withLockMock.mockReset();
  fetchOfacMock.mockReset();
  fetchUnMock.mockReset();
  fetchEuMock.mockReset();
  applyDiffMock.mockReset();
  runRetroMatchMock.mockReset();

  // Por defecto el lock se obtiene y ejecuta el callback.
  withLockMock.mockImplementation(async (_n: string, _ttl: number, fn: any) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('laft/sync/sync.cron — syncOneList', () => {
  it('lock no obtenido → status=skipped, no fetch, no diff', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'OFAC', trigger: 'cron', triggeredBy: null });
    expect(r.status).toEqual('skipped');
    expect(r.jobId).toEqual(0);
    expect(fetchOfacMock).not.toHaveBeenCalled();
  });

  it('fetch retorna null → job se cierra como failed con errorText', async () => {
    // 1) select de la lista (existe)
    selectMock.mockReturnValueOnce(chain([{ id: 1, code: 'OFAC', name: 'OFAC SDN', binding: true, sourceUrl: 'https://x' }]));
    // 2) insert openJob retorna {id:42}
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 42 }]) }),
    });
    // 3) update closeJob
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    // 4) audit insert
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    fetchOfacMock.mockResolvedValueOnce(null);

    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'OFAC', trigger: 'cron', triggeredBy: null });
    expect(r.status).toEqual('failed');
    expect(r.jobId).toEqual(42);
    expect(r.errorText).toContain('null');
    expect(applyDiffMock).not.toHaveBeenCalled();
    expect(runRetroMatchMock).not.toHaveBeenCalled();
  });

  it('fetch ok + hash idéntico al último success → status=skipped sin diff', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, code: 'OFAC', name: 'OFAC SDN', binding: true, sourceUrl: 'https://x' }]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 99 }]) }) });
    fetchOfacMock.mockResolvedValueOnce({
      listCode: 'OFAC', sourceUrl: 'https://x', sourceHash: 'samehash', entries: [{ sourceId: 'A', fullName: 'X', aliases: null, docType: null, docNumber: null, country: null, birthDate: null, remarks: null }],
    });
    // SELECT del último job exitoso
    selectMock.mockReturnValueOnce(chain([{ hash: 'samehash' }]));
    // closeJob
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });

    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'OFAC', trigger: 'cron', triggeredBy: null });
    expect(r.status).toEqual('skipped');
    expect(applyDiffMock).not.toHaveBeenCalled();
    expect(runRetroMatchMock).not.toHaveBeenCalled();
  });

  it('fetch ok + hash distinto → applyDiff + runRetroMatch + closeJob success', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, code: 'OFAC', name: 'OFAC SDN', binding: true, sourceUrl: 'https://x' }]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 7 }]) }) });
    fetchOfacMock.mockResolvedValueOnce({
      listCode: 'OFAC', sourceUrl: 'https://x', sourceHash: 'newhash',
      entries: [
        { sourceId: 'A', fullName: 'Foo', aliases: null, docType: null, docNumber: null, country: null, birthDate: null, remarks: null },
        { sourceId: 'B', fullName: 'Bar', aliases: null, docType: null, docNumber: null, country: null, birthDate: null, remarks: null },
      ],
    });
    selectMock.mockReturnValueOnce(chain([{ hash: 'oldhash' }]));
    applyDiffMock.mockResolvedValueOnce({
      added: 1, removed: 0, modified: 1, total: 2,
      addedSourceIds: ['A'],
      modifiedSourceIds: ['B'],
    });
    runRetroMatchMock.mockResolvedValueOnce({ newMatches: 2 });
    // closeJob
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    // audit insert
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'OFAC', trigger: 'cron', triggeredBy: null });
    expect(r.status).toEqual('success');
    expect(r.jobId).toEqual(7);
    expect(r.added).toEqual(1);
    expect(r.modified).toEqual(1);
    expect(r.retroMatches).toEqual(2);
    expect(applyDiffMock).toHaveBeenCalledWith({ listId: 1, listCode: 'OFAC', entries: expect.any(Array) });
    expect(runRetroMatchMock).toHaveBeenCalledWith(expect.objectContaining({
      listId: 1, listCode: 'OFAC', addedSourceIds: ['A'],
    }));
  });

  it('lista no existe en laft_restrictive_lists → failed', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no list
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 13 }]) }) });
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });

    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'OFAC', trigger: 'manual', triggeredBy: 99 });
    expect(r.status).toEqual('failed');
    expect(r.errorText).toContain('lista no registrada');
  });

  it('applyDiff throws → job cerrado como failed, no retro-match', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, code: 'UN', name: 'UN', binding: true, sourceUrl: 'https://un' }]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 5 }]) }) });
    fetchUnMock.mockResolvedValueOnce({
      listCode: 'UN', sourceUrl: 'https://un', sourceHash: 'h',
      entries: [{ sourceId: 'A', fullName: 'X', aliases: null, docType: null, docNumber: null, country: null, birthDate: null, remarks: null }],
    });
    selectMock.mockReturnValueOnce(chain([])); // sin último job
    applyDiffMock.mockRejectedValueOnce(new Error('boom diff'));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    const { syncOneList } = await import('../../src/modules/laft/sync/sync.cron.js');
    const r = await syncOneList({ listCode: 'UN', trigger: 'cron', triggeredBy: null });
    expect(r.status).toEqual('failed');
    expect(r.errorText).toContain('boom diff');
    expect(runRetroMatchMock).not.toHaveBeenCalled();
  });
});

describe('laft/sync/sync.cron — start/stop lifecycle', () => {
  it('start es idempotente: 2 calls solo registran 1 timer', async () => {
    vi.useFakeTimers();
    const { startLaftSyncCron, stopLaftSyncCron } = await import('../../src/modules/laft/sync/sync.cron.js');
    startLaftSyncCron();
    startLaftSyncCron();
    stopLaftSyncCron();
    expect(true).toBe(true);
  });

  it('stop sin start es noop seguro', async () => {
    const { stopLaftSyncCron } = await import('../../src/modules/laft/sync/sync.cron.js');
    expect(() => stopLaftSyncCron()).not.toThrow();
  });
});
