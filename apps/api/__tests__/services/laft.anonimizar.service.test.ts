// LAFT F5 · anonimizar.service — anonimiza + audit + idempotente.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: updateMock,
    transaction: transactionMock, execute: vi.fn(), delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
});

describe('LAFT F5 · anonimizarLaftCounterparties', () => {
  it('simulación cuenta sin tocar datos', async () => {
    selectMock.mockReturnValueOnce(chain([{ n: 12 }]));
    const { anonimizarLaftCounterparties } = await import('../../src/modules/laft/retencion/anonimizar.service.js');
    const cutoff = new Date('2016-01-01T00:00:00Z');
    const r = await anonimizarLaftCounterparties(cutoff, { simulacion: true });
    expect(r.modoSimulacion).toBe(true);
    expect(r.cantidadAfectada).toBe(12);
    expect(r.tipoDocumento).toBe('laft_counterparty');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('modo real: UPDATE + log + idempotente', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]) }) }),
        }),
        select: vi.fn().mockReturnValue({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 99 }]) }) }),
        }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      };
      return cb(tx);
    });
    const { anonimizarLaftCounterparties } = await import('../../src/modules/laft/retencion/anonimizar.service.js');
    const cutoff = new Date('2016-01-01T00:00:00Z');
    const r = await anonimizarLaftCounterparties(cutoff, { simulacion: false, userId: 5 });
    expect(r.modoSimulacion).toBe(false);
    expect(r.cantidadAfectada).toBe(3);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('idempotente: re-ejecutar sin filas nuevas → cantidad=0', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
        }),
        select: vi.fn().mockReturnValue({
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 99 }]) }) }),
        }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      };
      return cb(tx);
    });
    const { anonimizarLaftCounterparties } = await import('../../src/modules/laft/retencion/anonimizar.service.js');
    const r = await anonimizarLaftCounterparties(new Date('2016-01-01'), { simulacion: false });
    expect(r.cantidadAfectada).toBe(0);
  });
});

describe('LAFT F5 · /laft/retencion/anonimizar/:tipo', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('admin dry-run laft_counterparty → 200 ok', async () => {
    const executeMock = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    selectMock.mockReturnValueOnce(chain([{
      id: 1, tipoDocumento: 'laft_counterparty', retencionAnios: 10, accion: 'anonimizar', habilitado: true,
    }]));
    selectMock.mockReturnValueOnce(chain([{ n: 5 }])); // count simulación

    vi.doMock('../../src/db/client.js', () => ({
      db: {
        select: selectMock, insert: insertMock, update: updateMock,
        transaction: transactionMock, execute: executeMock, delete: vi.fn(),
      },
      getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
    }));
    vi.doMock('../../src/modules/laft/audit.service.js', () => ({
      laftAudit: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

    const { createApp } = await import('../../src/app.js');
    const request = (await import('supertest')).default;
    const { adminAuth } = await import('../helpers/auth.js');
    const app = createApp();
    const r = await request(app).post('/api/laft/retencion/anonimizar/laft_counterparty')
      .set('Authorization', await adminAuth())
      .send({ confirm: false, razon: 'auditoría anual de retención documental' });
    expect(r.status).toBe(200);
    expect(r.body.modoSimulacion).toBe(true);
    expect(r.body.cantidadAfectada).toBe(5);
  });

  it('tipo no soportado → 400', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      db: {
        select: selectMock, insert: insertMock, update: updateMock,
        transaction: transactionMock, execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]), delete: vi.fn(),
      },
      getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
    }));
    vi.doMock('../../src/modules/laft/audit.service.js', () => ({
      laftAudit: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
    const { createApp } = await import('../../src/app.js');
    const request = (await import('supertest')).default;
    const { adminAuth } = await import('../helpers/auth.js');
    const app = createApp();
    const r = await request(app).post('/api/laft/retencion/anonimizar/foo')
      .set('Authorization', await adminAuth())
      .send({ razon: 'auditoría 2026' });
    expect(r.status).toBe(400);
  });
});
