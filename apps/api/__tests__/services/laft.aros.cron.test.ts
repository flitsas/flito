// LAFT F3 · aros.cron — verifica scheduler en día 10 de Ene/Abr/Jul/Oct.
// OPS-02b r2: mock KEYED por tabla.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
const { insert: insertMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: withLockMock,
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

const generarArosMock = vi.fn();
vi.mock('../../src/modules/laft/cash/aros.service.js', () => ({
  generarAros: generarArosMock,
  buildArosResumen: vi.fn(),
  buildArosPdf: vi.fn(),
  trimestreRange: vi.fn(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  kdb.reset();
  withLockMock.mockReset();
  generarArosMock.mockReset();
});

describe('LAFT F3 · aros.cron — calcularTrimestrePrevio', () => {
  it('10-Ene → Q4 año anterior', async () => {
    const { calcularTrimestrePrevio } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = calcularTrimestrePrevio(new Date('2026-01-10T09:00:00Z'));
    expect(r).toEqual({ anio: 2025, trimestre: 4 });
  });
  it('10-Abr → Q1 mismo año', async () => {
    const { calcularTrimestrePrevio } = await import('../../src/modules/laft/cash/aros.cron.js');
    expect(calcularTrimestrePrevio(new Date('2026-04-10T09:00:00Z'))).toEqual({ anio: 2026, trimestre: 1 });
  });
  it('10-Jul → Q2', async () => {
    const { calcularTrimestrePrevio } = await import('../../src/modules/laft/cash/aros.cron.js');
    expect(calcularTrimestrePrevio(new Date('2026-07-10T09:00:00Z'))).toEqual({ anio: 2026, trimestre: 2 });
  });
  it('10-Oct → Q3', async () => {
    const { calcularTrimestrePrevio } = await import('../../src/modules/laft/cash/aros.cron.js');
    expect(calcularTrimestrePrevio(new Date('2026-10-10T09:00:00Z'))).toEqual({ anio: 2026, trimestre: 3 });
  });
  it('cualquier otro mes → null', async () => {
    const { calcularTrimestrePrevio } = await import('../../src/modules/laft/cash/aros.cron.js');
    expect(calcularTrimestrePrevio(new Date('2026-02-15T09:00:00Z'))).toBeNull();
    expect(calcularTrimestrePrevio(new Date('2026-05-01T09:00:00Z'))).toBeNull();
  });
});

describe('LAFT F3 · aros.cron — runOnce [keyed]', () => {
  // Helper para emular withLock(name, ttl, cb) → simplemente await cb().
  function lockPassthrough() {
    withLockMock.mockImplementationOnce(async (_name: string, _ttl: number, cb: any) => cb());
  }

  it('mes != Ene/Abr/Jul/Oct → no corre', async () => {
    lockPassthrough();
    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-05-10T09:00:00Z'));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/no es Ene/i);
  });

  it('día != día corte → no corre', async () => {
    lockPassthrough();
    kdb.when.selectOnce('laft_parametros', [{ valor: '10' }]); // dia corte
    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-04-15T09:00:00Z'));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/día/i);
  });

  it('AROS ya existe → no corre', async () => {
    lockPassthrough();
    kdb.when.selectOnce('laft_parametros', [{ valor: '10' }]); // dia corte
    kdb.when.selectOnce('laft_reportes_uiaf', [{ id: 99 }]); // existing AROS Q1-2026
    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-04-10T09:00:00Z'));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/ya existe/i);
  });

  it('día corte + no existe + admin disponible → genera AROS Q1', async () => {
    lockPassthrough();
    kdb.when.selectOnce('laft_parametros', [{ valor: '10' }]); // dia corte
    kdb.when.selectOnce('laft_reportes_uiaf', []); // no existing
    kdb.when.selectOnce('users', [{ id: 7 }]); // admin user
    kdb.when.selectOnce('users', [{ email: 'admin@example.com' }]); // emails
    generarArosMock.mockResolvedValueOnce({
      reporte: { id: 50, sha256: 'sha-AROS' },
      resumen: { esAusencia: true, totalRosEnviados: 0, totalUnusualReportadas: 0, totalCashBreaches: 0 },
      idempotent: false,
    });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve(undefined) });

    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-04-10T09:00:00Z'));
    expect(r.ran).toBe(true);
    expect(r.generated).toMatchObject({ anio: 2026, trimestre: 1, idempotent: false });
    expect(generarArosMock).toHaveBeenCalledWith(2026, 1, 7);
    // Outbox encolado
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('sin admin disponible → no corre', async () => {
    lockPassthrough();
    kdb.when.selectOnce('laft_parametros', [{ valor: '10' }]); // dia corte
    kdb.when.selectOnce('laft_reportes_uiaf', []); // no existing
    kdb.when.selectOnce('users', []); // no admin

    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-04-10T09:00:00Z'));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/admin/i);
    expect(generarArosMock).not.toHaveBeenCalled();
  });

  it('lock no adquirido (otra instancia) → ran=false', async () => {
    // withLock devuelve undefined cuando no se adquiere el lock.
    withLockMock.mockResolvedValueOnce(undefined);
    const { runOnce } = await import('../../src/modules/laft/cash/aros.cron.js');
    const r = await runOnce(new Date('2026-04-10T09:00:00Z'));
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/lock/i);
  });
});
