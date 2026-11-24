// HU #14125 — pestaña Entregas. POST /traslados/buscar. Doubles de BD. Este archivo, no el glob del módulo.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, selectDistinct: selectDistinctMock,
    insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { clients } = await import('../../src/db/schema.js');
const { TOPE_ENTREGAS } = await import('../../src/modules/flito-logistica/flito-logistica.entregas.js');

const dialect = new PgDialect();
const sqlDe = (q: unknown) => dialect.sqlToQuery(q as SQL);

type Consulta = { wheres: unknown[]; orders: unknown[][]; limits: unknown[]; joins: unknown[] };
const consultas: Consulta[] = [];

function espia(filas: unknown[]) {
  const consulta: Consulta = { wheres: [], orders: [], limits: [], joins: [] };
  consultas.push(consulta);
  const c = chain(filas);
  c.where = ((cond: unknown) => { consulta.wheres.push(cond); return c; }) as typeof c.where;
  c.orderBy = ((...args: unknown[]) => { consulta.orders.push(args); return c; }) as typeof c.orderBy;
  c.limit = ((n: unknown) => { consulta.limits.push(n); return c; }) as typeof c.limit;
  c.leftJoin = ((table: unknown, on: unknown) => { consulta.joins.push({ table, on }); return c; }) as typeof c.leftJoin;
  return c;
}

function encolar(respuestas: unknown[][]) {
  const cola = [...respuestas];
  const impl = () => espia(cola.shift() ?? []);
  selectMock.mockImplementation(impl);
  selectDistinctMock.mockImplementation(impl);
}

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/logistica', conAlcance('logistica', router));
  a.use(errorHandler);
  return a;
}

const ver = (over: { sub?: number; role?: 'admin' | 'mensajero' | 'auditor'; tipoEnlace?: string } = {}) =>
  testToken({ role: over.role ?? 'admin', sub: over.sub ?? 14125, tipoEnlace: over.tipoEnlace });

async function post(body: unknown, token?: string) {
  const r = request(await app()).post('/api/flito/logistica/traslados/buscar');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send(body as object);
}

const T2 = new Date('2026-10-28T15:00:00.000Z');
const T1 = new Date('2026-10-01T12:00:00.000Z');
const ID_NUEVO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ID_VIEJO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function viaje(over: Record<string, unknown> = {}) {
  return {
    id: ID_NUEVO, companiaId: 10, companiaNombre: 'Andina', destino: 'cliente', estado: 'registrado',
    cantidadLt: 1, registradoEn: T2, ...over,
  };
}

const COMPANIAS = [
  { companiaId: 10, nombre: 'Andina' },
  { companiaId: 30, nombre: null },
  { companiaId: 20, nombre: 'Zeta' },
];

beforeEach(() => {
  selectMock.mockReset();
  selectDistinctMock.mockReset();
  consultas.length = 0;
});

describe('HU #14125 — entregas', () => {
  it('enlace → 403 sin leer viajes aunque el body traiga una placa', async () => {
    const token = await ver({ sub: 14126, tipoEnlace: 'compania' });
    const r = await post({ placa: 'ABC123' }, token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it('interno sin la función → 403 sin leer viajes', async () => {
    const token = await ver({ sub: 14127, role: 'mensajero' });
    const r = await post({}, token);
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe('logistica.consola.ver');
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it('orden registrado_en DESC, desempate id DESC; cero filas sigue en 200', async () => {
    encolar([[
      viaje({ id: ID_NUEVO, registradoEn: T2 }),
      viaje({ id: ID_VIEJO, registradoEn: T1, companiaNombre: 'Zeta', companiaId: 20 }),
    ], COMPANIAS]);
    const r = await post({}, await ver());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.truncado).toBe(false);
    expect(r.body.viajes.map((v: { id: string; registradoEn: string }) => [v.id, v.registradoEn])).toEqual([
      [ID_NUEVO, T2.toISOString()],
      [ID_VIEJO, T1.toISOString()],
    ]);
    expect(consultas[0].orders).toHaveLength(1);
    expect(consultas[0].orders[0]).toHaveLength(2);
    const orden = consultas[0].orders[0].map((o) => sqlDe(o).sql.toLowerCase());
    expect(orden[0]).toContain('registrado_en');
    expect(orden[0]).toContain('desc');
    expect(orden[1]).toMatch(/"id"/);
    expect(orden[1]).toContain('desc');
    expect(consultas[0].limits).toEqual([TOPE_ENTREGAS + 1]);

    consultas.length = 0;
    encolar([[], []]);
    const vacio = await post({}, await ver({ sub: 14128 }));
    expect(vacio.status).toBe(200);
    expect(vacio.body).toEqual({ viajes: [], companias: [], truncado: false });
    expect(consultas[0].wheres).toEqual([]);
  });

  it('placa por igualdad normalizada y la respuesta no trae la placa; vacía no filtra', async () => {
    encolar([[viaje()], COMPANIAS]);
    const token = await ver({ sub: 14129 });
    const r = await post({ placa: ' zx-9 8 ' }, token);
    expect(r.status).toBe(200);
    expect(r.body.viajes).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/zx-9|ZX-9|ZX98|placa/i);
    expect(Object.keys(r.body.viajes[0]).sort()).toEqual(
      ['cantidadLt', 'companiaId', 'companiaNombre', 'destino', 'estado', 'id', 'registradoEn'],
    );
    const where = sqlDe(consultas[0].wheres[0]);
    expect(where.sql.toLowerCase()).toContain('exists');
    expect(where.sql.toLowerCase()).not.toContain('ilike');
    expect(where.sql.toLowerCase()).toContain('upper');
    expect(where.params).toContain('ZX98');
    expect(consultas[1].wheres).toEqual([]);

    consultas.length = 0;
    encolar([[viaje({ id: ID_VIEJO })], COMPANIAS]);
    for (const placa of ['', '---', '  - -  ']) {
      consultas.length = 0;
      encolar([[viaje({ id: ID_VIEJO })], COMPANIAS]);
      const sin = await post({ placa }, await ver({ sub: 14130 }));
      expect(sin.status, placa).toBe(200);
      expect(consultas[0].wheres, placa).toEqual([]);
    }
  });

  it('varias LT no duplican el viaje y cantidadLt es el número de líneas', async () => {
    encolar([[viaje({ cantidadLt: 3 })], COMPANIAS]);
    const r = await post({}, await ver({ sub: 14131 }));
    expect(r.status).toBe(200);
    expect(r.body.viajes).toHaveLength(1);
    expect(r.body.viajes[0].cantidadLt).toBe(3);
    expect(consultas[0].joins).toEqual([{ table: clients, on: expect.anything() }]);
    const conteo = sqlDe(selectMock.mock.calls[0][0].cantidadLt);
    expect(conteo.sql.toLowerCase()).toContain('count(*)');
    expect(conteo.sql).toContain('flito_logistica_traslado_lts');
    expect(conteo.sql.toLowerCase()).not.toContain('devuelto');
    expect(conteo.sql.toLowerCase()).not.toContain('anulado');
  });

  it('filtros de estado, destino y compañía se combinan con AND', async () => {
    encolar([[viaje({ estado: 'en_ruta', destino: 'flit', companiaId: 20, companiaNombre: 'Zeta' })], COMPANIAS]);
    const r = await post({ estado: 'en_ruta', destino: 'flit', companiaId: 20 }, await ver({ sub: 14132 }));
    expect(r.status).toBe(200);
    expect(r.body.viajes).toEqual([expect.objectContaining({ estado: 'en_ruta', destino: 'flit', companiaId: 20 })]);
    const where = sqlDe(consultas[0].wheres[0]);
    expect(where.params).toEqual(expect.arrayContaining(['en_ruta', 'flit', 20]));
    expect(where.sql.toLowerCase()).toContain('and');
    expect(consultas[1].wheres).toEqual([]);
  });

  it('companias lista las compañías con viaje y no cambia al filtrar', async () => {
    encolar([[], COMPANIAS]);
    const token = await ver({ sub: 14133 });
    const todas = await post({}, token);
    expect(todas.status).toBe(200);
    expect(todas.body.companias).toEqual(COMPANIAS);
    expect(todas.body.viajes).toEqual([]);
    expect(todas.body.truncado).toBe(false);
    expect(selectDistinctMock).toHaveBeenCalledTimes(1);
    const orden = sqlDe(consultas[1].orders[0][0]).sql.toLowerCase();
    expect(orden).toContain('name');
    expect(orden).not.toContain('desc');
    expect(consultas[1].limits).toEqual([]);
    expect(consultas[1].wheres).toEqual([]);

    consultas.length = 0;
    encolar([[], COMPANIAS]);
    const filtrada = await post({ estado: 'anulado', placa: 'AAA111' }, await ver({ sub: 14134 }));
    expect(filtrada.body.companias).toEqual(COMPANIAS);
    expect(filtrada.body.viajes).toEqual([]);
    expect(consultas[0].wheres).toHaveLength(1);
    expect(consultas[1].wheres).toEqual([]);
    expect(sqlDe(consultas[0].wheres[0]).params).toEqual(expect.arrayContaining(['anulado', 'AAA111']));
    expect(sqlDe(consultas[1].orders[0][0]).sql.toLowerCase()).not.toContain('estado');
  });

  it('legado entra y no filtra por mensajero', async () => {
    encolar([[viaje()], COMPANIAS]);
    const r = await post({}, await ver({ sub: 14135 }));
    expect(r.status).toBe(200);
    expect(r.body.viajes).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/legado|mensajero|nit|precio|cedula|firma|payload/i);
    const campos = selectMock.mock.calls[0][0] as Record<string, unknown>;
    for (const k of ['mensajeroId', 'legado', 'placa', 'precio', 'origen']) {
      expect(Object.keys(campos), k).not.toContain(k);
    }
    const viajesSql = [
      sqlDe(campos.cantidadLt).sql,
      ...consultas[0].orders[0].map((o) => sqlDe(o).sql),
    ].join(' ').toLowerCase();
    expect(viajesSql).not.toContain('legado');
    expect(viajesSql).not.toContain('mensajero');
    expect(consultas[0].wheres).toEqual([]);
  });

  it('tope 200: lee 201 y marca truncado si sobra una', async () => {
    const filas = Array.from({ length: TOPE_ENTREGAS + 1 }, (_, i) => viaje({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`,
      registradoEn: new Date(Date.UTC(2026, 9, 28, 15, 0, i)),
    }));
    encolar([filas, COMPANIAS]);
    const r = await post({}, await ver({ sub: 14136 }));
    expect(r.status).toBe(200);
    expect(r.body.truncado).toBe(true);
    expect(r.body.viajes).toHaveLength(TOPE_ENTREGAS);
    expect(r.body.viajes[0].id).toBe(filas[0].id);
    expect(r.body.viajes.some((v: { id: string }) => v.id === filas[TOPE_ENTREGAS].id)).toBe(false);
    expect(consultas[0].limits).toEqual([201]);
    expect(r.body.companias).toEqual(COMPANIAS);
  });

  it('body inválido → 400 sin leer viajes', async () => {
    const token = await ver({ sub: 14137 });
    const cuerpos = [
      { placa: '12345678901' },
      { estado: 'pendiente' },
      { destino: 'organismo' },
      { companiaId: 0 },
      { companiaId: 1.5 },
      { page: 1 },
      { limite: 10 },
      { placa: 'ABC12', extra: true },
    ];
    for (const body of cuerpos) {
      selectMock.mockClear();
      selectDistinctMock.mockClear();
      const r = await post(body, token);
      expect([body, r.status, r.body]).toEqual([body, 400, { error: 'Datos inválidos' }]);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(selectMock).not.toHaveBeenCalled();
      expect(selectDistinctMock).not.toHaveBeenCalled();
    }
  });
});
