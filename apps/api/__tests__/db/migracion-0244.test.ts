// HU #13632 (Feature #13613, Épica #13576) — Migración 0244: marcas de los avisos firmados de FLIT 2
// (`ultimo_aviso_en`, `rechazos_firma_seguidos` + CHECK) en la fila única de `flito_sync_flit2_lectura`.
// Calco de migracion-0242.test.ts. Se afirma «la anterior es 0242_ o 0243_» y NUNCA «la 0244 es la última».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { funcionesDeSql, repartoDeSql } from '../helpers/permisos-seed-sql.js';
import { flitoSyncFlit2Lectura } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0244_flito_sync_flit2_avisos.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0244 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0244.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe('0244 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; sin unaccent(); número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0244)).toEqual([]);
    expect(SQL_0244).toMatch(/DO \$check0244\$/);
    expect(SQL_0244).toMatch(/END \$check0244\$;/);
    expect(SQL_0244).toMatch(/DO \$resumen0244\$/);
    expect(SQL_0244).toMatch(/END \$resumen0244\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SQLS.filter((f) => f.startsWith('0244_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0242_ o la 0243_ (HU #13631, sin mergear aún); nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^024[23]_/);
  });

  it('cabecera: archivo, HU/Feature y autor', () => {
    const cabecera = SQL_0244.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13632/);
    expect(cabecera).toMatch(/Feature #13613/);
  });

  it('sin literales de rol ni filas de permisos', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_/);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo/);
    expect(funcionesDeSql([SQL_0244]).size).toBe(0);
    expect(repartoDeSql([SQL_0244]).size).toBe(0);
  });

  it('dos ADD COLUMN IF NOT EXISTS, CHECK condicionado y nada destructivo', () => {
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS ultimo_aviso_en\s+timestamptz NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_sync_flit2_lectura ADD COLUMN IF NOT EXISTS rechazos_firma_seguidos integer\s+NOT NULL DEFAULT 0;/);
    expect(SIN_COMENTARIOS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'ck_flito_sync_flit2_lectura_rechazos_firma'\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(rechazos_firma_seguidos >= 0\)/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b|\bINSERT\b/);
  });

  it('el esquema Drizzle declara las dos columnas y el CHECK', () => {
    const cfg = getTableConfig(flitoSyncFlit2Lectura);
    const aviso = cfg.columns.find((c) => c.name === 'ultimo_aviso_en');
    const rechazos = cfg.columns.find((c) => c.name === 'rechazos_firma_seguidos');
    expect(aviso?.getSQLType()).toBe('timestamp with time zone');
    expect(aviso?.notNull).toBe(false);
    expect(rechazos?.getSQLType()).toBe('integer');
    expect(rechazos?.notNull).toBe(true);
    expect(rechazos?.default).toBe(0);
    expect(cfg.checks.map((c) => c.name)).toContain('ck_flito_sync_flit2_lectura_rechazos_firma');
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0244 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('la segunda pasada no falla ni pisa las marcas; el CHECK rechaza negativos', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0244);
        await tx`UPDATE flito_sync_flit2_lectura SET rechazos_firma_seguidos = 7 WHERE id = 1`;
        await tx.unsafe(SQL_0244);
        const [f] = await tx<{ n: number }[]>`SELECT rechazos_firma_seguidos AS n FROM flito_sync_flit2_lectura WHERE id = 1`;
        expect(f.n).toBe(7);
        await tx`SAVEPOINT neg`;
        await expect(tx`UPDATE flito_sync_flit2_lectura SET rechazos_firma_seguidos = -1 WHERE id = 1`).rejects.toThrow(/ck_flito_sync_flit2_lectura_rechazos_firma/);
        await tx`ROLLBACK TO SAVEPOINT neg`;
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
