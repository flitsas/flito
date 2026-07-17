import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    update: updateMock,
    insert: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
}));

const deletePhotoMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  deletePhoto: deletePhotoMock,
}));

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  withLockMock.mockReset();
  deletePhotoMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: any) => fn());
  delete process.env.PRIVACY_RETENTION_CRON_ENABLED;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PRIVACY_RETENTION_CRON_ENABLED;
});

describe('privacy/retention.cron — runRetentionOnce', () => {
  it('lock NO obtenido → scanned=0, anonymized=0', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { runRetentionOnce } = await import('../../src/modules/privacy/retention.cron.js');
    const r = await runRetentionOnce();
    expect(r).toEqual({ scanned: 0, anonymized: 0, dryRun: false });
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('dryRun=true → solo cuenta candidatos, NO borra S3 ni anonimiza', async () => {
    selectMock.mockReturnValueOnce(chain([{ count: 17 }]));
    const { runRetentionOnce } = await import('../../src/modules/privacy/retention.cron.js');
    const r = await runRetentionOnce({ dryRun: true });
    expect(r).toEqual({ scanned: 17, anonymized: 0, dryRun: true });
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('candidatos con keys S3 → deletePhoto por cada foto S3 + anonimiza BD', async () => {
    // Snapshot de candidatos para borrar S3.
    selectMock.mockReturnValueOnce(chain([
      { id: 1, fotoRostro: 'validaciones/1/rostro_abc.jpg', fotoCedulaFrontal: 'validaciones/1/cedfrontal_def.jpg', fotoCedulaReverso: null },
      { id: 2, fotoRostro: 'validaciones/2/rostro_xyz.jpg', fotoCedulaFrontal: null, fotoCedulaReverso: null },
    ]));
    deletePhotoMock.mockResolvedValue(undefined);

    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => {
        captured = v;
        return {
          where: () => ({ returning: () => Promise.resolve([{ id: 1 }, { id: 2 }]) }),
        };
      },
    });

    const { runRetentionOnce } = await import('../../src/modules/privacy/retention.cron.js');
    const r = await runRetentionOnce();

    expect(r.dryRun).toBe(false);
    expect(r.anonymized).toBe(2);
    expect(r.scanned).toBe(2);
    // 3 keys S3 totales
    expect(deletePhotoMock).toHaveBeenCalledTimes(3);
    expect(deletePhotoMock).toHaveBeenCalledWith('validaciones/1/rostro_abc.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('validaciones/1/cedfrontal_def.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('validaciones/2/rostro_xyz.jpg');
    // Anonimiza todos los campos PII
    expect(captured).toEqual({
      fotoRostro: null,
      fotoCedulaFrontal: null,
      fotoCedulaReverso: null,
      ipAddress: null,
      lat: null,
      lng: null,
      userAgent: null,
    });
  });

  it('legacy keys (no empiezan con "validaciones/") → NO se intentan borrar de S3', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, fotoRostro: 'iv:tag:b64payload', fotoCedulaFrontal: null, fotoCedulaReverso: null },
    ]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    });

    const { runRetentionOnce } = await import('../../src/modules/privacy/retention.cron.js');
    await runRetentionOnce();
    expect(deletePhotoMock).not.toHaveBeenCalled();
  });

  it('deletePhoto throws → continúa con el resto (no aborta)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, fotoRostro: 'validaciones/1/rostro_a.jpg', fotoCedulaFrontal: 'validaciones/1/ced_b.jpg', fotoCedulaReverso: null },
    ]));
    deletePhotoMock.mockRejectedValueOnce(new Error('S3 unreachable'));
    deletePhotoMock.mockResolvedValueOnce(undefined);

    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    });

    const { runRetentionOnce } = await import('../../src/modules/privacy/retention.cron.js');
    const r = await runRetentionOnce();
    expect(deletePhotoMock).toHaveBeenCalledTimes(2);
    expect(r.anonymized).toBe(1); // Anonimización BD sigue
  });
});

describe('privacy/retention.cron — startRetentionCron (env gate)', () => {
  // OPS-08: el gate ahora lee `env.PRIVACY_RETENTION_CRON_ENABLED` (boolean parseado
  // por Zod en config/env.ts al importar). Como `env` se evalúa una sola vez por
  // import, forzamos `vi.resetModules()` tras mutar process.env para re-parsear.
  it('PRIVACY_RETENTION_CRON_ENABLED!=1 → cron NO se inicia (no setTimeout)', async () => {
    vi.useFakeTimers();
    delete process.env.PRIVACY_RETENTION_CRON_ENABLED;
    vi.resetModules();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { startRetentionCron, stopRetentionCron } = await import('../../src/modules/privacy/retention.cron.js');
    startRetentionCron();
    // Si NO se inicia, no debe haber registrado setTimeout para el job.
    expect(setTimeoutSpy.mock.calls.length).toBe(0);
    stopRetentionCron();
    setTimeoutSpy.mockRestore();
  });

  it('PRIVACY_RETENTION_CRON_ENABLED=1 → cron se inicia (setTimeout 5min + setInterval 24h)', async () => {
    vi.useFakeTimers();
    process.env.PRIVACY_RETENTION_CRON_ENABLED = '1';
    vi.resetModules();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { startRetentionCron, stopRetentionCron } = await import('../../src/modules/privacy/retention.cron.js');
    startRetentionCron();
    // Habilitado → registra el primer setTimeout (primera corrida a los 5 min).
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0);
    stopRetentionCron();
    setTimeoutSpy.mockRestore();
  });
});
