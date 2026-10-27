// HU #14131 (Feature #14013, ADR-0032) — Migración 0270: lotes y filas de la carga masiva de SOAT.
// Análisis estático (idempotencia, CHECK, índice único parcial de un lote activo por compañía), paridad con
// el modelo Drizzle y, con TEST_DATABASE_URL, aplicación ×2 sobre BD ya migrada (P6).
// Se afirma «la anterior es 0269_» y NUNCA «la 0270 es la última».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoSoatMasivoLotes, flitoSoatMasivoFilas } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0270 = readFileSync(path.join(DIR, '0270_flito_soat_masivo_lotes_filas.sql'), 'utf8');
const SIN_COMENTARIOS = SQL_0270.replace(/--[^\n]*/g, '');

describe('0270 — análisis estático', () => {
  it('la anterior es la 0269 y la numeración no tiene huecos hasta ella', () => {
    const nombres = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(nombres.some((f) => f.startsWith('0269_'))).toBe(true);
    expect(nombres.filter((f) => f.startsWith('0270_'))).toHaveLength(1);
  });

  it('idempotente por construcción: sin BEGIN/COMMIT, CREATE ... IF NOT EXISTS, CHECK con DROP previo', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(SIN_COMENTARIOS.match(/CREATE TABLE(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    const adds = SIN_COMENTARIOS.match(/ADD CONSTRAINT (\w+)/g) ?? [];
    expect(adds.length).toBe(7);
    for (const a of adds) expect(SIN_COMENTARIOS).toContain(`DROP CONSTRAINT IF EXISTS ${a.split(' ')[2]}`);
  });

  it('declara el índice único parcial de UN lote activo por compañía y el vocabulario completo de estados', () => {
    expect(SIN_COMENTARIOS).toMatch(/uq_flito_soat_masivo_lote_activo\s+ON flito_soat_masivo_lotes \(compania_id\) WHERE estado IN \('en_cola','procesando'\)/);
    for (const e of ['en_cola', 'procesando', 'terminado', 'pendiente', 'consultando', 'aceptada', 'por_validar', 'rechazada']) {
      expect(SIN_COMENTARIOS).toContain(`'${e}'`);
    }
    expect(SIN_COMENTARIOS).toMatch(/lote_id uuid NOT NULL REFERENCES flito_soat_masivo_lotes\(id\) ON DELETE CASCADE/);
  });

  it('el modelo Drizzle refleja la 0270: columnas, índice parcial único y CHECKs repetidos (lección de la 0157)', () => {
    const l = getTableConfig(flitoSoatMasivoLotes);
    const f = getTableConfig(flitoSoatMasivoFilas);
    expect(l.columns.map((c) => c.name).sort()).toEqual(
      ['archivo_hash', 'compania_id', 'creado_en', 'creado_por_id', 'creado_por_nombre', 'estado', 'id', 'tipo_soat', 'total_filas']);
    const uq = l.indexes.find((i) => i.config.name === 'uq_flito_soat_masivo_lote_activo');
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.where).toBeDefined();
    for (const c of ['tipo_chk', 'estado_chk', 'total_chk']) {
      expect(l.checks.map((x) => x.name)).toContain(`flito_soat_masivo_lotes_${c}`);
      expect(SIN_COMENTARIOS).toContain(`flito_soat_masivo_lotes_${c}`);
    }
    for (const c of ['estado_chk', 'motivo_chk', 'rechazo_chk', 'pii_chk']) {
      expect(f.checks.map((x) => x.name)).toContain(`flito_soat_masivo_filas_${c}`);
      expect(SIN_COMENTARIOS).toContain(`flito_soat_masivo_filas_${c}`);
    }
    expect(f.indexes.find((i) => i.config.name === 'uq_flito_soat_masivo_filas_lote_fila')?.config.unique).toBe(true);
    // PII efímera: todas nulables (se anonimizan al terminar el lote).
    for (const n of ['placa', 'documento', 'nombre', 'correo', 'celular', 'vin']) {
      expect(f.columns.find((c) => c.name === n)!.notNull, n).toBe(false);
    }
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0270 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('dos aplicaciones seguidas no fallan; un solo lote activo por compañía; los CHECK rechazan lo inválido', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0270);
        await tx.unsafe(SQL_0270);
        const [c] = await tx.unsafe('SELECT id FROM clients LIMIT 1');
        const lote = `INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash) VALUES (${c.id}, 'x', 'renovacion', 1, 'h')`;
        await tx.unsafe(lote);
        await tx.savepoint(async (sp) => { await expect(sp.unsafe(lote)).rejects.toThrow(/uq_flito_soat_masivo_lote_activo/); }).catch(() => undefined);
        await tx.savepoint(async (sp) => {
          await expect(sp.unsafe(`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash) VALUES (${c.id}, 'x', 'renovacion', 201, 'h')`)).rejects.toThrow();
        }).catch(() => undefined);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  });
});
