// HU #14124 — línea de tiempo de la LT. Misma función que GET /:id. Doubles de BD.
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
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { users } = await import('../../src/db/schema.js');

const DOC = '11111111-1111-4111-8111-111111111111';
const TRAM = '66666666-6666-4666-8666-666666666666';
const T2 = new Date('2026-10-02T15:00:00.000Z');
const T1 = new Date('2026-10-01T15:00:00.000Z');
const T0 = new Date('2026-09-30T15:00:00.000Z');
const dialect = new PgDialect();
const sqlDe = (q: unknown) => dialect.sqlToQuery(q as SQL);

const wheres: unknown[] = [];
const joins: { table: unknown; on: unknown }[] = [];
const orders: unknown[][] = [];
const capturas: Record<string, unknown>[] = [];

function espia(filas: unknown[]) {
  const c = chain(filas);
  c.where = ((cond: unknown) => { wheres.push(cond); return c; }) as typeof c.where;
  c.orderBy = ((...args: unknown[]) => { orders.push(args); return c; }) as typeof c.orderBy;
  c.leftJoin = ((table: unknown, on: unknown) => { joins.push({ table, on }); return c; }) as typeof c.leftJoin;
  return c;
}

function encolar(respuestas: unknown[][]) {
  const cola = [...respuestas];
  selectMock.mockImplementation((campos: Record<string, unknown>) => {
    capturas.push(campos);
    return espia(cola.shift() ?? []);
  });
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

const ver = (over: { sub?: number; tipoEnlace?: string } = {}) =>
  testToken({ role: 'admin', sub: over.sub ?? 14124, tipoEnlace: over.tipoEnlace, funciones: ['logistica.documento.ver'] });

async function get(ruta: string, token?: string) {
  const r = request(await app()).get(`/api/flito/logistica${ruta}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
}

beforeEach(() => {
  selectMock.mockReset();
  wheres.length = 0;
  joins.length = 0;
  orders.length = 0;
  capturas.length = 0;
});

const hitos = () => [
  {
    id: 'e-flit', tipo: null, fecha: T2, actorNombre: 'Ana', destino: 'flit', motivo: 'Ventanilla',
    estadoNuevo: 'en_flit', payload: { nota: 'NOTA-LIBRE', cedula: 'CEDULA-9', motivoLlegadaId: 'no-es-uuid' },
    lat: '4.1000000', lng: '-74.1000000', firmaStorageKey: 'FIRMA-KEY', fotoStorageKey: 'FOTO-KEY',
  },
  { id: 'e-reversa', tipo: 'reversa', fecha: T2, actorNombre: null, destino: 'cliente', motivo: null, estadoNuevo: 'clasificado' },
  { id: 'e-anula', tipo: 'anulado', fecha: T1, actorNombre: 'Luis', destino: null, motivo: 'Traslado interno', estadoNuevo: 'anulado' },
  { id: 'e-rec', tipo: null, fecha: T0, actorNombre: 'Ana', destino: null, motivo: 'Recogida en ventanilla', estadoNuevo: 'recogido' },
];

describe('HU #14124 — línea de tiempo', () => {
  it('hitos DESC con tipo, fecha, actor, destino y motivo; el mapa interpreta el nulo y en_flit sigue null', async () => {
    encolar([[{ id: DOC, tramiteId: TRAM }], hitos()]);
    const r = await get(`/documentos/${DOC}/linea-tiempo`, await ver());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      documentoId: DOC,
      tramiteId: TRAM,
      hitos: [
        { id: 'e-flit', tipo: null, fecha: T2.toISOString(), actorNombre: 'Ana', destino: 'flit', motivo: 'Ventanilla', estadoNuevo: 'en_flit' },
        { id: 'e-reversa', tipo: 'reversa', fecha: T2.toISOString(), actorNombre: null, destino: 'cliente', motivo: null, estadoNuevo: 'clasificado' },
        { id: 'e-anula', tipo: 'anulacion', fecha: T1.toISOString(), actorNombre: 'Luis', destino: null, motivo: 'Traslado interno', estadoNuevo: 'anulado' },
        { id: 'e-rec', tipo: 'recogida', fecha: T0.toISOString(), actorNombre: 'Ana', destino: null, motivo: 'Recogida en ventanilla', estadoNuevo: 'recogido' },
      ],
    });
    const crudo = JSON.stringify(r.body);
    expect(crudo).not.toMatch(/NOTA-LIBRE|CEDULA-9|FIRMA-KEY|FOTO-KEY|payload|firma|cedula|lat|lng/);
    expect(Object.keys(r.body.hitos[0]).sort()).toEqual(['actorNombre', 'destino', 'estadoNuevo', 'fecha', 'id', 'motivo', 'tipo']);

    expect(sqlDe(wheres[0]).params).toEqual([DOC, 'licencia_transito']);
    expect(joins).toEqual([{ table: users, on: expect.anything() }]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toHaveLength(1);
    expect(sqlDe(orders[0][0]).sql.toLowerCase()).toContain('created_at');
    expect(sqlDe(orders[0][0]).sql.toLowerCase()).toContain('desc');

    const motivo = sqlDe(capturas[1].motivo);
    expect(motivo.sql).toMatch(/flito_logistica_motivos_llegada/);
    expect(motivo.sql).toContain('motivoLlegadaId');
    expect(motivo.sql).toContain('::uuid');
    expect(motivo.sql).toMatch(/~/);
    expect(motivo.sql).not.toMatch(/activo/);
    expect(motivo.sql.toLowerCase()).not.toMatch(/nota/);
  });

  it('reversa y anulación salen; una LT sin eventos devuelve hitos vacíos; la pendiente de trámite también', async () => {
    encolar([[{ id: DOC, tramiteId: TRAM }], []]);
    const vacia = await get(`/documentos/${DOC}/linea-tiempo`, await ver());
    expect(vacia.status).toBe(200);
    expect(vacia.body).toEqual({ documentoId: DOC, tramiteId: TRAM, hitos: [] });

    encolar([[{ id: DOC, tramiteId: null }], [
      { id: 'e-pend', tipo: 'reversa', fecha: T2, actorNombre: null, destino: null, motivo: null, estadoNuevo: 'recogido' },
      { id: 'e-anula', tipo: 'anulado', fecha: T2, actorNombre: 'Ana', destino: null, motivo: null, estadoNuevo: 'anulado' },
    ]]);
    const pend = await get(`/documentos/${DOC}/linea-tiempo`, await ver({ sub: 14130 }));
    expect(pend.status).toBe(200);
    expect(pend.body.documentoId).toBe(DOC);
    expect(pend.body.tramiteId).toBeNull();
    expect(pend.body.hitos.map((h: { id: string; tipo: string | null }) => [h.id, h.tipo])).toEqual([
      ['e-pend', 'reversa'], ['e-anula', 'anulacion'],
    ]);
    expect(JSON.stringify(pend.body)).not.toMatch(/cedula|firma|payload/i);
  });

  it('id que no es uuid o LT inexistente → 404, sin filtrar de más', async () => {
    const token = await ver();
    const malo = await get('/documentos/no-es-uuid/linea-tiempo', token);
    expect(malo.status).toBe(404);
    expect(malo.body).toEqual({ error: 'La LT no existe' });
    expect(malo.headers['cache-control']).toBe('no-store');
    expect(selectMock).not.toHaveBeenCalled();

    encolar([[]]);
    const no = await get(`/documentos/${DOC}/linea-tiempo`, token);
    expect(no.status).toBe(404);
    expect(no.body).toEqual({ error: 'La LT no existe' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('trámite sin LT → hitos vacíos; trámite inexistente o id inválido → 404', async () => {
    encolar([[{ tramiteId: TRAM, documentoId: null }]]);
    const token = await ver();
    const vacio = await get(`/tramites/${TRAM}/linea-tiempo`, token);
    expect(vacio.status).toBe(200);
    expect(vacio.headers['cache-control']).toBe('no-store');
    expect(vacio.body).toEqual({ documentoId: null, tramiteId: TRAM, hitos: [] });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(sqlDe(joins[0].on).params).toContain('licencia_transito');
    expect(sqlDe(wheres[0]).params).toEqual([TRAM]);

    encolar([[]]);
    const no = await get(`/tramites/${TRAM}/linea-tiempo`, token);
    expect(no.status).toBe(404);
    expect(no.body).toEqual({ error: 'El trámite no existe' });

    selectMock.mockReset();
    const malo = await get('/tramites/no-es-uuid/linea-tiempo', token);
    expect(malo.status).toBe(404);
    expect(malo.body).toEqual({ error: 'El trámite no existe' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('enlace compañía → 403 sin consultar si el id existe; proveedor y organismos los cierra la frontera', async () => {
    const rutas = [`/documentos/${DOC}/linea-tiempo`, `/tramites/${TRAM}/linea-tiempo`];
    for (const [i, tipo] of ['compania', 'proveedor', 'organismos_transito'].entries()) {
      const token = await ver({ sub: 14140 + i, tipoEnlace: tipo });
      for (const ruta of rutas) {
        selectMock.mockClear();
        const r = await get(ruta, token);
        expect([tipo, ruta, r.status, r.body]).toEqual([tipo, ruta, 403, { error: 'Sin permisos' }]);
        expect(selectMock).not.toHaveBeenCalled();
      }
    }
  });

  it('sin token → 401', async () => {
    const r = await get(`/documentos/${DOC}/linea-tiempo`);
    expect(r.status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
