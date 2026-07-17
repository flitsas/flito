import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { update: updateMock, select: selectMock },
}));

beforeEach(() => {
  updateMock.mockReset();
  selectMock.mockReset();
  vi.resetModules();
});

describe('validacion-recovery', () => {
  it('recoverStaleByToken devuelve cantidad recuperada', async () => {
    updateMock.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 15 }]),
        }),
      }),
    }));
    const { recoverStaleByToken } = await import('../../src/modules/tramites/validacion-recovery.js');
    const n = await recoverStaleByToken('tok123');
    expect(n).toBe(1);
  });

  it('recoverStaleByToken sin matches → 0', async () => {
    updateMock.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }));
    const { recoverStaleByToken } = await import('../../src/modules/tramites/validacion-recovery.js');
    expect(await recoverStaleByToken('tok')).toBe(0);
  });

  it('countEnProceso lee count de BD', async () => {
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve([{ n: 2 }]),
      }),
    });
    const { countEnProceso } = await import('../../src/modules/tramites/validacion-recovery.js');
    expect(await countEnProceso()).toBe(2);
  });
});
