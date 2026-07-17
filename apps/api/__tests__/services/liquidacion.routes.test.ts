// TRAM-INNOV-B5-MVP — liquidacion.routes (admin).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const now = new Date();
beforeEach(() => { kdb.reset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/liquidacion/liquidacion.routes.js');
  app.use('/api/liquidaciones', router);
  return app;
}

describe('liquidaciones — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones').send({ woId: 9, items: [{ descripcion: 'x', cantidad: 1, valorUnitario: 10 }] });
    expect(r.status).toBe(401);
  });
  it('rol no admin → 403', async () => {
    const token = await testToken({ sub: 4, role: 'transito', transitoCodigo: '05001' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones').set('Authorization', `Bearer ${token}`).send({ woId: 9, items: [{ descripcion: 'x', cantidad: 1, valorUnitario: 10 }] });
    expect(r.status).toBe(403);
  });
});

describe('POST /liquidaciones', () => {
  it('sin woId ni tramiteId → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones').set('Authorization', `Bearer ${token}`).send({ items: [{ descripcion: 'x', cantidad: 1, valorUnitario: 10 }] });
    expect(r.status).toBe(400);
  });

  it('items vacíos → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones').set('Authorization', `Bearer ${token}`).send({ woId: 9, items: [] });
    expect(r.status).toBe(400);
  });

  it('happy → 201 con total', async () => {
    kdb.when
      .insert('liquidaciones', [{ id: 1 }])
      .insert('liquidacion_items', [])
      .select('liquidaciones', [{ id: 1, woId: 9, tramiteId: null, estado: 'borrador', total: '30.00', nota: null, createdAt: now, confirmadaAt: null }])
      .select('liquidacion_items', [{ id: 1, descripcion: 'x', cantidad: '3', valorUnitario: '10', subtotal: '30' }])
      .select('pagos', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones').set('Authorization', `Bearer ${token}`).send({ woId: 9, items: [{ descripcion: 'x', cantidad: 3, valorUnitario: 10 }] });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(30);
  });
});

describe('GET /liquidaciones', () => {
  it('sin filtro → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/liquidaciones').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });
  it('?woId= → 200 lista', async () => {
    kdb.when
      .select('liquidaciones', [{ id: 1, woId: 9, tramiteId: null, estado: 'borrador', total: '30.00', nota: null, createdAt: now, confirmadaAt: null }])
      .select('liquidacion_items', [])
      .select('pagos', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/liquidaciones?woId=9').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.liquidaciones)).toBe(true);
  });
});

describe('POST /liquidaciones/:id/confirmar-pago', () => {
  it('happy → 200 confirmada', async () => {
    kdb.when
      .select('liquidaciones', [{ id: 1, estado: 'confirmada', woId: 9, tramiteId: null, total: '30.00', nota: null, createdAt: now, confirmadaAt: now }])
      .select('liquidacion_items', [])
      .select('pagos', [{ id: 1, metodo: 'manual', estado: 'manual_confirmado', monto: '30', referencia: null, nota: null, createdAt: now }])
      .insert('pagos', [{ id: 1 }])
      .update('liquidaciones', [{ id: 1 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones/1/confirmar-pago').set('Authorization', `Bearer ${token}`).send({ monto: 30 });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('confirmada');
  });

  it('liquidación inexistente → 404', async () => {
    kdb.when.select('liquidaciones', []);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/liquidaciones/99/confirmar-pago').set('Authorization', `Bearer ${token}`).send({ monto: 30 });
    expect(r.status).toBe(404);
  });
});
