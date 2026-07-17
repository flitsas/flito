import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('clients — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/clients');
    expect(r.status).toBe(401);
  });

  it('proveedor → POST 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('admin → 200 con array', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Cliente A' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/clients').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it('limit y offset query params', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/clients?limit=50&offset=10').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /', () => {
  it('name vacío → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: '' });
    expect(r.status).toBe(400);
  });

  it('email inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', email: 'no-arroba' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + audit', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, name: 'Acme SAS' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme SAS', email: 'admin@acme.com' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(100);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create', resource: 'client' }),
    );
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/abc').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/999').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nuevo' });
    expect(r.status).toBe(404);
  });

  it('actualizar nombre → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, name: 'Nuevo' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nuevo' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Nuevo');
  });

  it('email inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ email: 'mal-formato' });
    expect(r.status).toBe(400);
  });
});
