// HU #14119 — Contrato HTTP del catálogo de motivos de llegada a FLIT (AC1–AC4, AC6).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, insertMock, updateMock, auditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), auditMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica-motivos.routes.js');
  app.use('/api/flito/logistica/motivos-llegada', router);
  return app;
}
const URL = '/api/flito/logistica/motivos-llegada';
const ID = 'b0000000-0000-4000-8000-000000014119';
const FUNCION = 'logistica.motivos.gestionar';
const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: [FUNCION] });
const sinFuncion = () => testToken({ sub: 2, role: 'auditor' });
const fila = { id: ID, nombre: 'Destino lejano (transportadora externa)', activo: true, orden: 20 };

describe('POST /motivos-llegada', () => {
  it('AC1: POST válido → 201, auditoría con id/nombre y sin PII', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([fila]));
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ nombre: 'Destino lejano (transportadora externa)', orden: 20 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: ID, nombre: fila.nombre, activo: true, orden: 20 });
    expect(auditMock).toHaveBeenCalledOnce();
    const args = auditMock.mock.calls[0]![1] as { resourceId: string; detail: string };
    expect(args.resourceId).toBe(ID);
    expect(args.detail).toContain(fila.nombre);
    expect(JSON.stringify(args)).not.toMatch(/cedula|cédula|password|token/i);
  });

  it('AC2: mismo nombre distinta capitalización → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: ID }]));
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ nombre: 'DESTINO LEJANO (TRANSPORTADORA EXTERNA)' });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('DESTINO LEJANO (TRANSPORTADORA EXTERNA)');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('AC2: carrera (23505 del índice lower(nombre)) → 409, nunca 500', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: '23505', constraint_name: 'uq_flito_log_motivos_llegada_nombre' });
    });
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`)
      .send({ nombre: 'Otro' });
    expect(r.status).toBe(409);
    expect(r.status).not.toBe(500);
  });
});

describe('GET /motivos-llegada y PATCH estado', () => {
  it('AC3: desactivar → no aparece en ?soloActivos=true; el listado completo sí lo conserva', async () => {
    const inactivo = { ...fila, activo: false };
    updateMock.mockReturnValueOnce(chain([inactivo]));
    const app = await buildApp();
    const token = await adminToken();
    const patch = await request(app).patch(`${URL}/${ID}/estado`).set('Authorization', `Bearer ${token}`).send({ activo: false });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ id: ID, activo: false });

    selectMock.mockReturnValueOnce(chain([]));
    const solo = await request(app).get(`${URL}?soloActivos=true`).set('Authorization', `Bearer ${token}`);
    expect(solo.status).toBe(200);
    expect(solo.body.find((m: { id: string }) => m.id === ID)).toBeUndefined();

    selectMock.mockReturnValueOnce(chain([inactivo]));
    const todos = await request(app).get(URL).set('Authorization', `Bearer ${token}`);
    expect(todos.status).toBe(200);
    expect(todos.body.find((m: { id: string }) => m.id === ID)).toMatchObject({ id: ID, activo: false });
  });
});

describe('AC4: no existe DELETE', () => {
  it('router.stack sin DELETE; request.delete → 404', async () => {
    const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica-motivos.routes.js');
    const conDelete = router.stack.filter((l: { route?: { methods?: { delete?: boolean } } }) => l.route?.methods?.delete);
    expect(conDelete).toHaveLength(0);
    const r = await request(await buildApp()).delete(`${URL}/${ID}`).set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(404);
  });
});

describe('AC6: sin función → 403', () => {
  it('sin token 401; con token sin la función 403 en GET/POST/PATCH', async () => {
    const app = await buildApp();
    expect((await request(app).get(URL)).status).toBe(401);
    expect((await request(app).post(URL).send({ nombre: 'X' })).status).toBe(401);
    expect((await request(app).get(URL).set('Authorization', `Bearer ${await sinFuncion()}`)).status).toBe(403);
    expect((await request(app).post(URL).set('Authorization', `Bearer ${await sinFuncion()}`).send({ nombre: 'X' })).status).toBe(403);
    expect((await request(app).patch(`${URL}/${ID}`).set('Authorization', `Bearer ${await sinFuncion()}`).send({ nombre: 'Z' })).status).toBe(403);
    expect((await request(app).patch(`${URL}/${ID}/estado`).set('Authorization', `Bearer ${await sinFuncion()}`).send({ activo: false })).status).toBe(403);
  });
});
