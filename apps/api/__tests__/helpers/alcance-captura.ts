// HU #13426 — Doble de drizzle que CAPTURA los `where` de cada consulta y responde por una cola.
//
// Los tests de alcance por enlace tienen que afirmar sobre el SQL real (la condición de compañía u
// organismo EN el WHERE de la página, del COUNT y de las facetas), no sobre las filas que el propio
// test devuelve: un mock `chain` que ignora `where` deja vivo el mutante «quitar la condición del
// COUNT». Aquí cada `select`/`selectDistinct`/`update`/`insert`/`delete` devuelve un chain thenable que
// registra sus `where` y resuelve a la siguiente respuesta de la cola (o `[]`).
import { and, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialecto = new PgDialect();

export interface Consulta { tipo: string; wheres: unknown[] }

export function crearCaptura() {
  const consultas: Consulta[] = [];
  const cola: unknown[][] = [];
  const METODOS = ['from', 'leftJoin', 'innerJoin', 'rightJoin', 'limit', 'offset', 'orderBy', 'groupBy', 'having',
    'values', 'returning', 'set', 'for', 'onConflictDoUpdate', 'onConflictDoNothing', '$dynamic', 'as'];
  const hacer = (tipo: string) => () => {
    const c: Consulta = { tipo, wheres: [] };
    consultas.push(c);
    const filas = cola.length ? cola.shift()! : [];
    const t: Record<string, unknown> = {};
    for (const m of METODOS) t[m] = () => t;
    t.where = (w: unknown) => { c.wheres.push(w); return t; };
    t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej);
    t.catch = (rej: (e: unknown) => unknown) => Promise.resolve(filas).catch(rej);
    return t;
  };
  const db = {
    select: hacer('select'), selectDistinct: hacer('selectDistinct'),
    update: hacer('update'), insert: hacer('insert'), delete: hacer('delete'),
    execute: async () => [],
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return {
    db,
    consultas,
    /** Encola la respuesta de la PRÓXIMA consulta (FIFO). */
    responder: (...respuestas: unknown[][]) => { cola.push(...respuestas); },
    reset: () => { consultas.length = 0; cola.length = 0; },
    /** SQL renderizado de cada `where` capturado (los `undefined` se omiten). */
    sqlDeWheres: (): { sql: string; params: unknown[] }[] => consultas.flatMap((c) => c.wheres)
      .filter((w): w is SQL => !!w && typeof w === 'object')
      .map((w) => { const q = dialecto.sqlToQuery(and(w as SQL)!); return { sql: q.sql, params: q.params as unknown[] }; }),
  };
}
