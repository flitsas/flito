// Cron SLA ROS: warn_12h, warn_4h, breach según tiempo restante hasta sla_due_at.
// Mocks: db (drizzle chains), withLock (passthrough), env recipients (variable per test).
//
// Cobertura:
// - clasificado hace ~21h (msLeft = 3h) → warn_12h + warn_4h ambas
// - clasificado hace ~13h (msLeft = 11h) → warn_12h, NO warn_4h
// - clasificado hace ~25h (msLeft = -1h) → breach
// - sin recipients → alarma se registra en BD pero email no se encola, log warn

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const insertMock = vi.fn();
const updateMock = vi.fn();
const selectMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
    delete: vi.fn(),
    transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const withLockMock = vi.fn();
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: withLockMock }));

const recipientsMock: { value: string[] } = { value: ['oficial@kyverum.test'] };
vi.mock('../../src/config/env.js', () => ({
  env: { NODE_ENV: 'development' },
  get laftComplianceRecipients() { return recipientsMock.value; },
  // El módulo importa también esto; lo dejamos noop.
  pesvAlertRecipients: [],
  corsOrigins: [],
}));

// Mock notificationOutbox y laftAuditLog: solo necesitamos capturar los inserts.
const insertedRows: Array<{ table: string; row: any }> = [];

beforeEach(() => {
  insertMock.mockReset();
  updateMock.mockReset();
  selectMock.mockReset();
  transactionMock.mockReset();
  withLockMock.mockReset();
  insertedRows.length = 0;
  recipientsMock.value = ['oficial@kyverum.test'];

  // Lock pasa-thru por defecto.
  withLockMock.mockImplementation(async (_n: string, _ttl: number, fn: any) => fn());

  // insert(table).values(row) → captura tabla+row, y returning() retorna [].
  insertMock.mockImplementation((table: any) => ({
    values: (row: any) => {
      // Detectar la tabla por nombre.
      const t = (table?._?.name || table?.name || 'unknown') as string;
      insertedRows.push({ table: t, row });
      // Si el caller hace insert().values() sin returning, drizzle es thenable.
      const result = chain([]);
      return result;
    },
  }));
});

function rosFixture(overrides: Partial<any>) {
  const now = new Date();
  return {
    id: 1,
    operationId: 100,
    clasificadoAt: new Date(now.getTime() - 21 * 3600 * 1000),
    slaDueAt: new Date(now.getTime() + 3 * 3600 * 1000), // 3h restantes
    slaBreached: false,
    ...overrides,
  };
}

describe('laft/ros-sla.cron', () => {
  it('21h transcurridas (3h restantes) → warn_12h + warn_4h', async () => {
    selectMock.mockReturnValueOnce(chain([rosFixture({})]));
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r).not.toBeNull();
    expect(r!.warn12).toBe(1);
    expect(r!.warn4).toBe(1);
    expect(r!.breach).toBe(0);
    // Debe haber 2 inserts en laft_ros_sla_alarmas + 2 en notificationOutbox + 2 audit.
    const tipos = insertedRows.filter((x) => x.row?.tipo).map((x) => x.row.tipo);
    expect(tipos).toContain('warn_4h');
    expect(tipos).toContain('warn_12h');
  });

  it('13h transcurridas (11h restantes) → solo warn_12h', async () => {
    const now = new Date();
    selectMock.mockReturnValueOnce(chain([rosFixture({
      clasificadoAt: new Date(now.getTime() - 13 * 3600 * 1000),
      slaDueAt: new Date(now.getTime() + 11 * 3600 * 1000),
    })]));
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r!.warn12).toBe(1);
    expect(r!.warn4).toBe(0);
    expect(r!.breach).toBe(0);
  });

  it('25h transcurridas (msLeft<0) → breach + UPDATE sla_breached', async () => {
    const now = new Date();
    const ros = rosFixture({
      clasificadoAt: new Date(now.getTime() - 25 * 3600 * 1000),
      slaDueAt: new Date(now.getTime() - 3600 * 1000),
    });
    selectMock.mockReturnValueOnce(chain([ros]));
    // El UPDATE atómico para marcar breached debe retornar 1 fila.
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    });
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r!.breach).toBe(1);
    expect(r!.warn4).toBe(0);
    expect(r!.warn12).toBe(0);
    expect(updateMock).toHaveBeenCalled();
  });

  it('sin recipients → alarma BD se registra, email NO encolado', async () => {
    recipientsMock.value = [];
    selectMock.mockReturnValueOnce(chain([rosFixture({})]));
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r!.warn12 + r!.warn4).toBeGreaterThan(0);
    expect(r!.withoutRecipients).toBe(1);
    // No debería haber inserts en notification_outbox (campo destinatarios al frente).
    const outboxRows = insertedRows.filter((x) => x.row?.canal === 'email');
    expect(outboxRows.length).toBe(0);
    // Pero sí debe haber alarmas registradas en alarmas.
    const alarmas = insertedRows.filter((x) => x.row?.tipo);
    expect(alarmas.length).toBeGreaterThan(0);
  });

  it('lock no obtenido → runOnce retorna null', async () => {
    withLockMock.mockResolvedValueOnce(null);
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r).toBeNull();
  });

  it('UNIQUE 23505 al insertar alarma → no aumenta el contador (idempotente)', async () => {
    selectMock.mockReturnValueOnce(chain([rosFixture({})]));
    insertMock.mockImplementation(() => ({
      values: () => ({
        then: (resolve: any, reject: any) => {
          const e: any = new Error('dup'); e.code = '23505';
          return Promise.reject(e).then(resolve, reject);
        },
        catch: (rej: any) => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })).catch(rej),
        finally: (cb: any) => Promise.resolve().finally(cb),
      }),
    }));
    const { _internal } = await import('../../src/modules/laft/sirel/ros-sla.cron.js');
    const r = await _internal.runOnce();
    expect(r!.warn12).toBe(0);
    expect(r!.warn4).toBe(0);
  });
});
