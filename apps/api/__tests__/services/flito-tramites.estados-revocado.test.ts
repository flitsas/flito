// HU #13091 — AC7: un trámite revocado en FLIT 2 es anulado en FLITO; filtrar por «Anulado» lo trae.
//
// El helper `chain()` descarta los argumentos de `.where()` e inventa columnas, así que asertar sobre
// las filas del mock no prueba el filtro. Aquí el `select` es un espía que GUARDA cada `.where()` del
// listado (conteo y página) y se renderiza con el dialecto de Postgres: lo que se asierta es el SQL y
// los parámetros que de verdad llegarían a la base.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const wheres: (SQL | undefined)[] = [];
let respuestas: unknown[][] = [];

/** Chain thenable que registra el argumento de `.where()` y resuelve a la siguiente respuesta. */
function espia() {
  const filas = respuestas.shift() ?? [];
  const t: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'groupBy']) t[m] = () => t;
  t.where = (c: SQL | undefined) => { wheres.push(c); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej);
  return t;
}

const selectMock = vi.fn(() => espia());
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));

const { listar } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

const dialecto = new PgDialect();
const render = (c: SQL | undefined) => (c ? dialecto.sqlToQuery(c) : { sql: '', params: [] as unknown[] });
/** [conteo, página]: las dos consultas del listado que llevan los filtros. */
const condicionesLeidas = () => [render(wheres[0]), render(wheres[1])];
const COND_ESTADO = '"flito_tramites"."flit_estado" in';

/** Estados enlazados al `IN` de flit_estado, extraídos del SQL renderizado (no de la fila del mock). */
function estadosDelIn(q: { sql: string; params: unknown[] }): unknown[] {
  const m = q.sql.match(/"flito_tramites"\."flit_estado" in \(([^)]*)\)/);
  expect(m, 'el WHERE debe filtrar flit_estado con IN').not.toBeNull();
  return m![1].split(',').map((p) => q.params[Number(p.trim().slice(1)) - 1]);
}

beforeEach(() => {
  wheres.length = 0;
  selectMock.mockClear();
  // count, página (vacía: no se asierta sobre filas).
  respuestas = [[{ total: 0 }], []];
});

describe('HU #13091 · TC-37 (AC7) — «Anulado» en el filtro de estado incluye los revocados', () => {
  it('TC-37a: estados=[Anulado] filtra el conteo Y la página por Anulado + Revocado', async () => {
    await listar({ estados: ['Anulado'] });
    for (const q of condicionesLeidas()) {
      expect(q.sql).toContain(COND_ESTADO);
      expect(estadosDelIn(q)).toEqual(['Anulado', 'Revocado']);
    }
  });

  it('TC-37b: estados=[Revocado] trae solo los revocados (la expansión es de un sentido)', async () => {
    await listar({ estados: ['Revocado'] });
    for (const q of condicionesLeidas()) expect(estadosDelIn(q)).toEqual(['Revocado']);
  });

  it('TC-37c: estados=[Aprobado] no cambia (otros estados no se expanden)', async () => {
    await listar({ estados: ['Aprobado'] });
    for (const q of condicionesLeidas()) expect(estadosDelIn(q)).toEqual(['Aprobado']);
  });

  it('TC-37d: estados=[Anulado, Revocado] no duplica Revocado', async () => {
    await listar({ estados: ['Anulado', 'Revocado'] });
    for (const q of condicionesLeidas()) expect(estadosDelIn(q)).toEqual(['Anulado', 'Revocado']);
  });
});
