// HU #13310 (Feature #13309, Épica #12741, ADR-0021) — Migración 0221: el outbox del comprobante gana
// `destino` (flit1|flit2) y las columnas de FLIT 1. Calco de migracion-0219.test.ts.
// Se afirma «la anterior es 0220_» y NUNCA «la 0221 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima). Paridad de los CHECK nuevos con shared-types.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DESTINOS_ENVIO_COMPROBANTE, ESTADOS_ENVIO_FLIT1, ESTADOS_ENVIO_FLIT2 } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoImpuestoEnviosFlit2 } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0221_flito_impuesto_envios_destino_flit1.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0221 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0221.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const CHECKS_0221 = [
  'ck_flito_impuesto_envios_flit2_destino', 'ck_flito_impuesto_envios_flit2_flit1_cols',
  'ck_flito_impuesto_envios_flit2_flit1_estado', 'ck_flito_impuesto_envios_flit2_ultimo_paso',
];

const listaDe = (re: RegExp): string[] =>
  (SIN_COMENTARIOS.match(re)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

describe('0221 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0221)).toEqual([]);
    expect(SQL_0221).toMatch(/DO \$m0221\$/);
    expect(SQL_0221).toMatch(/END \$m0221\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQLS.filter((f) => f.startsWith('0221_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0220_ — nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0220_/);
  });

  it('cabecera: archivo, HU/Feature y autor', () => {
    const cabecera = SQL_0221.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13310/);
    expect(cabecera).toMatch(/Feature #13309/);
  });

  it('AC8 sin retroactivo: ni INSERT, UPDATE, DELETE ni DROP de tabla/columna; idempotente por IF NOT EXISTS', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b|\bBEGIN\s*;|\bCOMMIT\b|\bRENAME\b/);
    for (const col of ['destino', 'archivo_flit1_id', 'ultimo_paso']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col} `));
    }
    for (const ck of CHECKS_0221) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conname = '${ck}'\\)`));
    }
  });

  it('destino: NOT NULL con DEFAULT flit2 solo para rellenar las filas existentes, y el DEFAULT se retira', () => {
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS destino varchar\(10\) NOT NULL DEFAULT 'flit2';/);
    expect(SIN_COMENTARIOS).toMatch(/ALTER COLUMN destino DROP DEFAULT;/);
    expect(SIN_COMENTARIOS.indexOf('DROP DEFAULT')).toBeGreaterThan(SIN_COMENTARIOS.indexOf("DEFAULT 'flit2'"));
  });

  it('CHECK de semántica: FLIT 1 sin columnas ni estados de FLIT 2; FLIT 2 sin columnas de FLIT 1; paso 1-3', () => {
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(destino = 'flit2' OR \(\s*estado IN \([^)]*\)\s*AND sync_version_espera IS NULL AND en_espera_desde IS NULL\s*AND estado_flit2 IS NULL AND adjunto_id IS NULL\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(destino = 'flit1' OR \(archivo_flit1_id IS NULL AND ultimo_paso IS NULL\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(ultimo_paso IS NULL OR ultimo_paso BETWEEN 1 AND 3\)/);
  });

  it('paridad con shared-types: destinos y estados permitidos a FLIT 1 (subconjunto de los de FLIT 2, sin en_espera ni gestor)', () => {
    expect(listaDe(/CHECK \(destino IN \(([^)]*)\)\)/).sort()).toEqual([...DESTINOS_ENVIO_COMPROBANTE].sort());
    expect(listaDe(/flit1_estado[\s\S]*?estado IN \(([^)]*)\)/).sort()).toEqual([...ESTADOS_ENVIO_FLIT1].sort());
    expect(ESTADOS_ENVIO_FLIT1.every((e) => ESTADOS_ENVIO_FLIT2.includes(e))).toBe(true);
    expect(ESTADOS_ENVIO_FLIT1).not.toContain('en_espera');
    expect(ESTADOS_ENVIO_FLIT1).not.toContain('ya_cargado_gestor');
  });

  it('Drizzle refleja la migración: 3 columnas y 4 CHECK con los mismos nombres; tabla sin renombrar', () => {
    const t = getTableConfig(flitoImpuestoEnviosFlit2);
    expect(t.name).toBe('flito_impuesto_envios_flit2');
    const col = (n: string) => t.columns.find((c) => c.name === n);
    expect(col('destino')?.getSQLType()).toBe('varchar(10)');
    expect(col('destino')?.notNull).toBe(true);
    expect(col('destino')?.hasDefault).toBe(false);
    expect(col('archivo_flit1_id')?.getSQLType()).toBe('varchar(100)');
    expect(col('archivo_flit1_id')?.notNull).toBe(false);
    expect(col('ultimo_paso')?.getSQLType()).toBe('smallint');
    const nombres = t.checks.map((c) => c.name);
    for (const ck of CHECKS_0221) expect(nombres).toContain(ck);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0221 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe; los CHECK de destino muerden', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0221);
        await tx.unsafe(SQL_0221);
        const [imp] = await tx<{ id: string }[]>`SELECT id FROM flito_impuestos LIMIT 1`;
        if (imp) {
          await expect(tx.savepoint((sp) => sp`INSERT INTO flito_impuesto_envios_flit2 (impuesto_id, estado, destino) VALUES (${imp.id}, 'sin_comprobante', 'flit3')`))
            .rejects.toMatchObject({ code: '23514' });
          await expect(tx.savepoint((sp) => sp`INSERT INTO flito_impuesto_envios_flit2 (impuesto_id, estado, destino, archivo_flit1_id) VALUES (${imp.id}, 'sin_comprobante', 'flit2', 'x')`))
            .rejects.toMatchObject({ code: '23514' });
        }
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
