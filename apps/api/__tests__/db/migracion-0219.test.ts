// HU #13268 (Feature #13267, Épica #12741) — Migración 0219: outbox `flito_impuesto_envios_flit2`.
// Calco de migracion-0215.test.ts. Se afirma «la anterior es 0218_» y NUNCA «la 0219 es la última»
// (memoria: test-de-migracion-no-exigir-es-la-ultima). Paridad del CHECK de estados con
// `EstadoEnvioFlit2` de shared-types (diseño §9).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ESTADOS_ENVIO_FLIT2, EstadoEnvioFlit2 } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoImpuestoEnviosFlit2 } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0219_flito_impuesto_envios_flit2.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0219 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0219.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

const estadosDelCheck = (): string[] => {
  const m = SIN_COMENTARIOS.match(/ck_flito_impuesto_envios_flit2_estado\s+CHECK \(estado IN \(([^)]*)\)\)/);
  return (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
};

describe('0219 — análisis estático', () => {
  it('sin BEGIN/COMMIT; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0219)).toEqual([]);
    expect(SQLS.filter((f) => f.startsWith('0219_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0218_ — nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0218_/);
  });

  it('cabecera: archivo, HU/Feature y autor', () => {
    const cabecera = SQL_0219.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13268/);
    expect(cabecera).toMatch(/Feature #13267/);
  });

  it('idempotente y sin backfill (AC3): IF NOT EXISTS en tabla e índices; ni INSERT, UPDATE, DELETE ni DROP', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_impuesto_envios_flit2 \(/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_impuesto_envios_flit2_impuesto\s+ON flito_impuesto_envios_flit2 \(impuesto_id\);/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_flito_impuesto_envios_flit2_cola\s+ON flito_impuesto_envios_flit2 \(estado, proximo_intento_en\)\s+WHERE estado IN \('pendiente','en_espera'\);/);
    // `ON DELETE CASCADE` de la FK no es una sentencia: se excluye del barrido.
    expect(SIN_COMENTARIOS.replace(/ON DELETE CASCADE/g, '')).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bBEGIN\b|\bCOMMIT\b/);
  });

  it('FK a flito_impuestos con cascade; soporte_id sin FK; CHECKs de soporte, espera bicondicional e intentos', () => {
    expect(SIN_COMENTARIOS).toMatch(/impuesto_id\s+uuid\s+NOT NULL REFERENCES flito_impuestos\(id\) ON DELETE CASCADE/);
    expect(SIN_COMENTARIOS).toMatch(/soporte_id\s+uuid\s+NULL,/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(\(estado = 'sin_comprobante'\) = \(soporte_id IS NULL\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(\(estado = 'en_espera'\) = \(sync_version_espera IS NOT NULL AND en_espera_desde IS NOT NULL\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(intentos BETWEEN 0 AND 10\)/);
  });

  it('paridad: el CHECK de estados lista exactamente los seis de EstadoEnvioFlit2', () => {
    expect(estadosDelCheck().sort()).toEqual([...ESTADOS_ENVIO_FLIT2].sort());
    expect(ESTADOS_ENVIO_FLIT2).toHaveLength(6);
    expect(ESTADOS_ENVIO_FLIT2).toContain(EstadoEnvioFlit2.EN_ESPERA);
  });

  it('Drizzle refleja la migración: columnas, índices y CHECKs', () => {
    const t = getTableConfig(flitoImpuestoEnviosFlit2);
    expect(t.name).toBe('flito_impuesto_envios_flit2');
    const columnasSql = [...SIN_COMENTARIOS.matchAll(/^\s{2}([a-z_0-9]+)\s+(uuid|varchar|smallint|timestamptz|bigint|boolean|integer)/gm)].map((m) => m[1]).sort();
    expect(t.columns.map((c) => c.name).sort()).toEqual(columnasSql);
    expect(t.columns.find((c) => c.name === 'sync_version_espera')?.getSQLType()).toBe('bigint');
    expect(t.indexes.map((i) => i.config.name).sort()).toEqual(['idx_flito_impuesto_envios_flit2_cola', 'uq_flito_impuesto_envios_flit2_impuesto']);
    expect(t.checks.map((c) => c.name).sort()).toEqual([
      'ck_flito_impuesto_envios_flit2_espera', 'ck_flito_impuesto_envios_flit2_estado',
      'ck_flito_impuesto_envios_flit2_intentos', 'ck_flito_impuesto_envios_flit2_soporte',
    ]);
    expect(t.foreignKeys).toHaveLength(1);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0219 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe; el CHECK de espera y el de soporte muerden', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0219);
        await tx.unsafe(SQL_0219);
        const [imp] = await tx<{ id: string }[]>`SELECT id FROM flito_impuestos LIMIT 1`;
        if (imp) {
          await expect(tx.savepoint((sp) => sp`INSERT INTO flito_impuesto_envios_flit2 (impuesto_id, estado, soporte_id) VALUES (${imp.id}, 'en_espera', gen_random_uuid())`))
            .rejects.toMatchObject({ code: '23514' });
          await expect(tx.savepoint((sp) => sp`INSERT INTO flito_impuesto_envios_flit2 (impuesto_id, estado) VALUES (${imp.id}, 'pendiente')`))
            .rejects.toMatchObject({ code: '23514' });
        }
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
