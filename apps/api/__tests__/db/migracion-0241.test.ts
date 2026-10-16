// HU #13628 (Feature #13612, Épica #13576) — Migración 0241: tabla de una fila `flito_sync_flit1_lectura`
// (parámetros de la lectura automática de FLIT 1 + estado de la lectura de la #13629). Sin siembra de
// permisos ni literales de rol. Calco de migracion-0217.test.ts.
//
// Se afirma «la anterior es 0240_» y NUNCA «la 0241 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima): una migración posterior no debe poner este test en rojo.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DEFAULTS_PARAMETROS_LECTURA_FLIT1, LIMITES_PARAMETROS_LECTURA_FLIT1 } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { funcionesDeSql, repartoDeSql } from '../helpers/permisos-seed-sql.js';
import { flitoSyncFlit1Lectura } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0241_flito_sync_flit1_lectura.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0241 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0241.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

const CHECKS = [
  'ck_flito_sync_flit1_lectura_una_fila',
  'ck_flito_sync_flit1_lectura_frecuencia',
  'ck_flito_sync_flit1_lectura_ventana',
  'ck_flito_sync_flit1_lectura_nocturna',
  'ck_flito_sync_flit1_lectura_nocturna_ge_ventana',
  'ck_flito_sync_flit1_lectura_fallo_par',
  'ck_flito_sync_flit1_lectura_fallo_codigo',
];

describe('0241 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; sin unaccent(); número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0241)).toEqual([]);
    expect(SQL_0241).toMatch(/DO \$resumen0241\$/);
    expect(SQL_0241).toMatch(/END \$resumen0241\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SQLS.filter((f) => f.startsWith('0241_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0240_; nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0240_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0241.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13628/);
    expect(cabecera).toMatch(/Feature #13612/);
  });

  it('sin literales de rol ni filas de permisos (la 0227 tumbó DEV por FK a permisos_roles)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_/);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo/);
    expect(funcionesDeSql([SQL_0241]).size).toBe(0);
    expect(repartoDeSql([SQL_0241]).size).toBe(0);
  });

  it('crea la tabla del diseño con defaults iguales a las constantes compartidas', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_sync_flit1_lectura \(/);
    const d = DEFAULTS_PARAMETROS_LECTURA_FLIT1;
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+frecuencia_minutos\\s+smallint\\s+NOT NULL DEFAULT ${d.frecuenciaMinutos},`));
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+ventana_dias\\s+smallint\\s+NOT NULL DEFAULT ${d.ventanaDias},`));
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+ventana_nocturna_dias\\s+smallint\\s+NOT NULL DEFAULT ${d.ventanaNocturnaDias},`));
    expect(SIN_COMENTARIOS).toMatch(/\n\s+arranque\s+date\s+NULL,/);
    expect(SIN_COMENTARIOS).toMatch(/\n\s+parametros_actualizados_por\s+integer\s+NULL REFERENCES users\(id\),/);
  });

  it('paridad constante ↔ CHECK: los rangos de la base son los de LIMITES_PARAMETROS_LECTURA_FLIT1', () => {
    const l = LIMITES_PARAMETROS_LECTURA_FLIT1;
    expect(SIN_COMENTARIOS).toContain(`CHECK (frecuencia_minutos BETWEEN ${l.frecuenciaMinutos.min} AND ${l.frecuenciaMinutos.max})`);
    expect(SIN_COMENTARIOS).toContain(`CHECK (ventana_dias BETWEEN ${l.ventanaDias.min} AND ${l.ventanaDias.max})`);
    expect(SIN_COMENTARIOS).toContain(`CHECK (ventana_nocturna_dias BETWEEN ${l.ventanaNocturnaDias.min} AND ${l.ventanaNocturnaDias.max})`);
    expect(SIN_COMENTARIOS).toContain('CHECK (ventana_nocturna_dias >= ventana_dias)');
    expect(SIN_COMENTARIOS).toContain('CHECK (id = 1)');
  });

  it('el esquema Drizzle declara las mismas columnas y los mismos CHECK', () => {
    const cfg = getTableConfig(flitoSyncFlit1Lectura);
    expect(cfg.name).toBe('flito_sync_flit1_lectura');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([
      'arranque', 'frecuencia_minutos', 'id', 'parametros_actualizados_en', 'parametros_actualizados_por',
      'proxima_prevista_en', 'ultima_buena_en', 'ultimo_fallo_codigo', 'ultimo_fallo_en', 'ventana_dias', 'ventana_nocturna_dias',
    ]);
    expect(cfg.columns.find((c) => c.name === 'id')!.primary).toBe(true);
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([...CHECKS].sort());
    for (const nombre of CHECKS) expect(SIN_COMENTARIOS).toContain(`CONSTRAINT ${nombre} `);
    expect(cfg.foreignKeys).toHaveLength(1);
  });

  it('siembra la fila única con ON CONFLICT DO NOTHING (la 2a pasada no pisa lo guardado) y nada destructivo', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO flito_sync_flit1_lectura \(id\) VALUES \(1\) ON CONFLICT \(id\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bUPDATE\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n <> 1 THEN RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0241 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('la segunda pasada no duplica ni pisa lo guardado; los CHECK rechazan rangos y PII en el fallo', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0241);
        await tx`UPDATE flito_sync_flit1_lectura SET frecuencia_minutos = 5, arranque = '2026-09-01' WHERE id = 1`;
        await tx.unsafe(SQL_0241);
        const filas = await tx<{ id: number; frecuencia_minutos: number }[]>`SELECT id, frecuencia_minutos FROM flito_sync_flit1_lectura`;
        expect(filas).toEqual([{ id: 1, frecuencia_minutos: 5 }]);
        const malos: ((sp: postgres.TransactionSql) => Promise<unknown>)[] = [
          (sp) => sp`UPDATE flito_sync_flit1_lectura SET frecuencia_minutos = 61 WHERE id = 1`,
          (sp) => sp`UPDATE flito_sync_flit1_lectura SET ventana_dias = 30, ventana_nocturna_dias = 7 WHERE id = 1`,
          (sp) => sp`UPDATE flito_sync_flit1_lectura SET ultimo_fallo_en = now(), ultimo_fallo_codigo = 'Juan Pérez 1234' WHERE id = 1`,
          (sp) => sp`INSERT INTO flito_sync_flit1_lectura (id) VALUES (2)`,
        ];
        for (const malo of malos) {
          await expect(tx.savepoint((sp) => malo(sp))).rejects.toMatchObject({ code: '23514' });
        }
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
