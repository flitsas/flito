// HU #13957 (Feature #13940, Épica #13671) — el nombre de un proveedor SOAT solo lo ocupa un proveedor VIGENTE.
//
// Ruta con la BD mockeada: la validación previa (409 sin escribir, AC1/AC2), que la consulta solo cuente vigentes
// (`deleted_at IS NULL`, AC3) y excluya al propio proveedor en la edición, y que el 23505 del índice parcial en una
// carrera se traduzca al mismo 409 (AC4). El índice y la 0259 contra PostgreSQL viven en `db/migracion-0259.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';
import { esDuplicadoNombreProveedorSoat } from '../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js';

const { selectMock, insertMock, updateMock, auditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), auditMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const dialecto = new PgDialect();
let wheres: { sql: string; params: unknown[] }[] = [];

/** SELECT `from().where().limit()` / `from().where().orderBy()` que registra el WHERE y devuelve `filas`. */
function select(filas: unknown[]) {
  return {
    from: () => ({
      where: (w: SQL) => {
        wheres.push(dialecto.sqlToQuery(w));
        return { limit: () => Promise.resolve(filas), orderBy: () => Promise.resolve(filas) };
      },
    }),
  };
}

const errorUnico = () => Object.assign(new Error('duplicate key value violates unique constraint'), {
  code: '23505', constraint_name: 'uq_flito_proveedores_soat_nombre_vivo',
});
const fila = (extra: Record<string, unknown> = {}) => ({
  id: 'b0000000-0000-4000-8000-000000000002', nombre: 'Seguros Andinos', estrategia: 'portal', umbralOcr: null,
  slaHoras: null, activo: true, createdAt: new Date(), deletedAt: null, deletedBy: null, ...extra,
});
const ID_B = 'b0000000-0000-4000-8000-000000000002';
const MENSAJE = 'Ya existe un proveedor SOAT con el nombre Seguros Andinos.';
const URL = '/api/flito/parametrizacion/proveedores-soat';

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  wheres = [];
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 1, username: 'u', role: 'admin' })}`;

describe('POST /proveedores-soat — nombre único entre vigentes (HU #13957)', () => {
  it('AC1: nombre de un proveedor vigente → 409 con el mensaje de la HU, sin insertar', async () => {
    selectMock.mockReturnValueOnce(select([{ id: 'a' }]));
    const r = await request(await buildApp()).post(URL).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE });
    expect(insertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC3: la consulta solo cuenta vigentes (deleted_at IS NULL); si solo existe eliminado → 201', async () => {
    selectMock.mockReturnValueOnce(select([]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([fila({ id: 'c' })]) }) });
    const r = await request(await buildApp()).post(URL).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(201);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."nombre" = \$1/);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."deleted_at" is null/);
    expect(wheres[0]!.params).toEqual(['Seguros Andinos']);
  });

  it('AC4: el INSERT pierde la carrera (23505 del índice parcial) → el mismo 409, nunca 500', async () => {
    selectMock.mockReturnValueOnce(select([]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.reject(errorUnico()) }) });
    const r = await request(await buildApp()).post(URL).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC4: el 23505 envuelto por Drizzle en `cause` también se reconoce; otra constraint no', () => {
    expect(esDuplicadoNombreProveedorSoat(new Error('wrap', { cause: errorUnico() }))).toBe(true);
    expect(esDuplicadoNombreProveedorSoat(Object.assign(new Error('x'), { code: '23505', constraint_name: 'otra' }))).toBe(false);
    expect(esDuplicadoNombreProveedorSoat(Object.assign(new Error('x'), { code: '23503', constraint_name: 'uq_flito_proveedores_soat_nombre_vivo' }))).toBe(false);
  });
});

describe('PATCH /proveedores-soat/:id — nombre único entre vigentes (HU #13957)', () => {
  it('AC2: renombrar B al nombre de A vigente → 409, B sin cambios (no se actualiza)', async () => {
    selectMock.mockReturnValueOnce(select([{ id: 'a' }]));
    const r = await request(await buildApp()).patch(`${URL}/${ID_B}`).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('la consulta excluye al propio proveedor y solo cuenta vigentes; libre → 200', async () => {
    selectMock.mockReturnValueOnce(select([]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([fila()]) }) }) });
    const r = await request(await buildApp()).patch(`${URL}/${ID_B}`).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(200);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."deleted_at" is null/);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."id" <> \$2/);
    expect(wheres[0]!.params).toEqual(['Seguros Andinos', ID_B]);
  });

  it('el UPDATE pierde la carrera (23505) → el mismo 409', async () => {
    selectMock.mockReturnValueOnce(select([]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.reject(errorUnico()) }) }) });
    const r = await request(await buildApp()).patch(`${URL}/${ID_B}`).set('Authorization', await auth()).send({ nombre: 'Seguros Andinos' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE });
  });

  it('sin cambio de nombre no consulta unicidad', async () => {
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([fila({ slaHoras: 4 })]) }) }) });
    const r = await request(await buildApp()).patch(`${URL}/${ID_B}`).set('Authorization', await auth()).send({ slaHoras: 4 });
    expect(r.status).toBe(200);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('GET /proveedores-soat — no lista eliminados (HU #13957)', () => {
  it('filtra deleted_at IS NULL', async () => {
    selectMock.mockReturnValueOnce(select([fila()]));
    const r = await request(await buildApp()).get(URL).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(wheres[0]!.sql).toMatch(/"flito_proveedores_soat"\."deleted_at" is null/);
  });
});
