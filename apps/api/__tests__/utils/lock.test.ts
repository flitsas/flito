import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const insertMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    insert: insertMock,
    delete: deleteMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

describe('lock util — acquireLock (UPSERT atómico)', () => {
  beforeEach(() => {
    insertMock.mockReset();
    deleteMock.mockReset();
  });

  it('insert exitoso (no existe) → returning con fila → true', async () => {
    insertMock.mockReturnValueOnce(chain([{ acquiredBy: 'host-1' }]));
    const { acquireLock } = await import('../../src/shared/utils/lock.js');
    const got = await acquireLock('cron-x', 60_000);
    expect(got).toBe(true);
  });

  it('conflict pero update aplicó por expiración → returning con fila → true', async () => {
    insertMock.mockReturnValueOnce(chain([{ acquiredBy: 'host-2' }]));
    const { acquireLock } = await import('../../src/shared/utils/lock.js');
    const got = await acquireLock('cron-x', 60_000);
    expect(got).toBe(true);
  });

  it('lock vigente (ON CONFLICT WHERE no aplica) → returning vacío → false', async () => {
    insertMock.mockReturnValueOnce(chain([]));
    const { acquireLock } = await import('../../src/shared/utils/lock.js');
    const got = await acquireLock('cron-x', 60_000);
    expect(got).toBe(false);
  });

  it('captura los valores: ttl reflejado en expiresAt > acquiredAt', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return chain([{ acquiredBy: 'h' }]); },
    });
    const { acquireLock } = await import('../../src/shared/utils/lock.js');
    await acquireLock('cron-x', 60_000);
    expect(captured.lockName).toBe('cron-x');
    expect(captured.expiresAt.getTime()).toBeGreaterThan(captured.acquiredAt.getTime());
    expect(captured.expiresAt.getTime() - captured.acquiredAt.getTime()).toBe(60_000);
    expect(captured.acquiredBy).toMatch(/.+-\d+$/); // hostname-pid
  });
});

describe('lock util — releaseLock', () => {
  beforeEach(() => {
    insertMock.mockReset();
    deleteMock.mockReset();
  });

  it('delete por (lockName + acquiredBy=hostId) — no throw aún si delete falla', async () => {
    deleteMock.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const { releaseLock } = await import('../../src/shared/utils/lock.js');
    await expect(releaseLock('cron-x')).resolves.toBeUndefined();
  });

  it('si delete throws → silencioso (log error) — no propaga', async () => {
    deleteMock.mockReturnValueOnce({
      where: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    const { releaseLock } = await import('../../src/shared/utils/lock.js');
    await expect(releaseLock('cron-x')).resolves.toBeUndefined();
  });
});

describe('lock util — withLock', () => {
  beforeEach(() => {
    insertMock.mockReset();
    deleteMock.mockReset();
  });

  it('lock obtenido → ejecuta fn y devuelve su resultado', async () => {
    insertMock.mockReturnValueOnce(chain([{ acquiredBy: 'h' }]));
    deleteMock.mockReturnValueOnce({ where: vi.fn().mockResolvedValue(undefined) });
    const { withLock } = await import('../../src/shared/utils/lock.js');
    const fn = vi.fn().mockResolvedValue('result-value');
    const r = await withLock('cron-x', 60_000, fn);
    expect(r).toBe('result-value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lock NO obtenido → fn no se ejecuta, devuelve null', async () => {
    insertMock.mockReturnValueOnce(chain([])); // returning vacío
    const { withLock } = await import('../../src/shared/utils/lock.js');
    const fn = vi.fn().mockResolvedValue('nope');
    const r = await withLock('cron-x', 60_000, fn);
    expect(r).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('si fn throws → release igualmente se llama (finally)', async () => {
    insertMock.mockReturnValueOnce(chain([{ acquiredBy: 'h' }]));
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    deleteMock.mockReturnValueOnce({ where: whereSpy });
    const { withLock } = await import('../../src/shared/utils/lock.js');
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withLock('cron-x', 60_000, fn)).rejects.toThrow('boom');
    expect(whereSpy).toHaveBeenCalledTimes(1); // release ejecutó
  });

  it('lock NO obtenido → release NO se llama (no se adquirió)', async () => {
    insertMock.mockReturnValueOnce(chain([]));
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    deleteMock.mockReturnValueOnce({ where: whereSpy });
    const { withLock } = await import('../../src/shared/utils/lock.js');
    await withLock('cron-x', 60_000, vi.fn());
    expect(whereSpy).not.toHaveBeenCalled();
  });
});
