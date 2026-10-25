// HU #12874 (Feature #12871) — `GET /api/flito/soat/cliente/companias`: a nombre de qué compañía
// puede radicar quien llena el formulario.
//
// Se mide la CONSULTA, no solo la respuesta: el mock de la base devuelve lo que el test le dé, así que
// afirmar sobre el cuerpo prueba el mock. Lo que se afirma es la proyección (solo `id` + `nombre`,
// nunca el NIT), el filtro por el proveedor del canal (HU #13967) y el orden — leídos del SQL que el servicio armó.
//
// `contextoSoat` se sustituye por el contexto de cada caso: lo que esta suite decide es la tabla
// enlace → lista; cómo se calcula el alcance lo prueba `flito-soat.frontera` y su suite.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

interface Consulta { columnas: Record<string, unknown>; where?: SQL; orderBy: unknown[]; limit?: number }
const consultas: Consulta[] = [];
let filas: unknown[] = [];

/** Thenable mínimo que guarda lo que el servicio le pidió a la base. */
const selectMock = vi.fn((columnas: Record<string, unknown>) => {
  const c: Consulta = { columnas, orderBy: [] };
  consultas.push(c);
  const q = {
    from: () => q,
    where: (w: SQL) => { c.where = w; return q; },
    orderBy: (...o: unknown[]) => { c.orderBy.push(...o); return q; },
    limit: (n: number) => { c.limit = n; return q; },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, ko),
  };
  return q;
});

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ctxMock = vi.fn();
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-soat/flito-soat.service.js')>()),
  contextoSoat: () => ctxMock(),
}));

const ctx = (alcance: string, companiaId: number | null) => ({
  userId: 1, username: 'u', role: 'admin', proyeccionCliente: alcance === 'compania', alcance, proveedorSoatId: null, companiaId,
});

async function pedir(funciones: string[] = ['soat.solicitud.crear'], role: 'admin' | 'auditor' = 'admin') {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  const token = `Bearer ${await testToken({ sub: 9100 + consultas.length, role, funciones })}`;
  return request(app).get('/api/flito/soat/cliente/companias').set('Authorization', token);
}

const sqlDe = (w: SQL | undefined) => (w ? new PgDialect().sqlToQuery(w) : { sql: '', params: [] });

beforeEach(() => { consultas.length = 0; filas = []; ctxMock.mockReset(); selectMock.mockClear(); });

describe('GET /cliente/companias (HU #12874)', () => {
  it('**AC1 — enlace compañía → solo la suya, `fija: true`, filtrada por id Y por el proveedor** (HU #13967 AC1)', async () => {
    ctxMock.mockResolvedValue(ctx('compania', 7));
    filas = [{ id: 7, nombre: 'ACME' }];
    const r = await pedir();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fija: true, companias: [{ id: 7, nombre: 'ACME' }] });
    expect(consultas).toHaveLength(1);
    const { sql, params } = sqlDe(consultas[0].where);
    expect(sql).toMatch(/"clients"\."id" = \$\d/);
    // HU #13967: el canal es el PROVEEDOR elegido (activo o inactivo), no el interruptor retirado.
    expect(sql).toMatch(/"clients"\."flito_proveedor_soat_sin_tramite_id" is not null/i);
    expect(sql).not.toMatch(/soat_sin_tramite"? =/);
    expect(params).toEqual([7]);
  });

  it('enlace compañía cuya compañía NO tiene el canal → lista vacía y `fija: true`', async () => {
    ctxMock.mockResolvedValue(ctx('compania', 7));
    filas = [];
    const r = await pedir();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fija: true, companias: [] });
  });

  it('**AC2 — sin enlace → todas las que tienen proveedor, `fija: false`, por nombre** (HU #13967 AC4)', async () => {
    ctxMock.mockResolvedValue(ctx('todo', null));
    filas = [{ id: 3, nombre: 'ALFA' }, { id: 7, nombre: 'BETA' }];
    const r = await pedir();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fija: false, companias: filas });
    const { sql, params } = sqlDe(consultas[0].where);
    // HU #13967: el canal es el PROVEEDOR elegido (activo o inactivo), no el interruptor retirado.
    expect(sql).toMatch(/"clients"\."flito_proveedor_soat_sin_tramite_id" is not null/i);
    expect(sql).not.toMatch(/soat_sin_tramite"? =/);
    expect(sql).not.toMatch(/"clients"\."id"/);
    expect(params).toEqual([]);
    expect(consultas[0].orderBy).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(consultas[0].orderBy[0] as SQL).sql).toBe('"clients"."name" asc');
  });

  it('**el DTO es `id` + `nombre` y nada más: nunca el NIT ni las banderas**', async () => {
    ctxMock.mockResolvedValue(ctx('todo', null));
    await pedir();
    expect(Object.keys(consultas[0].columnas).sort()).toEqual(['id', 'nombre']);
  });

  it.each([['proveedor'], ['nada']])('**alcance `%s` (proveedor / organismos) → 403 y sin consultar `clients`**', async (alcance) => {
    ctxMock.mockResolvedValue(ctx(alcance, null));
    const r = await pedir();
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('sin_compania');
    expect(consultas).toHaveLength(0);
  });

  it('sin `soat.solicitud.crear` → 403 de la función, antes de leer nada', async () => {
    // HU #12873 AC8 (ganancia aprobada): `admin` ya la tiene por «Solicitar SOAT sin trámite», así que el
    // «sin la función» lo pone un rol que no la tiene de partida (auditor).
    ctxMock.mockResolvedValue(ctx('todo', null));
    const r = await pedir([], 'auditor');
    expect(r.status).toBe(403);
    expect(ctxMock).not.toHaveBeenCalled();
  });

  it('HU #12873 AC8: `admin` sin funciones añadidas ya pasa la guarda (la acción le da `soat.solicitud.crear`)', async () => {
    ctxMock.mockResolvedValue(ctx('todo', null));
    const r = await pedir([]);
    expect(r.status).not.toBe(403);
    expect(ctxMock).toHaveBeenCalled();
  });
});
