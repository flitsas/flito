import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    transaction: transactionMock,
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const laftAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/laft/audit.service.js', () => ({
  laftAudit: laftAuditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  transactionMock.mockReset();
  laftAuditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/laft/trainings.routes.js');
  app.use('/api/laft/trainings', router);
  return app;
}

describe('laft/trainings — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings');
    expect(r.status).toBe(401);
  });

  it('proveedor → 403', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('compliance → 200', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('GET / — listado capacitaciones', () => {
  it('devuelve lista con counts (subqueries)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, title: 'AML 101', attendeesCount: 20, attendedCount: 18 },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0].attendeesCount).toBe(20);
    expect(r.body[0].attendedCount).toBe(18);
  });
});

describe('GET /:id — detalle con asistentes', () => {
  it('id no numérico → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings/abc').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('encontrado → 200 con asistentes (innerJoin users)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, title: 'AML 101' }]));
    selectMock.mockReturnValueOnce(chain([
      { id: 10, userId: 7, userName: 'Juan', userUsername: 'juan', userRole: 'admin', attended: true, score: 95, attendedAt: new Date() },
    ]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/laft/trainings/1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
    expect(r.body.attendees).toHaveLength(1);
    expect(r.body.attendees[0].userName).toBe('Juan');
  });
});

describe('POST / — crear capacitación', () => {
  it('title < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings').set('Authorization', `Bearer ${token}`)
      .send({ title: 'AB', scheduledAt: '2026-06-01' });
    expect(r.status).toBe(400);
  });

  it('contentUrl inválido (no URL) → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings').set('Authorization', `Bearer ${token}`)
      .send({ title: 'AML 101', scheduledAt: '2026-06-01', contentUrl: 'no-url' });
    expect(r.status).toBe(400);
  });

  it('passingScore default 70 si no se envía', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 1, ...v }]) }; },
    });
    const token = await testToken({ sub: 7, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings').set('Authorization', `Bearer ${token}`)
      .send({ title: 'AML 101', scheduledAt: '2026-06-01' });
    expect(r.status).toBe(201);
    expect(captured.passingScore).toBe(70);
    expect(captured.createdBy).toBe(7);
    expect(captured.scheduledAt).toBeInstanceOf(Date);
  });

  it('contentUrl="" → null (transform de zod)', async () => {
    let captured: any = null;
    insertMock.mockReturnValueOnce({
      values: (v: any) => { captured = v; return { returning: () => Promise.resolve([{ id: 1, ...v }]) }; },
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/laft/trainings').set('Authorization', `Bearer ${token}`)
      .send({ title: 'AML 101', scheduledAt: '2026-06-01', contentUrl: '', evaluationUrl: '' });
    expect(captured.contentUrl).toBeNull();
    expect(captured.evaluationUrl).toBeNull();
  });

  it('éxito → 201 + laftAudit con resource=document', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 5, title: 'AML' }]) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings').set('Authorization', `Bearer ${token}`)
      .send({ title: 'AML 101', scheduledAt: '2026-06-01', durationHours: 2.5 });
    expect(r.status).toBe(201);
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create_training', resource: 'document', resourceId: 5 }),
    );
  });
});

describe('POST /:id/attendance — registrar asistencia (idempotente upsert)', () => {
  it('id inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings/abc/attendance')
      .set('Authorization', `Bearer ${token}`)
      .send({ attendees: [{ userId: 1, attended: true }] });
    expect(r.status).toBe(400);
  });

  it('attendees vacío → 400 (zod min 1)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings/1/attendance')
      .set('Authorization', `Bearer ${token}`)
      .send({ attendees: [] });
    expect(r.status).toBe(400);
  });

  it('attendees > 500 → 400 (zod max 500)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const huge = Array.from({ length: 501 }, (_, i) => ({ userId: i + 1, attended: true }));
    const r = await request(app).post('/api/laft/trainings/1/attendance')
      .set('Authorization', `Bearer ${token}`)
      .send({ attendees: huge });
    expect(r.status).toBe(400);
  });

  it('training no existe → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings/999/attendance')
      .set('Authorization', `Bearer ${token}`)
      .send({ attendees: [{ userId: 1, attended: true }] });
    expect(r.status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('éxito: transaction borra previos + reinserta + audit', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    let deleteCalled = false;
    let insertedValues: any = null;
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        delete: vi.fn(() => ({
          where: () => { deleteCalled = true; return Promise.resolve(undefined); },
        })),
        insert: vi.fn(() => ({
          values: (v: any) => { insertedValues = v; return Promise.resolve(undefined); },
        })),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/laft/trainings/1/attendance')
      .set('Authorization', `Bearer ${token}`)
      .send({ attendees: [
        { userId: 7, attended: true, score: 95 },
        { userId: 8, attended: false },
      ] });

    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(deleteCalled).toBe(true);
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0].trainingId).toBe(1);
    expect(insertedValues[0].score).toBe(95);
    expect(insertedValues[0].attendedAt).toBeInstanceOf(Date); // attended=true → fecha
    expect(insertedValues[1].score).toBeNull(); // sin score
    expect(insertedValues[1].attendedAt).toBeNull(); // attended=false → null
    expect(laftAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'update_training_attendance' }),
    );
  });
});
