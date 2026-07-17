// FLOTA-01 — health del reconciler SOAT (lógica de estado + persistencia).
// Sin red: db mockeada (keyed por tabla, OPS-02b).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

beforeEach(() => kdb.reset());

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

function runRecord(finishedAt: string, over: Record<string, unknown> = {}) {
  return { v: { finishedAt, durationMs: 1234, processed: 5, stats: { ok: 2, pendientes: 3, errores: 0 }, ...over } };
}

describe('FLOTA-01 · getReconcilerHealth', () => {
  it('sin corrida persistida → unknown (lastRunAt null)', async () => {
    kdb.when.select('system_kv', []); // nunca corrió
    kdb.when.select('soat_requests', [{ n: 7 }]);
    const { getReconcilerHealth } = await import('../../src/modules/soat/reconciler-health.js');
    const h = await getReconcilerHealth();
    expect(h.status).toBe('unknown');
    expect(h.lastRunAt).toBeNull();
    expect(h.lastStats).toBeNull();
    expect(h.pendingCandidates).toBe(7);
    expect(h.staleThresholdHours).toBe(4);
  });

  it('corrida reciente → ok con stats', async () => {
    kdb.when.select('system_kv', [runRecord(isoAgo(30 * 60 * 1000))]); // hace 30 min
    kdb.when.select('soat_requests', [{ n: 3 }]);
    const { getReconcilerHealth } = await import('../../src/modules/soat/reconciler-health.js');
    const h = await getReconcilerHealth();
    expect(h.status).toBe('ok');
    expect(h.lastDurationMs).toBe(1234);
    expect(h.lastStats).toEqual({ ok: 2, pendientes: 3, errores: 0 });
    expect(h.pendingCandidates).toBe(3);
  });

  it('>4h sin corrida Y backlog pendiente → stale', async () => {
    kdb.when.select('system_kv', [runRecord(isoAgo(5 * HOUR))]);
    kdb.when.select('soat_requests', [{ n: 4 }]);
    const { getReconcilerHealth } = await import('../../src/modules/soat/reconciler-health.js');
    const h = await getReconcilerHealth();
    expect(h.status).toBe('stale');
    expect(h.pendingCandidates).toBe(4);
  });

  it('>4h sin corrida pero SIN pendientes → ok (no stale)', async () => {
    kdb.when.select('system_kv', [runRecord(isoAgo(5 * HOUR))]);
    kdb.when.select('soat_requests', [{ n: 0 }]);
    const { getReconcilerHealth } = await import('../../src/modules/soat/reconciler-health.js');
    const h = await getReconcilerHealth();
    expect(h.status).toBe('ok');
    expect(h.pendingCandidates).toBe(0);
  });
});

describe('FLOTA-01 · persistReconcilerRun', () => {
  it('hace upsert en system_kv y no lanza', async () => {
    const { persistReconcilerRun } = await import('../../src/modules/soat/reconciler-health.js');
    await expect(persistReconcilerRun({
      finishedAt: new Date().toISOString(),
      durationMs: 10,
      processed: 0,
      stats: { ok: 0, pendientes: 0, errores: 0 },
    })).resolves.toBeUndefined();
    expect(kdb.insert).toHaveBeenCalledTimes(1);
  });

  it('si la BD falla, no propaga (best-effort)', async () => {
    kdb.insert.mockImplementationOnce(() => { throw new Error('db down'); });
    const { persistReconcilerRun } = await import('../../src/modules/soat/reconciler-health.js');
    await expect(persistReconcilerRun({
      finishedAt: new Date().toISOString(), durationMs: 1, processed: 0,
      stats: { ok: 0, pendientes: 0, errores: 0 },
    })).resolves.toBeUndefined();
  });
});
