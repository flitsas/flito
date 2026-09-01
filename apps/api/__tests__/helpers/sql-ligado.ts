// Qué valor quedó ligado a QUÉ comparación del SQL renderizado.
//
// Nace de una aserción que pasaba sin comprobar lo que decía (HU #11916). Un test del aislamiento
// del canal Cliente afirmaba la frontera así:
//
//     expect(sql).toContain('"flito_soat"."origen" =');
//     expect(params).toContain('cliente');
//
// Las dos líneas son ciertas a la vez aunque la condición compare `origen` contra OTRA cosa: basta
// con que el literal `'cliente'` esté enlazado en cualquier otro punto del mismo WHERE —y en la cola
// del canal hay varios— para que `toContain` pase. Es la misma clase de verde vacío que el gate ya
// encontró cinco veces en esta cadena: la aserción mira el conjunto, no la posición.
//
// `PgDialect.sqlToQuery()` devuelve el SQL con marcadores posicionales (`$1`, `$2`, …) y el array de
// parámetros en ese mismo orden, así que la posición SÍ está disponible: solo hay que leerla.

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialecto = new PgDialect();

export interface SqlRenderizado {
  sql: string;
  params: unknown[];
}

/** El SQL que Postgres recibiría, con sus parámetros en orden. */
export function renderizar(condicion: SQL): SqlRenderizado {
  const q = dialecto.sqlToQuery(condicion);
  return { sql: q.sql, params: q.params as unknown[] };
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Los valores ligados a la comparación de ESTA columna: `col = $N` o `col in ($N, $M, …)`.
 *
 * Lanza si la columna no aparece comparada. Es deliberado: devolver `[]` haría que un
 * `expect(...).not.toContain(x)` pasara también cuando la condición entera desapareció del código,
 * que es justo el mutante que estas pruebas tienen que atrapar.
 */
export function ligadosA(q: SqlRenderizado, columna: string): unknown[] {
  const col = escapar(columna);
  const igualdad = new RegExp(`${col}\\s*=\\s*\\$(\\d+)`).exec(q.sql);
  if (igualdad) return [q.params[Number(igualdad[1]) - 1]];

  const lista = new RegExp(`${col}\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(q.sql);
  if (lista) {
    return [...lista[1].matchAll(/\$(\d+)/g)].map((m) => q.params[Number(m[1]) - 1]);
  }
  throw new Error(`El SQL no compara ${columna}. Recibido:\n${q.sql}`);
}

/** Azúcar para el caso de un solo valor. */
export function ligadoA(q: SqlRenderizado, columna: string): unknown {
  const vs = ligadosA(q, columna);
  if (vs.length !== 1) throw new Error(`${columna} tiene ${vs.length} valores ligados, no uno`);
  return vs[0];
}
