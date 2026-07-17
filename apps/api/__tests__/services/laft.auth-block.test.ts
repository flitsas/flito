import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { chain } from '../helpers/db.js';

// Este archivo ejercita la LÓGICA REAL de isUserLaftBlocked (BD + caché), así que
// desactiva el skip global que setup.ts pone para el resto de la suite.
const __prevLaftSkip = process.env.AUTH_SKIP_LAFT_BLOCK_CHECK;
beforeAll(() => { process.env.AUTH_SKIP_LAFT_BLOCK_CHECK = ''; });
afterAll(() => {
  if (__prevLaftSkip === undefined) delete process.env.AUTH_SKIP_LAFT_BLOCK_CHECK;
  else process.env.AUTH_SKIP_LAFT_BLOCK_CHECK = __prevLaftSkip;
});

// Mock del client BD ANTES del import del service (vi.mock se hoist al top).
const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

beforeEach(() => {
  selectMock.mockReset();
});

describe('laft/auth-block.service — caché TTL 60s', () => {
  it('user sin KYC → blocked=false y NO bloquea', async () => {
    selectMock.mockReturnValueOnce(chain([])); // sin row
    const { isUserLaftBlocked, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    const r = await isUserLaftBlocked(1);
    expect(r.blocked).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('user con matchBlocked=true → devuelve reason', async () => {
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: true, matchBlockedReason: 'Coincidencia OFAC' }]));
    const { isUserLaftBlocked, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    const r = await isUserLaftBlocked(2);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('Coincidencia OFAC');
  });

  it('caché TTL: segunda llamada dentro de 60s NO consulta BD', async () => {
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: false, matchBlockedReason: null }]));
    const { isUserLaftBlocked, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    await isUserLaftBlocked(3);
    await isUserLaftBlocked(3);
    await isUserLaftBlocked(3);
    expect(selectMock).toHaveBeenCalledTimes(1); // sólo la primera
  });

  it('invalidate fuerza re-consulta', async () => {
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: false, matchBlockedReason: null }]));
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: true, matchBlockedReason: 'Match upgrade' }]));
    const { isUserLaftBlocked, invalidateLaftBlockCache, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    const r1 = await isUserLaftBlocked(4);
    expect(r1.blocked).toBe(false);
    invalidateLaftBlockCache(4);
    const r2 = await isUserLaftBlocked(4);
    expect(r2.blocked).toBe(true);
    expect(r2.reason).toBe('Match upgrade');
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('users distintos cachean por separado (cada uno una consulta inicial)', async () => {
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: false }]));
    selectMock.mockReturnValueOnce(chain([{ matchBlocked: true, matchBlockedReason: 'X' }]));
    const { isUserLaftBlocked, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    const a = await isUserLaftBlocked(10);
    const b = await isUserLaftBlocked(11);
    expect(a.blocked).toBe(false);
    expect(b.blocked).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(2);
    // Repetidos: cero extra
    await isUserLaftBlocked(10);
    await isUserLaftBlocked(11);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('BD lanza error → fail-open (devuelve blocked=false sin propagar)', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('BD down');
    });
    const { isUserLaftBlocked, clearLaftBlockCache } = await import('../../src/modules/laft/employees/auth-block.service.js');
    clearLaftBlockCache();
    const r = await isUserLaftBlocked(99);
    expect(r.blocked).toBe(false);
  });
});
