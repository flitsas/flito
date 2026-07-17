import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: executeMock,
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
  executeMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/drivers/trainings.routes.js');
  app.use('/api/trainings', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

describe('trainings — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/trainings');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/trainings').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('lista trainings con counts', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: 1, titulo: 'X', asistentes_count: 5, asistio_count: 3 }] });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });
});

describe('GET /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con attendees', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, titulo: 'X' }]));
    selectMock.mockReturnValueOnce(chain([{ userId: 5, name: 'Juan', asistio: true }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.attendees).toHaveLength(1);
  });
});

describe('POST /', () => {
  const VALID = { titulo: 'Manejo defensivo', horas: 4, fecha: '2026-05-06' };

  it('horas <= 0 → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/trainings').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, horas: 0 });
    expect(r.status).toBe(400);
  });

  it('modalidad fuera enum → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/trainings').set('Authorization', `Bearer ${token}`)
      .send({ ...VALID, modalidad: 'inventada' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + horas como string', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 100, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/trainings').set('Authorization', `Bearer ${token}`).send(VALID);
    expect(r.status).toBe(201);
    expect(captured.horas).toBe('4');
    expect(captured.creadaPor).toBe(7);
  });
});

describe('PATCH /:id', () => {
  it('no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/trainings/999').set('Authorization', `Bearer ${token}`)
      .send({ titulo: 'Nuevo' });
    expect(r.status).toBe(404);
  });

  it('actualizar horas → string', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/trainings/1').set('Authorization', `Bearer ${token}`)
      .send({ horas: 6 });
    expect(captured.horas).toBe('6');
  });
});

describe('POST /:id/attendees', () => {
  it('userIds vacío → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/trainings/1/attendees').set('Authorization', `Bearer ${token}`)
      .send({ userIds: [] });
    expect(r.status).toBe(400);
  });

  it('filtra solo conductores activos válidos', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 5 }, { id: 6 }])); // 2 válidos de 3 enviados
    insertMock.mockReturnValue({
      values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/trainings/1/attendees').set('Authorization', `Bearer ${token}`)
      .send({ userIds: [5, 6, 7] });
    expect(r.status).toBe(201);
    expect(r.body.registered).toBe(2);
  });
});

describe('PATCH /:id/attendees/:userId', () => {
  it('asistente no registrado → 404', async () => {
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/trainings/1/attendees/5').set('Authorization', `Bearer ${token}`)
      .send({ asistio: true });
    expect(r.status).toBe(404);
  });

  it('actualizar asistencia + calificación → 200', async () => {
    let captured: any = null;
    updateMock.mockReturnValueOnce({
      set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ userId: 5, asistio: true }]) }) }; },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/trainings/1/attendees/5').set('Authorization', `Bearer ${token}`)
      .send({ asistio: true, calificacion: 4.5 });
    expect(r.status).toBe(200);
    expect(captured.calificacion).toBe('4.5');
  });

  it('calificación > 5 → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/trainings/1/attendees/5').set('Authorization', `Bearer ${token}`)
      .send({ calificacion: 6 });
    expect(r.status).toBe(400);
  });
});

describe('GET /report/horas-conductor', () => {
  it('año inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings/report/horas-conductor?year=1999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('reporte → 200 con horas por conductor', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ user_id: 5, name: 'Juan', horas: '12.5' }] });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/trainings/report/horas-conductor?year=2026').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.year).toBe(2026);
    expect(r.body.data[0].horas).toBe(12.5);
  });
});
