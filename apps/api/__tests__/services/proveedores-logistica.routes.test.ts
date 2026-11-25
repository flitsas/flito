// HU #14103 (Feature #14089) — Alta de proveedores de logística: contrato de la ruta con la base mockeada.
// AC1 alta válida, AC2 NIT duplicado 409, AC3 obligatorios 422, AC4 SOAT intacto, permisos 401/403.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.routes.js');
  app.use('/api/flito/parametrizacion/proveedores-logistica', router);
  return app;
}
const URL = '/api/flito/parametrizacion/proveedores-logistica';
const ID = 'b0000000-0000-4000-8000-000000014103';
const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: ['parametrizacion.proveedores.crear', 'parametrizacion.proveedores.listar', 'parametrizacion.proveedores.editar'] });
const sinFuncion = () => testToken({ sub: 2, role: 'auditor' });
const valido = { nombre: 'Mensajeria Andina', nit: '900.123.456-7', contacto: 'Ana Perez', telefono: '3001112233' };
const fila = { id: ID, nombre: 'Mensajeria Andina', nit: '900123456-7', contacto: 'Ana Perez', telefono: '3001112233', activo: true };

describe('POST /proveedores-logistica', () => {
  it('AC1: alta válida → 201, activo, NIT normalizado, auditoría sin contacto ni teléfono', async () => {
    selectMock.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([fila]));
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`).send(valido);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ nombre: 'Mensajeria Andina', nit: '900123456-7', activo: true });
    expect(auditMock).toHaveBeenCalledOnce();
    const detalle = JSON.stringify(auditMock.mock.calls[0]![1]);
    expect(detalle).not.toContain('3001112233');
    expect(detalle).not.toContain('Ana Perez');
  });

  it('AC2: NIT ya existente → 409 con mensaje claro', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: ID }]));
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`).send(valido);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('900123456-7');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('AC2: carrera (23505 del índice del NIT) → 409, nunca 500', async () => {
    selectMock.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]));
    insertMock.mockImplementationOnce(() => { throw Object.assign(new Error('dup'), { code: '23505', constraint_name: 'uq_flito_proveedores_logistica_nit' }); });
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`).send(valido);
    expect(r.status).toBe(409);
  });

  it.each([
    ['nombre', { nit: '900123456' }],
    ['nit', { nombre: 'X' }],
    ['nit', { nombre: 'X', nit: '   ' }],
  ])('AC3: falta %s → 422 indicando el campo', async (campo, body) => {
    const r = await request(await buildApp()).post(URL).set('Authorization', `Bearer ${await adminToken()}`).send(body);
    expect(r.status).toBe(422);
    expect(r.body.campo).toBe(campo);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('401 sin token y 403 sin la función de gestión de proveedores', async () => {
    const app = await buildApp();
    expect((await request(app).post(URL).send(valido)).status).toBe(401);
    expect((await request(app).post(URL).set('Authorization', `Bearer ${await sinFuncion()}`).send(valido)).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
    expect((await request(app).patch(`${URL}/${ID}`).set('Authorization', `Bearer ${await sinFuncion()}`).send({ nombre: 'Z' })).status).toBe(403);
    expect((await request(app).patch(`${URL}/${ID}/estado`).set('Authorization', `Bearer ${await sinFuncion()}`).send({ activo: false })).status).toBe(403);
  });
});

describe('GET /proveedores-logistica y PATCH', () => {
  it('AC1: el proveedor aparece en el listado, con sus campos de logística', async () => {
    selectMock.mockReturnValueOnce(chain([fila]));
    const r = await request(await buildApp()).get(URL).set('Authorization', `Bearer ${await adminToken()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([fila]);
  });

  it('PATCH con NIT de otro proveedor → 409; inexistente → 404', async () => {
    const app = await buildApp();
    selectMock.mockReturnValueOnce(chain([{ id: 'otro' }]));
    expect((await request(app).patch(`${URL}/${ID}`).set('Authorization', `Bearer ${await adminToken()}`).send({ nit: '900123456-7' })).status).toBe(409);
    selectMock.mockReturnValueOnce(chain([]));
    updateMock.mockReturnValueOnce(chain([]));
    expect((await request(app).patch(`${URL}/${ID}`).set('Authorization', `Bearer ${await adminToken()}`).send({ contacto: 'Luis' })).status).toBe(404);
  });
});

describe('AC4: proveedores SOAT intactos', () => {
  it('el DTO de logística no existe en el de SOAT y viceversa: el router SOAT sigue sin nit/contacto', async () => {
    const schema = readFileSync(resolve(__dirname, '../../src/db/schema.ts'), 'utf8');
    const bloque = schema.slice(schema.indexOf("pgTable('flito_proveedores_soat'"), schema.indexOf("pgTable('flito_proveedores_soat'") + 1500);
    expect(bloque).not.toMatch(/\bnit:|contacto:|telefono:/);
  });
});
