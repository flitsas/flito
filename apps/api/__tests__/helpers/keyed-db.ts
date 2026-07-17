// OPS-02b — Mock de drizzle KEYED por nombre de tabla (anti-flake).
//
// Problema: los tests encolaban respuestas con `selectMock.mockReturnValueOnce(...)`
// en el ORDEN exacto en que el handler emite los SELECT. Cuando un handler corre
// varias queries en `Promise.all` (orden no garantizado conceptualmente) o cambia
// el orden tras un refactor, las respuestas se desalinean → flake silencioso.
//
// Solución: enrutar `db.select/insert/update/delete` por NOMBRE DE TABLA
// (`getTableName`), no por orden de llamada. Cada test registra respuestas por
// tabla/escenario y el orden deja de importar.
//
// Híbrido / drop-in: `kdb.select` (etc.) SON vi.fn, así que el patrón posicional
// `kdb.select.mockReturnValueOnce(chain([...]))` SIGUE funcionando (precede a la
// implementación por defecto). El registro keyed solo se usa cuando no hay valor
// `*Once` encolado. Migración incremental: un test a la vez, sin big-bang.
//
// CI sin red: igual que antes, no introduce IO real.

import { vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

type Rows = unknown[];
/** Filas, o una función (puede lanzar para simular fallo de query). */
export type Resolver = Rows | (() => Rows);

interface Registry {
  queue: Map<string, Resolver[]>; // FIFO por tabla (se consume primero)
  fallback: Map<string, Resolver>; // por defecto por tabla
}

const EMPTY: Rows = [];

function newRegistry(): Registry {
  return { queue: new Map(), fallback: new Map() };
}

function clearRegistry(r: Registry): void {
  r.queue.clear();
  r.fallback.clear();
}

function pushQueue(r: Registry, table: string, v: Resolver): void {
  const q = r.queue.get(table) ?? [];
  q.push(v);
  r.queue.set(table, q);
}

function resolve(reg: Registry, name: string): Rows {
  const q = reg.queue.get(name);
  if (q && q.length) { const r = q.shift()!; return typeof r === 'function' ? r() : r; }
  const f = reg.fallback.get(name);
  if (f !== undefined) return typeof f === 'function' ? f() : f;
  return EMPTY;
}

/** Nombre de la tabla drizzle; `__expr__` si no es una tabla (subquery/expresión). */
function safeName(tbl: unknown): string {
  try {
    const n = getTableName(tbl as never);
    return typeof n === 'string' && n ? n : '__expr__';
  } catch {
    return '__expr__';
  }
}

// Drizzle query builders son "thenable": cada método encadena y `await` resuelve
// al array final. Resolvemos PEREZOSAMENTE (en `.then`) para conocer la tabla
// capturada en `.from()` antes de devolver filas.
const CHAIN_PASSTHROUGH = [
  'where', 'leftJoin', 'rightJoin', 'innerJoin', 'fullJoin', 'limit', 'offset',
  'orderBy', 'groupBy', 'having', 'for', 'union', 'unionAll', 'intersect', 'except', '$dynamic',
] as const;

const MUTATION_PASSTHROUGH = [
  'values', 'set', 'where', 'from', 'returning', 'into',
  'onConflictDoUpdate', 'onConflictDoNothing',
] as const;

function selectChain(reg: Registry): Record<string, unknown> {
  let name = '__no_from__';
  const run = () => Promise.resolve().then(() => resolve(reg, name));
  const t: Record<string, unknown> = {};
  for (const m of CHAIN_PASSTHROUGH) t[m] = () => t;
  t.from = (tbl: unknown) => { if (tbl != null) name = safeName(tbl); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => run().catch(rej);
  t.finally = (cb: () => void) => run().finally(cb);
  return t;
}

function mutationChain(rowsFn: () => Rows): Record<string, unknown> {
  const run = () => Promise.resolve().then(rowsFn);
  const t: Record<string, unknown> = {};
  for (const m of MUTATION_PASSTHROUGH) t[m] = () => t;
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => run().catch(rej);
  t.finally = (cb: () => void) => run().finally(cb);
  return t;
}

export interface KeyedDb {
  /** Objeto `db` para inyectar en `vi.mock('../../src/db/client.js', () => ({ db: kdb.db, ... }))`. */
  db: Record<string, unknown>;
  // Las vi.fn subyacentes — exponen la API posicional (`.mockReturnValueOnce`, etc.).
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  /** Registro keyed por tabla (encadenable). */
  when: {
    select: (table: string, rows: Resolver) => KeyedDb['when'];
    selectOnce: (table: string, rows: Resolver) => KeyedDb['when'];
    selectThrow: (table: string, err: unknown) => KeyedDb['when'];
    /** Mapa tabla→filas en una sola llamada. */
    scenario: (map: Record<string, Resolver>) => KeyedDb['when'];
    insert: (table: string, rows: Resolver) => KeyedDb['when'];
    update: (table: string, rows: Resolver) => KeyedDb['when'];
    delete: (table: string, rows: Resolver) => KeyedDb['when'];
  };
  /** Resetea vi.fns + registro y reinstala los defaults keyed. Llamar en `beforeEach`. */
  reset: () => void;
}

/**
 * Crea un mock de `db` enrutado por tabla. Coexiste con el patrón posicional.
 *
 * @param opts.transaction  Implementación de `db.transaction`. Por defecto ejecuta
 *   el callback contra el MISMO `db` keyed (`cb(db)`), de modo que las queries
 *   dentro de la transacción también se enrutan por tabla.
 */
export function createKeyedDb(opts: { transaction?: 'keyed' | 'manual' } = {}): KeyedDb {
  const selectReg = newRegistry();
  const insertReg = newRegistry();
  const updateReg = newRegistry();
  const deleteReg = newRegistry();

  const select = vi.fn();
  const insert = vi.fn();
  const update = vi.fn();
  const del = vi.fn();
  const transaction = vi.fn();
  const execute = vi.fn();

  const db: Record<string, unknown> = { select, insert, update, delete: del, transaction, execute };

  function installDefaults() {
    select.mockImplementation(() => selectChain(selectReg));
    insert.mockImplementation((tbl: unknown) => mutationChain(() => resolve(insertReg, safeName(tbl))));
    update.mockImplementation((tbl: unknown) => mutationChain(() => resolve(updateReg, safeName(tbl))));
    del.mockImplementation((tbl: unknown) => mutationChain(() => resolve(deleteReg, safeName(tbl))));
    if (opts.transaction !== 'manual') {
      transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));
    }
    execute.mockResolvedValue([{ '?column?': 1 }]);
  }

  const when: KeyedDb['when'] = {
    select: (table, rows) => { selectReg.fallback.set(table, rows); return when; },
    selectOnce: (table, rows) => { pushQueue(selectReg, table, rows); return when; },
    selectThrow: (table, err) => { selectReg.fallback.set(table, () => { throw err; }); return when; },
    scenario: (map) => { for (const [t, rows] of Object.entries(map)) selectReg.fallback.set(t, rows); return when; },
    insert: (table, rows) => { insertReg.fallback.set(table, rows); return when; },
    update: (table, rows) => { updateReg.fallback.set(table, rows); return when; },
    delete: (table, rows) => { deleteReg.fallback.set(table, rows); return when; },
  };

  function reset() {
    select.mockReset(); insert.mockReset(); update.mockReset(); del.mockReset();
    transaction.mockReset(); execute.mockReset();
    [selectReg, insertReg, updateReg, deleteReg].forEach(clearRegistry);
    installDefaults();
  }

  installDefaults();
  return { db, select, insert, update, delete: del, transaction, execute, when, reset };
}
