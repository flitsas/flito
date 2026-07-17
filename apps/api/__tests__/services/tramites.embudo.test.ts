// TRAM-OPS-01 — GET /api/tramites/embudo
// OPS-02b r4: mock KEYED por tabla.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { execute: executeMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { kdb.reset(); executeMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('GET /api/tramites/embudo', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/embudo');
    expect(r.status).toBe(401);
  });

  it('agrupa trámites en 5 columnas', async () => {
    const now = new Date();
    kdb.when.selectOnce('tramites_digitales', [
      { estado: 'borrador', n: 1 },
      { estado: 'enviado_transito', n: 1 },
      { estado: 'rechazado', n: 1 },
    ]);
    kdb.when.selectOnce('tramites_digitales', [
      { id: 1, vin: 'VIN1', placa: 'ABC', tipologiaCodigo: 'traspaso_standard', estado: 'borrador', paso: 1, updatedAt: now, motivoRechazoCodigo: null, vehiculo: { marca: 'Toyota' }, comprador: { nombre: 'Ana Pérez', documento: '1020304050' } },
      { id: 2, vin: 'VIN2', placa: null, tipologiaCodigo: null, estado: 'enviado_transito', paso: 5, updatedAt: now, motivoRechazoCodigo: null, vehiculo: null, comprador: null },
      { id: 3, vin: 'VIN3', placa: 'XYZ', tipologiaCodigo: null, estado: 'rechazado', paso: 3, updatedAt: now, motivoRechazoCodigo: 'comparendo', vehiculo: null, comprador: null },
    ]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/embudo').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const { EMBUDO_COLUMNAS } = await import('../../src/modules/tramites/embudo.js');
    expect(r.body.columnas).toHaveLength(EMBUDO_COLUMNAS.length);
    const borrador = r.body.columnas.find((c: { id: string }) => c.id === 'borrador');
    const transito = r.body.columnas.find((c: { id: string }) => c.id === 'en_transito');
    const rechazado = r.body.columnas.find((c: { id: string }) => c.id === 'rechazado');
    expect(borrador.count).toBe(1);
    expect(borrador.tramites[0].vin).toBe('VIN1');
    // #140: la tarjeta del embudo expone el comprador (nombre + documento).
    expect(borrador.tramites[0].comprador).toEqual({ nombre: 'Ana Pérez', documento: '1020304050' });
    expect(transito.count).toBe(1);
    // Sin comprador en BD → la tarjeta lo expone como null.
    expect(transito.tramites[0].comprador).toBeNull();
    expect(rechazado.tramites[0].motivoRechazoCodigo).toBe('comparendo');
  });
});
