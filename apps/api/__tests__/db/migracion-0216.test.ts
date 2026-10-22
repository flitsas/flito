// HU #13094 (Feature #13059, Épica #12736) — Migración 0216: marca de PII enmascarada de FLIT 2 en
// `flito_tramites` (+ índice parcial) y, en la posición de lectura, `pii_enmascarada_desde` y el cursor
// de la relectura de recuperación. Calco de migracion-0215.test.ts.
//
// Se afirma «la anterior es 0215_» y NUNCA «la 0216 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoSyncFlit2Lectura, flitoTramites } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0216_flit2_pii_enmascarada.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0216 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0216.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe('0216 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0216)).toEqual([]);
    expect(SQL_0216).toMatch(/DO \$ck0216\$[\s\S]*END \$ck0216\$;/);
    expect(SQL_0216).toMatch(/DO \$resumen0216\$[\s\S]*END \$resumen0216\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQLS.filter((f) => f.startsWith('0216_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0215_ — nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0215_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0216.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13094/);
    expect(cabecera).toMatch(/Feature #13059/);
  });

  it('idempotente y aditiva: columnas e índice con IF NOT EXISTS, CHECK guardado por pg_constraint, sin borrar ni reescribir', () => {
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS flit2_pii_enmascarada boolean NOT NULL DEFAULT false;/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_flito_tramites_flit2_pii_enmascarada\s+ON flito_tramites \(id\) WHERE flit2_pii_enmascarada;/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS pii_enmascarada_desde timestamptz NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS cursor_relectura\s+text\s+NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(cursor_relectura IS NULL OR length\(cursor_relectura\) BETWEEN 1 AND 2000\)/);
    expect((SIN_COMENTARIOS.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? [])).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b|\bINSERT\b/);
  });

  it('Drizzle refleja la migración: columna con default false, índice parcial, columnas y CHECK de la lectura', () => {
    const t = getTableConfig(flitoTramites);
    const col = t.columns.find((c) => c.name === 'flit2_pii_enmascarada');
    expect(col?.getSQLType()).toBe('boolean');
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe(false);
    const idx = t.indexes.find((i) => i.config.name === 'idx_flito_tramites_flit2_pii_enmascarada');
    expect(idx?.config.where).toBeDefined();
    const l = getTableConfig(flitoSyncFlit2Lectura);
    expect(l.columns.find((c) => c.name === 'pii_enmascarada_desde')?.getSQLType()).toBe('timestamp with time zone');
    expect(l.columns.find((c) => c.name === 'cursor_relectura')?.getSQLType()).toBe('text');
    expect(l.checks.map((c) => c.name)).toContain('ck_flito_sync_flit2_lectura_cursor_relectura_len');
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0216 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe; la marca nace en false; el CHECK del cursor de relectura rechaza el vacío', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0216);
        await tx.unsafe(SQL_0216);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM flito_tramites WHERE flit2_pii_enmascarada IS NULL`;
        expect(f!.n).toBe(0);
        await expect(tx.savepoint((sp) => sp`UPDATE flito_sync_flit2_lectura SET cursor_relectura = '' WHERE id = 1`))
          .rejects.toMatchObject({ code: '23514' });
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
