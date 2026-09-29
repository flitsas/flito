// HU #13091 (Feature #13059, Épica #12736) — Migración 0215: `id_flit2`/`sync_version` en
// `flito_tramites` (índice único parcial + dos CHECK con `fuente`) y la posición de lectura del feed
// de FLIT 2 (`flito_sync_flit2_lectura`, una sola fila). Calco de migracion-0214.test.ts.
//
// Se afirma «la anterior es 0214_» y NUNCA «la 0215 es la última» (memoria:
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
const ARCHIVO = '0215_flit2_lectura_incremental.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0215 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0215.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe('0215 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0215)).toEqual([]);
    expect(SQL_0215).toMatch(/DO \$ck0215\$[\s\S]*END \$ck0215\$;/);
    expect(SQL_0215).toMatch(/DO \$resumen0215\$[\s\S]*END \$resumen0215\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQLS.filter((f) => f.startsWith('0215_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0214_ — nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0214_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0215.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13091/);
    expect(cabecera).toMatch(/Feature #13059/);
  });

  it('idempotente: columnas, índice y tabla con IF NOT EXISTS; CHECKs guardados por pg_constraint; siembra ON CONFLICT', () => {
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS id_flit2\s+uuid\s+NULL/);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS sync_version bigint NULL/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_tramites_id_flit2\s+ON flito_tramites \(id_flit2\) WHERE id_flit2 IS NOT NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(\(fuente = 'flit2'\) = \(id_flit2 IS NOT NULL\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(id_flit2 IS NULL OR sync_version IS NOT NULL\)/);
    expect((SIN_COMENTARIOS.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? [])).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_sync_flit2_lectura \(/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(id = 1\)/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO flito_sync_flit2_lectura \(id\) VALUES \(1\) ON CONFLICT \(id\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b/);
  });

  it('Drizzle refleja la migración: columnas, índice parcial, CHECKs y la tabla nueva', () => {
    const t = getTableConfig(flitoTramites);
    expect(t.columns.find((c) => c.name === 'id_flit2')?.getSQLType()).toBe('uuid');
    expect(t.columns.find((c) => c.name === 'sync_version')?.getSQLType()).toBe('bigint');
    expect(t.indexes.map((i) => i.config.name)).toContain('uq_flito_tramites_id_flit2');
    expect(t.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['ck_flito_tramites_fuente_id_flit2', 'ck_flito_tramites_flit2_sync_version']));
    const l = getTableConfig(flitoSyncFlit2Lectura);
    expect(l.name).toBe('flito_sync_flit2_lectura');
    // `pii_enmascarada_desde`, `cursor_relectura` y su CHECK los añade la 0216 (HU #13094).
    expect(l.columns.map((c) => c.name).sort()).toEqual([
      'atrasada', 'cursor', 'cursor_relectura', 'id', 'pii_enmascarada_desde', 'since_arranque', 'ultima_exitosa_en',
      'ultimo_error_codigo', 'ultimo_intento_en', 'updated_at',
    ]);
    expect(l.checks.map((c) => c.name).sort()).toEqual([
      'ck_flito_sync_flit2_lectura_cursor_len', 'ck_flito_sync_flit2_lectura_cursor_relectura_len', 'ck_flito_sync_flit2_lectura_una_fila',
    ]);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0215 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe; una sola fila de lectura; el CHECK ata fuente e id_flit2', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0215);
        await tx.unsafe(SQL_0215);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM flito_sync_flit2_lectura`;
        expect(f!.n).toBe(1);
        await expect(tx.savepoint((sp) => sp`INSERT INTO flito_sync_flit2_lectura (id) VALUES (2)`)).rejects.toMatchObject({ code: '23514' });
        await expect(tx.savepoint((sp) => sp`UPDATE flito_tramites SET fuente = 'flit2' WHERE id = (SELECT id FROM flito_tramites LIMIT 1)`))
          .rejects.toMatchObject({ code: '23514' });
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
