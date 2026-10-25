// HU #13953 (Feature #13943, Épica #13671) — Excluir clientes eliminados de listados y selectores (RN-CLI-9).
//
// Rutas con la BD mockeada: se afirma el WHERE COMPILADO (`"clients"."deleted_at" is null`) de cada consulta que
// decide, y la respuesta HTTP cuando el eliminado no pasa el filtro. Lo que se decide contra la fila real (cruce por
// NIT, tarifas, bolsa, lectura histórica) vive en `db/clientes-eliminados-excluidos.test.ts`; la parte de usuarios
// (AC3) en `users.routes.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

const { selectMock, updateMock, auditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), updateMock: vi.fn(), auditMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: updateMock, delete: vi.fn(), transaction: vi.fn(),
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
const VIGENTE = /"clients"\."deleted_at" is null/;
let wheres: string[] = [];

/** SELECT encadenable que registra el WHERE compilado y resuelve a `filas` en cualquier punto de la cadena. */
function select(filas: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset']) c[m] = () => c;
  c.where = (w: SQL) => { wheres.push(dialecto.sqlToQuery(w).sql); return c; };
  c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, ko);
  return c;
}

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset();
  auditMock.mockReset().mockResolvedValue(undefined);
  wheres = [];
});

async function app() {
  const a = express();
  a.use(express.json());
  const { default: clientes } = await import('../../src/modules/clients/clients.routes.js');
  const { default: parametrizacion } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  a.use('/api/clients', clientes);
  a.use('/api/flito/parametrizacion', parametrizacion);
  return a;
}
const auth = async () => `Bearer ${await testToken({ sub: 1, username: 'admin@flito.co', role: 'admin' })}`;

const filaListado = {
  id: 1, name: 'Vigente SAS', document: '900', documentType: 'NIT', phone: null, email: null, address: null, city: null,
  soatAutogestionable: false, soatSinTramite: false, impuestosAutogestionable: false,
  logisticaAutogestionable: false, logisticaPermiteParcial: false, personType: null, idType: null, checkDigit: null,
  fiscalResponsibilities: [], countryCode: null, stateCode: null, cityCode: null, commercialName: null, branchOffice: 0,
  contactFirstName: null, contactLastName: null, contactEmail: null, phoneIndicative: null, phoneNumber: null,
  gestorSinTramiteId: null, gestorSinTramiteNombre: null, gestorSinTramiteActivo: null,
};

describe('Clientes — RN-CLI-9 (HU #13953)', () => {
  it('AC1: GET /clients solo consulta vigentes (el contrato de columnas de `clients.pii.ts` no cambia)', async () => {
    selectMock.mockReturnValueOnce(select([filaListado]));
    const r = await request(await app()).get('/api/clients').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]).toMatch(VIGENTE);
    expect(r.body[0]).toMatchObject({ id: 1, name: 'Vigente SAS' });
  });

  it('AC2: PATCH /clients/:id de un eliminado → 404 «Cliente no encontrado», sin escribir', async () => {
    selectMock.mockReturnValueOnce(select([])); // el eliminado no pasa el filtro
    const r = await request(await app()).patch('/api/clients/9').set('Authorization', await auth())
      .send({ name: 'Nuevo nombre' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Cliente no encontrado' });
    expect(wheres[0]).toMatch(VIGENTE);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC2: el UPDATE del PATCH también exige vigente (baja lógica entre la lectura y la escritura → 404)', async () => {
    selectMock.mockReturnValueOnce(select([{ ...filaListado, id: 9 }]));
    let whereUpdate = '';
    updateMock.mockReturnValueOnce({
      set: () => ({ where: (w: SQL) => { whereUpdate = dialecto.sqlToQuery(w).sql; return { returning: () => Promise.resolve([]) }; } }),
    });
    const r = await request(await app()).patch('/api/clients/9').set('Authorization', await auth())
      .send({ name: 'Nuevo nombre' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Cliente no encontrado' });
    expect(whereUpdate).toMatch(VIGENTE);
  });
});

describe('Parametrización de compañías — RN-CLI-9 (HU #13953)', () => {
  it('selector GET /companias: solo vigentes y cada compañía trae `activo`', async () => {
    selectMock.mockReturnValueOnce(select([{
      ...filaListado, active: false, flitoProveedorSoatSinTramiteId: null, flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0',
    }]));
    const r = await request(await app()).get('/api/flito/parametrizacion/companias').set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(wheres[0]).toMatch(VIGENTE);
    expect(r.body[0]).toMatchObject({ id: 1, activo: false });
  });

  it('gestor por defecto (PATCH /companias/:id) de un eliminado → 404, sin escribir', async () => {
    selectMock.mockReturnValueOnce(select([])); // previa: el eliminado no pasa el filtro
    const r = await request(await app()).patch('/api/flito/parametrizacion/companias/9').set('Authorization', await auth())
      .send({ soatSinTramite: false });
    expect(r.status).toBe(404);
    expect(wheres[0]).toMatch(VIGENTE);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
