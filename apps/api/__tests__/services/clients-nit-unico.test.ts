// HU #13952 (Feature #13943, Épica #13671) — NIT único por sucursal en altas y ediciones (RN-CLI-7).
//
// Ruta con la BD mockeada: la validación previa (409 sin escribir), la exclusión del propio cliente (AC4), que la
// consulta solo cuente vigentes (`deleted_at IS NULL`, AC5), que sin NIT no se consulte (AC7) y que el 23505 del
// índice único en una carrera se traduzca al mismo 409 (AC6). El índice y la 0257 contra PostgreSQL viven en
// `db/migracion-0257.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';
import { esDuplicadoNitSucursal } from '../../src/modules/clients/clients.service.js';

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
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const dialecto = new PgDialect();
/** Los WHERE que recibieron los SELECT, compilados (texto + parámetros). */
let wheres: { sql: string; params: unknown[] }[] = [];

/** SELECT `from().where().limit()` que registra el WHERE y devuelve `filas`. */
function select(filas: unknown[]) {
  return {
    from: () => ({
      where: (w: SQL) => {
        wheres.push(dialecto.sqlToQuery(w));
        return { limit: () => Promise.resolve(filas) };
      },
    }),
  };
}

const errorUnico = () => Object.assign(new Error('duplicate key value violates unique constraint'), {
  code: '23505', constraint_name: 'uq_clients_document_branch_vivo',
});

const previo = (extra: Record<string, unknown> = {}) => ({
  id: 1, name: 'Acme SAS', document: '900123456', documentType: 'NIT', personType: 'Company', idType: '31',
  checkDigit: null, fiscalResponsibilities: [], branchOffice: 0, active: true, ...extra,
});

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  wheres = [];
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 1, role: 'admin' })}`;

describe('POST /clients — NIT único por sucursal (RN-CLI-7)', () => {
  it('AC1: NIT + sucursal de un cliente vigente → 409 con el mensaje de la HU, sin insertar', async () => {
    selectMock.mockReturnValueOnce(select([{ id: 7 }]));
    const r = await request(await buildApp()).post('/api/clients').set('Authorization', await auth())
      .send({ name: 'Repetido', document: '900123456', branchOffice: 3 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Ya existe un cliente con el NIT 900123456 y sucursal 3.', campo: 'document' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC5: la consulta solo cuenta clientes vigentes (deleted_at IS NULL) y compara el NIT normalizado', async () => {
    selectMock.mockReturnValueOnce(select([]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 8, name: 'N' }]) }) });
    const r = await request(await buildApp()).post('/api/clients').set('Authorization', await auth())
      .send({ name: 'N', document: '900123456', branchOffice: 2 });
    expect(r.status).toBe(201);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.sql).toMatch(/"clients"\."deleted_at" is null/);
    expect(wheres[0]!.sql).toMatch(/upper\(btrim\("clients"\."document"\)\)/);
    expect(wheres[0]!.params).toEqual(expect.arrayContaining(['900123456', 2]));
  });

  it('AC2: el mismo NIT en otra sucursal (pre-chequeo vacío) se crea', async () => {
    selectMock.mockReturnValueOnce(select([]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 9, name: 'S2' }]) }) });
    const r = await request(await buildApp()).post('/api/clients').set('Authorization', await auth())
      .send({ name: 'S2', document: '900123456', branchOffice: 2 });
    expect(r.status).toBe(201);
  });

  it('AC7: sin document no participa (no consulta unicidad)', async () => {
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.resolve([{ id: 10, name: 'Sin NIT' }]) }) });
    const r = await request(await buildApp()).post('/api/clients').set('Authorization', await auth())
      .send({ name: 'Sin NIT' });
    expect(r.status).toBe(201);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('AC6: el INSERT pierde la carrera (23505 del índice) → el mismo 409, nunca 500', async () => {
    selectMock.mockReturnValueOnce(select([]));
    insertMock.mockReturnValueOnce({ values: () => ({ returning: () => Promise.reject(errorUnico()) }) });
    const r = await request(await buildApp()).post('/api/clients').set('Authorization', await auth())
      .send({ name: 'Carrera', document: '900123456', branchOffice: 0 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe un cliente con el NIT 900123456 y sucursal 0.');
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /clients/:id — NIT único por sucursal (RN-CLI-7)', () => {
  it('AC3: mover a un NIT + sucursal ocupado por otro vigente → 409, sin actualizar', async () => {
    selectMock.mockReturnValueOnce(select([previo()])).mockReturnValueOnce(select([{ id: 42 }]));
    const r = await request(await buildApp()).patch('/api/clients/1').set('Authorization', await auth())
      .send({ branchOffice: 5 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe un cliente con el NIT 900123456 y sucursal 5.');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('AC4: la consulta excluye al propio cliente y solo cuenta vigentes; guardar su propio NIT → 200', async () => {
    selectMock.mockReturnValueOnce(select([previo()])).mockReturnValueOnce(select([]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...previo(), name: 'Acme' }]) }) }),
    });
    const r = await request(await buildApp()).patch('/api/clients/1').set('Authorization', await auth())
      .send({ document: '900123456', branchOffice: 0 });
    expect(r.status).toBe(200);
    const unicidad = wheres[1]!;
    expect(unicidad.sql).toMatch(/"clients"\."id" <> \$\d+/);
    expect(unicidad.sql).toMatch(/"clients"\."deleted_at" is null/);
    expect(unicidad.params).toEqual(expect.arrayContaining(['900123456', 0, 1]));
  });

  it('AC6: el UPDATE pierde la carrera (23505 envuelto en `cause`) → el mismo 409', async () => {
    selectMock.mockReturnValueOnce(select([previo()])).mockReturnValueOnce(select([]));
    const envuelto = Object.assign(new Error('Failed query'), { cause: errorUnico() });
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.reject(envuelto) }) }) });
    const r = await request(await buildApp()).patch('/api/clients/1').set('Authorization', await auth())
      .send({ branchOffice: 4 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe un cliente con el NIT 900123456 y sucursal 4.');
  });

  it('AC7: un cliente sin NIT que cambia de sucursal no consulta unicidad', async () => {
    selectMock.mockReturnValueOnce(select([previo({ document: null })]));
    updateMock.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...previo({ document: null }), branchOffice: 4 }]) }) }),
    });
    const r = await request(await buildApp()).patch('/api/clients/1').set('Authorization', await auth())
      .send({ branchOffice: 4 });
    expect(r.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('esDuplicadoNitSucursal (AC6)', () => {
  it('solo reconoce el 23505 del índice NIT + sucursal (directo o en `cause`)', () => {
    expect(esDuplicadoNitSucursal(errorUnico())).toBe(true);
    expect(esDuplicadoNitSucursal(Object.assign(new Error('q'), { cause: errorUnico() }))).toBe(true);
    expect(esDuplicadoNitSucursal(Object.assign(new Error('d'), { code: '23505', constraint_name: 'clients_pkey' }))).toBe(false);
    expect(esDuplicadoNitSucursal(Object.assign(new Error('fk'), { code: '23503', constraint_name: 'uq_clients_document_branch_vivo' }))).toBe(false);
    expect(esDuplicadoNitSucursal(new Error('otro'))).toBe(false);
    expect(esDuplicadoNitSucursal(undefined)).toBe(false);
  });
});
