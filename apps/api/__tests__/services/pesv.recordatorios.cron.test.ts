import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: withLockMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); deleteMock.mockReset();
  executeMock.mockReset(); transactionMock.mockReset(); withLockMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<any>) => fn());
});

describe('PESV recordatorios cron · helpers de fecha', () => {
  it('semanaLunes devuelve lunes 00:00 UTC de la semana ISO', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    // 2026-05-07 es jueves → lunes ISO sería 2026-05-04
    const lunes = _internal.semanaLunes(new Date('2026-05-07T15:00:00Z'));
    expect(lunes.getUTCFullYear()).toBe(2026);
    expect(lunes.getUTCMonth()).toBe(4); // mayo (0-indexed)
    expect(lunes.getUTCDate()).toBe(4);
    expect(lunes.getUTCHours()).toBe(0);
  });

  it('trimestreDe genera YYYY-QN correctamente', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    expect(_internal.trimestreDe(new Date('2026-01-15T00:00:00Z'))).toBe('2026-Q1');
    expect(_internal.trimestreDe(new Date('2026-04-15T00:00:00Z'))).toBe('2026-Q2');
    expect(_internal.trimestreDe(new Date('2026-07-15T00:00:00Z'))).toBe('2026-Q3');
    expect(_internal.trimestreDe(new Date('2026-10-15T00:00:00Z'))).toBe('2026-Q4');
    expect(_internal.trimestreDe(new Date('2026-12-31T23:00:00Z'))).toBe('2026-Q4');
  });

  it('periodoMes mes 1-indexed', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    expect(_internal.periodoMes(new Date('2026-05-07T00:00:00Z'))).toEqual({ anio: 2026, mes: 5 });
    expect(_internal.periodoMes(new Date('2026-12-31T00:00:00Z'))).toEqual({ anio: 2026, mes: 12 });
    expect(_internal.periodoMes(new Date('2027-01-01T00:00:00Z'))).toEqual({ anio: 2027, mes: 1 });
  });
});

describe('PESV recordatorios · scan 60h semanal', () => {
  it('NO ejecuta si no es lunes 06:00 UTC', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    await _internal.tryScan60hSemanal(new Date('2026-05-07T06:00:00Z')); // jueves
    expect(withLockMock).not.toHaveBeenCalled();
  });

  it('ejecuta lunes 06:00 UTC con violadores → encola email', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    executeMock.mockResolvedValueOnce({ rows: [{ conductor_id: 5, horas: 65.5 }, { conductor_id: 9, horas: 72 }] });
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }])); // getAdminEmails
    insertMock.mockReturnValueOnce(chain([{ id: 1 }])); // outbox

    // 2026-05-04 es lunes
    await _internal.tryScan60hSemanal(new Date('2026-05-04T06:00:00Z'));
    expect(withLockMock).toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalled();
  });

  it('ejecuta lunes 06:00 sin violadores → no encola email', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    executeMock.mockResolvedValueOnce({ rows: [] });
    await _internal.tryScan60hSemanal(new Date('2026-05-04T06:00:00Z'));
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('PESV recordatorios · diagnóstico anual (1-nov)', () => {
  it('NO ejecuta si no es 1-nov 09:00 UTC', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    await _internal.tryRecordatorioDiagnostico(new Date('2026-10-01T09:00:00Z'));
    expect(withLockMock).not.toHaveBeenCalled();
  });

  it('1-nov sin diagnóstico del año → encola email', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    selectMock
      .mockReturnValueOnce(chain([])) // pesv_diagnosticos del año actual: vacío
      .mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }])); // getAdminEmails
    insertMock.mockReturnValueOnce(chain([{ id: 1 }]));

    await _internal.tryRecordatorioDiagnostico(new Date('2026-11-01T09:00:00Z'));
    expect(insertMock).toHaveBeenCalled();
  });

  it('1-nov CON diagnóstico → no encola email (idempotente)', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    selectMock.mockReturnValueOnce(chain([{ id: 1, anio: 2026 }]));

    await _internal.tryRecordatorioDiagnostico(new Date('2026-11-01T09:00:00Z'));
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('PESV recordatorios · análisis riesgo trimestral (1° Q)', () => {
  it('1-abr 09:00 con rutas sin análisis del trimestre → encola email', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    selectMock.mockReturnValueOnce(chain([
      { id: 1, codigo: 'R-001', nombre: 'Bogotá-Cali', criticidad: 'alta', activo: true },
      { id: 2, codigo: 'R-002', nombre: 'Bogotá-Medellín', criticidad: 'media', activo: true },
    ]));
    executeMock.mockResolvedValueOnce({ rows: [{ route_id: 1 }] }); // solo R-001 tiene análisis Q2
    selectMock.mockReturnValueOnce(chain([{ email: 'admin@kyverum.com' }]));
    insertMock.mockReturnValueOnce(chain([{ id: 1 }]));

    await _internal.tryAnalisisRiesgoTrimestral(new Date('2026-04-01T09:00:00Z'));
    expect(insertMock).toHaveBeenCalled();
  });

  it('NO ejecuta si no es 1° de Q a las 09:00', async () => {
    const { _internal } = await import('../../src/modules/pesv/recordatorios.cron.js');
    await _internal.tryAnalisisRiesgoTrimestral(new Date('2026-05-01T09:00:00Z'));
    expect(withLockMock).not.toHaveBeenCalled();
  });
});
