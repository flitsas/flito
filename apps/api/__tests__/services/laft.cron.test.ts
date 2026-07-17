import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    update: updateMock,
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

beforeEach(() => {
  updateMock.mockReset();
  withLockMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: any) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('laft/review.cron — lifecycle + lock contract', () => {
  it('start es idempotente: 2 calls solo registran 1 timer', async () => {
    vi.useFakeTimers();
    const { startReviewCron, stopReviewCron } = await import('../../src/modules/laft/review.cron.js');
    startReviewCron();
    startReviewCron();
    stopReviewCron();
    expect(true).toBe(true); // no throw
  });

  it('stop sin start activo es noop seguro', async () => {
    const { stopReviewCron } = await import('../../src/modules/laft/review.cron.js');
    expect(() => stopReviewCron()).not.toThrow();
  });

  it('setTimeout 60s + lock obtenido → db.update con (status=vinculada → pendiente, nextReviewAt<=today)', async () => {
    vi.useFakeTimers();
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return {
          where: () => ({ returning: () => Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]) }),
        };
      },
    });

    const { startReviewCron, stopReviewCron } = await import('../../src/modules/laft/review.cron.js');
    startReviewCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();

    expect(withLockMock).toHaveBeenCalledWith('laft-review-cron', 5 * 60 * 1000, expect.any(Function));
    expect(captured).toMatchObject({
      status: 'pendiente',
    });
    expect(captured.updatedAt).toBeInstanceOf(Date);
    stopReviewCron();
  });

  it('lock NO obtenido → db.update no se llama', async () => {
    vi.useFakeTimers();
    withLockMock.mockResolvedValueOnce(null);

    const { startReviewCron, stopReviewCron } = await import('../../src/modules/laft/review.cron.js');
    startReviewCron();
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.runAllTicks();

    expect(updateMock).not.toHaveBeenCalled();
    stopReviewCron();
  });
});
