// `createdInRangeCondition` (shared/utils/fecha-rango.ts): el rango `[desde 00:00, hasta+1 00:00)` en días de Bogotá
// no depende de la zona horaria de la sesión de PostgreSQL (Épica #14590, mismo defecto que la Torre corrigió en #805
// con `condicionRango`). Con `${desde}::date AT TIME ZONE 'America/Bogota'` y la sesión en UTC, el límite inferior
// caía el día anterior a las 14:00 de Bogotá y se contaba de más esa tarde.
//
// Contra PostgreSQL real, en una transacción con ROLLBACK (la tabla es temporal y la zona va con `set_config(…, true)`
// ≡ `SET LOCAL`). Sin TEST_DATABASE_URL el bloque de base se salta; el caso del SQL renderizado corre siempre.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { createdInRangeCondition } from '../../src/shared/utils/fecha-rango.js';

const URL_BASE = process.env.TEST_DATABASE_URL;

const tmp = pgTable('tmp_fecha_rango', {
  id: integer('id').notNull(),
  en: timestamp('en', { withTimezone: true }).notNull(),
});

const RANGO = { desde: '2026-06-01', hasta: '2026-11-18' };

describe('createdInRangeCondition: forma del SQL (sin base)', () => {
  const render = (c: SQL | null) => new PgDialect().sqlToQuery(c!);

  it('el límite `desde` es `date::timestamp AT TIME ZONE` (medianoche de Bogotá en cualquier zona de sesión)', () => {
    const q = render(createdInRangeCondition(tmp.en, RANGO));
    expect(q.sql).toMatch(/"en" >= \(\$\d+::date::timestamp AT TIME ZONE \$\d+\)/);
    expect(q.sql).toMatch(/"en" < \(\(\$\d+::date \+ interval '1 day'\) AT TIME ZONE \$\d+\)/);
    expect(q.params).toEqual(['2026-06-01', 'America/Bogota', '2026-11-18', 'America/Bogota']);
  });

  it('un solo límite devuelve una sola condición; sin fechas, null', () => {
    expect(render(createdInRangeCondition(tmp.en, { desde: '2026-06-01', hasta: null })).sql)
      .toMatch(/^"tmp_fecha_rango"\."en" >= \(\$1::date::timestamp AT TIME ZONE \$2\)$/);
    expect(createdInRangeCondition(tmp.en, { desde: null, hasta: null })).toBeNull();
  });
});

describe.skipIf(!URL_BASE)('createdInRangeCondition contra PostgreSQL: no depende de la zona de la sesión (tx con ROLLBACK)', () => {
  let base: postgres.Sql | null = null;
  let tx: postgres.ReservedSql | null = null;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    base ??= postgres(URL_BASE!, { max: 1, onnotice: () => {} });
    tx = await base.reserve();
    await tx`BEGIN`;
    Object.assign(tx, { options: base.options });
    db = drizzle(tx as unknown as postgres.Sql);
    await tx`CREATE TEMP TABLE tmp_fecha_rango (id int NOT NULL, en timestamptz NOT NULL) ON COMMIT DROP`;
    await tx`INSERT INTO tmp_fecha_rango (id, en) VALUES
      (1, '2026-06-01T01:00:00Z'),  -- 31-may 20:00 Bogotá → fuera
      (2, '2026-06-01T05:00:00Z'),  -- 1-jun 00:00 Bogotá → dentro (borde)
      (3, '2026-11-19T04:59:00Z'),  -- 18-nov 23:59 Bogotá → dentro
      (4, '2026-11-19T05:00:00Z')   -- 19-nov 00:00 Bogotá → fuera (borde)`;
  });
  afterEach(async () => {
    if (tx) { await tx`ROLLBACK`; tx.release(); }
    tx = null;
  });
  afterAll(async () => { await base?.end(); base = null; });

  const ids = async (cond: SQL | null): Promise<number[]> =>
    (await db.select({ id: tmp.id }).from(tmp).where(cond ?? sql`true`).orderBy(tmp.id)).map((r) => r.id);

  for (const zona of ['UTC', 'America/Bogota']) {
    it(`sesión en ${zona}: deja fuera 31-may 20:00 y 19-nov 00:00 de Bogotá; dentro 1-jun 00:00 y 18-nov 23:59`, async () => {
      await tx!`SELECT set_config('TimeZone', ${zona}, true)`;
      expect(await ids(createdInRangeCondition(tmp.en, RANGO))).toEqual([2, 3]);
      expect(await ids(createdInRangeCondition(tmp.en, { desde: RANGO.desde, hasta: null }))).toEqual([2, 3, 4]);
      expect(await ids(createdInRangeCondition(tmp.en, { desde: null, hasta: RANGO.hasta }))).toEqual([1, 2, 3]);
    });
  }
});
