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
  const { default: router } = await import('../../src/modules/drivers/emergency.routes.js');
  app.use('/api/emergency', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('emergency — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/emergency/contacts');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/emergency/contacts').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /contacts', () => {
  it('lista activos con filtros → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, tipo: 'arl', nombre: 'SURA' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/emergency/contacts?zona=Medellin&tipo=arl')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe('POST /contacts', () => {
  const VALID = { tipo: 'arl', zona: 'Medellin', nombre: 'SURA', telefono: '6045555555' };

  it('tipo fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/contacts').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, tipo: 'inventado' });
    expect(r.status).toBe(400);
  });

  it('telefono < 3 → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/contacts').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, telefono: '12' });
    expect(r.status).toBe(400);
  });

  it('email inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/contacts').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, email: 'no-arroba' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + audit', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, nombre: 'SURA' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/contacts').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(auditMock).toHaveBeenCalled();
  });
});

describe('PATCH /contacts/:id + DELETE /contacts/:id', () => {
  it('PATCH no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/emergency/contacts/999').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('PATCH éxito → 200', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, nombre: 'X' }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/emergency/contacts/1').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'X' });
    expect(r.status).toBe(200);
  });

  it('DELETE soft delete → 200 + audit', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).delete('/api/emergency/contacts/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(auditMock.mock.calls[0][1].action).toBe('delete');
  });
});

describe('GET /protocols + POST /protocols', () => {
  it('GET → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, titulo: 'Accidente leve' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/emergency/protocols').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('POST categoria fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/protocols').set('Authorization', `Bearer ${token}`)
      .send({ titulo: 'X', categoria: 'inventada', descripcionMd: 'desc' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, titulo: 'X' }]) }),
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/protocols').set('Authorization', `Bearer ${token}`)
      .send({ titulo: 'Accidente', categoria: 'accidente', descripcionMd: '# Markdown' });
    expect(r.status).toBe(201);
  });
});

describe('GET /drills + POST /drills', () => {
  it('GET → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, fecha: '2026-04-01' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/emergency/drills').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('POST fecha mal formato → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/drills').set('Authorization', `Bearer ${token}`)
      .send({ fecha: '01/04/2026', escenario: 'X' });
    expect(r.status).toBe(400);
  });

  it('POST éxito → 201', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, escenario: 'Choque frontal' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/emergency/drills').set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-05-06', escenario: 'Choque frontal' });
    expect(r.status).toBe(201);
  });
});
