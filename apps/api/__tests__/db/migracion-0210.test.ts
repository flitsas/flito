// HU #12996 (Feature #12841, Épica #12616) — Migración 0210: tabla de espera `flito_soat_incompletas`
// (ADR-0019 opción A), índice único parcial por VIN abierto, columna `flito_compradores.soat_incompleta_id`
// y el CHECK de padre ampliado a «trámite XOR (SOAT o incompleta)». Calco de migracion-0209.test.ts.
//
// Se afirma «la anterior es 0209_» y NUNCA «la 0210 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoCompradores, flitoSoatIncompletas } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0210_flito_soat_incompletas.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0210 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0210.replace(/--[^\n]*/g, '');
const plano = (s: string) => s.replace(/\s+/g, ' ').trim();

const CHECKS_INCOMPLETAS = [
  'flito_soat_incompletas_estado_chk',
  'flito_soat_incompletas_motivo_chk',
  'flito_soat_incompletas_causa_chk',
  'flito_soat_incompletas_intentos_chk',
  'flito_soat_incompletas_descarte_chk',
  'flito_soat_incompletas_completada_chk',
];

describe('0210 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetados; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0210)).toEqual([]);
    expect(SQL_0210).toMatch(/DO \$padre_0210\$/);
    expect(SQL_0210).toMatch(/END \$padre_0210\$;/);
    expect(SQL_0210).toMatch(/DO \$verifica_0210\$/);
    expect(SQL_0210).toMatch(/END \$verifica_0210\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0210_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0209_ — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0209_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0210.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #12996/);
    expect(cabecera).toMatch(/Feature #12841/);
  });

  it('idempotente: IF NOT EXISTS en tabla, índices y columna; los seis CHECK de la tabla', () => {
    const s = plano(SIN_COMENTARIOS);
    expect(s).toContain('CREATE TABLE IF NOT EXISTS flito_soat_incompletas (');
    expect(s).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_incompletas_vin_abierta ON flito_soat_incompletas (vin) WHERE estado = 'incompleta';");
    expect(s).toContain('CREATE INDEX IF NOT EXISTS idx_flito_soat_incompletas_compania_estado ON flito_soat_incompletas (compania_id, estado);');
    expect(s).toContain('ADD COLUMN IF NOT EXISTS soat_incompleta_id uuid REFERENCES flito_soat_incompletas(id);');
    expect(s).toContain('CHECK ((tramite_id IS NOT NULL) <> (soat_id IS NOT NULL OR soat_incompleta_id IS NOT NULL))');
    for (const chk of CHECKS_INCOMPLETAS) expect(s).toContain(`CONSTRAINT ${chk}`);
    expect(SIN_COMENTARIOS.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS.match(/CREATE TABLE(?! IF NOT EXISTS)/g)).toBeNull();
  });

  it('el DO final verifica tabla, índice parcial, columna y el CHECK de padre (RAISE EXCEPTION)', () => {
    const verifica = SQL_0210.slice(SQL_0210.indexOf('DO $verifica_0210$'));
    expect(verifica).toContain("to_regclass('public.flito_soat_incompletas')");
    expect(verifica).toContain("indexname = 'uq_flito_soat_incompletas_vin_abierta'");
    expect(verifica).toContain("column_name = 'soat_incompleta_id'");
    expect(verifica).toContain("conname = 'flito_compradores_padre_chk'");
    expect(verifica.match(/RAISE EXCEPTION/g)).toHaveLength(4);
  });

  it('el modelo Drizzle refleja la 0210: tabla, CHECK (lección 0157), índice parcial y la columna nueva', () => {
    const cfg = getTableConfig(flitoSoatIncompletas);
    expect(cfg.name).toBe('flito_soat_incompletas');
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([...CHECKS_INCOMPLETAS].sort());
    const uq = cfg.indexes.find((i) => i.config.name === 'uq_flito_soat_incompletas_vin_abierta');
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.where).toBeDefined();

    const comp = getTableConfig(flitoCompradores);
    expect(comp.columns.map((c) => c.name)).toContain('soat_incompleta_id');
    expect(comp.checks.map((c) => c.name)).toContain('flito_compradores_padre_chk');
    expect(comp.indexes.map((i) => i.config.name)).toContain('idx_flito_compradores_soat_incompleta');
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0210 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe ni duplica: 1 columna, 1 CHECK de padre, los seis CHECK de la tabla', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0210);
      await tx.unsafe(SQL_0210);
      const cols = await tx`SELECT 1 FROM information_schema.columns WHERE table_name = 'flito_compradores' AND column_name = 'soat_incompleta_id'`;
      expect(cols).toHaveLength(1);
      const [padre] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'flito_compradores_padre_chk'`;
      expect(padre!.n).toBe(1);
      const [chk] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'flito_soat_incompletas'::regclass AND contype = 'c'`;
      expect(chk!.n).toBe(CHECKS_INCOMPLETAS.length);
    });
  }, 60_000);
});
