// HU #13629 (Feature #13612, Épica #13576) — Migración 0242: marcas de la lectura automática de FLIT 1
// (`ultima_corrida_en`, `nocturna_buena_dia`) en la fila única de la 0241. Calco de migracion-0241.test.ts.
//
// Se afirma «la anterior es 0241_» y NUNCA «la 0242 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { funcionesDeSql, repartoDeSql } from '../helpers/permisos-seed-sql.js';
import { flitoSyncFlit1Lectura } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0242_flito_sync_flit1_lectura_marcas.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0242 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0242.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe('0242 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; sin unaccent(); número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0242)).toEqual([]);
    expect(SQL_0242).toMatch(/DO \$resumen0242\$/);
    expect(SQL_0242).toMatch(/END \$resumen0242\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SQLS.filter((f) => f.startsWith('0242_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0241_; nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0241_/);
  });

  it('cabecera: archivo, HU/Feature y autor', () => {
    const cabecera = SQL_0242.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13629/);
    expect(cabecera).toMatch(/Feature #13612/);
  });

  it('sin literales de rol ni filas de permisos', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_/);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo/);
    expect(funcionesDeSql([SQL_0242]).size).toBe(0);
    expect(repartoDeSql([SQL_0242]).size).toBe(0);
  });

  it('dos ADD COLUMN IF NOT EXISTS nullables y nada destructivo', () => {
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_sync_flit1_lectura ADD COLUMN IF NOT EXISTS ultima_corrida_en\s+timestamptz NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_sync_flit1_lectura ADD COLUMN IF NOT EXISTS nocturna_buena_dia\s+date\s+NULL;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b|\bINSERT\b|NOT NULL|DEFAULT/);
  });

  it('el esquema Drizzle declara las dos columnas con su tipo', () => {
    const cols = getTableConfig(flitoSyncFlit1Lectura).columns;
    const corrida = cols.find((c) => c.name === 'ultima_corrida_en');
    const dia = cols.find((c) => c.name === 'nocturna_buena_dia');
    expect(corrida?.getSQLType()).toBe('timestamp with time zone');
    expect(corrida?.notNull).toBe(false);
    expect(dia?.getSQLType()).toBe('date');
    expect(dia?.notNull).toBe(false);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0242 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('la segunda pasada no falla ni pisa las marcas guardadas', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0242);
        await tx`UPDATE flito_sync_flit1_lectura SET nocturna_buena_dia = '2026-10-16' WHERE id = 1`;
        await tx.unsafe(SQL_0242);
        const [f] = await tx<{ d: string }[]>`SELECT nocturna_buena_dia::text AS d FROM flito_sync_flit1_lectura WHERE id = 1`;
        expect(f.d).toBe('2026-10-16');
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
