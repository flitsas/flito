// Test del router POST /:id/export — genera PDF+CSV, sube a MinIO (mockeado),
// persiste storage_keys + sha256 en BD, idempotente en regeneración.
//
// OPS-02b r2: migrado a mock KEYED por tabla. El handler encadena 4 SELECT
// (ros_drafts → unusual_operations → counterparties → users); antes se encolaban
// en ese orden exacto. Ahora cada uno se enruta por su tabla → orden irrelevante.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { laftRosDraft, laftUnusualOp, laftCounterparty } from '../fixtures/laft/scenarios.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({ laftAudit: laftAuditMock }));

vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const putMock = vi.fn().mockResolvedValue(undefined);
const getStreamMock = vi.fn();
vi.mock('../../src/modules/laft/sirel/sirel-storage.js', () => ({
  putRosExportObject: putMock,
  getRosExportStream: getStreamMock,
  rosExportKey: (id: number, kind: 'pdf' | 'csv') => `ROS/${id}/borrador-sirel.${kind}`,
  ensureLaftBucket: vi.fn().mockResolvedValue(undefined),
  LAFT_BUCKET: 'operaciones-laft-reportes',
}));

beforeEach(() => {
  kdb.reset();
  putMock.mockReset();
  putMock.mockResolvedValue(undefined);
  getStreamMock.mockReset();
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/sirel/ros-export.routes.js');
  app.use('/api/laft/ros', router);
  return app;
}

// Captura el UPDATE ...returning() preservando el set() para inspección.
function captureUpdate(sink: { v: any }) {
  updateMock.mockReturnValueOnce({
    set: (v: any) => { sink.v = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 7, ...v }]) }) }; },
  } as any);
}

describe('POST /:id/export — genera PDF+CSV y persiste sha256 [keyed]', () => {
  it('falta Idempotency-Key → 400', async () => {
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/7/export').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('ROS no existe → 404', async () => {
    kdb.when.select('laft_ros_drafts', []);
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/99/export')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(404);
  });

  it('genera export OK → sube 2 blobs + UPDATE keys + sha256 + audit', async () => {
    kdb.when.scenario({
      laft_ros_drafts: laftRosDraft(),
      laft_unusual_operations: laftUnusualOp({ counterpartyId: 42 }),
      laft_counterparties: laftCounterparty(),
      users: [{ name: 'Tatiana', email: 't@x.com' }],
    });
    const captured: { v: any } = { v: null };
    captureUpdate(captured);
    const token = await testToken({ sub: 5, role: 'compliance', username: 'cump' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/7/export')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(200);
    expect(putMock).toHaveBeenCalledTimes(2);
    const calls = putMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('ROS/7/borrador-sirel.pdf');
    expect(calls).toContain('ROS/7/borrador-sirel.csv');
    expect(captured.v.exportPdfStorageKey).toBe('ROS/7/borrador-sirel.pdf');
    expect(captured.v.exportCsvStorageKey).toBe('ROS/7/borrador-sirel.csv');
    expect(captured.v.exportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ action: 'ros_export_generado' }),
    );
  });

  it('idempotente: segunda llamada retorna mismo SHA-256 (CSV determinístico)', async () => {
    // counterpartyId null → el handler NO consulta laft_counterparties.
    kdb.when.scenario({
      laft_ros_drafts: laftRosDraft(),
      laft_unusual_operations: laftUnusualOp({ counterpartyId: null }),
      users: [{ name: 'Tatiana' }],
    });
    const first: { v: any } = { v: null };
    captureUpdate(first);
    const token = await testToken({ sub: 5, role: 'compliance' });
    const app = await buildApp();
    await request(app).post('/api/laft/ros/7/export')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'abcd1234efgh');

    const second: { v: any } = { v: null };
    captureUpdate(second);
    await request(app).post('/api/laft/ros/7/export')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'abcd1234efgh');

    expect(first.v.exportSha256).toBe(second.v.exportSha256);
    expect(first.v.exportSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falla MinIO → 503 sin actualizar BD', async () => {
    kdb.when.scenario({
      laft_ros_drafts: laftRosDraft(),
      laft_unusual_operations: laftUnusualOp({ counterpartyId: null }),
      users: [{ name: 'Tatiana' }],
    });
    putMock.mockRejectedValueOnce(new Error('S3 down'));
    const token = await testToken({ sub: 5, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/ros/7/export')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'abcd1234efgh');
    expect(r.status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('GET /:id/export/pdf|csv [keyed]', () => {
  it('export no generado → 404', async () => {
    kdb.when.select('laft_ros_drafts', [{ key: null }]);
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros/7/export/pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('export generado → 200 con Content-Type pdf', async () => {
    kdb.when.select('laft_ros_drafts', [{ key: 'ROS/7/borrador-sirel.pdf' }]);
    const { Readable } = await import('stream');
    getStreamMock.mockResolvedValueOnce(Readable.from([Buffer.from('%PDF-1.7\n')]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/ros/7/export/pdf').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
  });
});
