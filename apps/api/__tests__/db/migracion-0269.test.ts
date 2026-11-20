// HU #14018 (Feature #14012) — Migración 0269: `flito_soat_incompletas` crece para la renovación con RUNT caído.
// AC7: columnas tipo_soat / modalidad_consulta / placa / motivo_pendiente; vin y factura admiten NULL bajo CHECK;
// índice único parcial por placa abierta; idempotente (aplicable dos veces, P6).
// Se afirma «la anterior es 0268_» y NUNCA «la 0269 es la última».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoSoatIncompletas } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0269 = readFileSync(path.join(DIR, '0269_flito_soat_incompletas_renovacion.sql'), 'utf8');
const SIN_COMENTARIOS = SQL_0269.replace(/--[^\n]*/g, '');

describe('AC7 — 0269: análisis estático', () => {
  it('idempotente por construcción: sin BEGIN/COMMIT, ADD COLUMN / CREATE INDEX con IF NOT EXISTS, CHECK con DROP previo', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(SIN_COMENTARIOS.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    const adds = SIN_COMENTARIOS.match(/ADD CONSTRAINT (\w+)/g) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(7);
    for (const a of adds) {
      const nombre = a.split(' ')[2];
      expect(SIN_COMENTARIOS, `DROP previo de ${nombre}`).toContain(`DROP CONSTRAINT IF EXISTS ${nombre}`);
    }
  });

  it('declara las cuatro columnas, los motivos y el índice único parcial por placa abierta', () => {
    for (const col of ['tipo_soat', 'modalidad_consulta', 'placa', 'motivo_pendiente']) {
      expect(SIN_COMENTARIOS).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(SIN_COMENTARIOS).toContain('ALTER COLUMN vin DROP NOT NULL');
    for (const m of ['runt_sin_respuesta', 'falta_factura_venta', 'faltan_datos_propietario', 'sin_soat_anterior']) {
      expect(SIN_COMENTARIOS).toContain(`'${m}'`);
    }
    expect(SIN_COMENTARIOS).toContain('uq_flito_soat_incompletas_placa_abierta');
    expect(SIN_COMENTARIOS).toMatch(/WHERE estado = 'incompleta' AND placa IS NOT NULL/);
  });

  it('el modelo Drizzle refleja la 0269: columnas, nulabilidad, índice por placa y CHECKs', () => {
    const cfg = getTableConfig(flitoSoatIncompletas);
    const col = (n: string) => cfg.columns.find((c) => c.name === n)!;
    expect(col('vin').notNull).toBe(false);
    expect(col('placa').notNull).toBe(false);
    for (const n of ['tipo_soat', 'modalidad_consulta', 'motivo_pendiente']) expect(col(n).notNull).toBe(true);
    for (const n of ['factura_storage_key', 'factura_hash', 'factura_nombre_archivo', 'factura_content_type', 'factura_tamano_bytes']) {
      expect(col(n).notNull, n).toBe(false);
    }
    const uq = cfg.indexes.find((i) => i.config.name === 'uq_flito_soat_incompletas_placa_abierta');
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.where).toBeDefined();
    const checks = cfg.checks.map((c) => c.name);
    for (const c of ['modalidad_chk', 'factura_completa_chk', 'factura_inicial_chk', 'motivo_pendiente_chk']) {
      expect(checks).toContain(`flito_soat_incompletas_${c}`);
      expect(SIN_COMENTARIOS).toContain(`flito_soat_incompletas_${c}`);
    }
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0269 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('dos aplicaciones seguidas no fallan y los CHECK rechazan lo inválido', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0269);
        await tx.unsafe(SQL_0269);
        const base = `INSERT INTO flito_soat_incompletas (soat_id_reservado, compania_id, solicitado_por_nombre`;
        const [c] = await tx.unsafe('SELECT id FROM clients LIMIT 1');
        // Renovación por placa sin VIN ni factura: válida.
        await tx.unsafe(`${base}, tipo_soat, modalidad_consulta, placa) VALUES (gen_random_uuid(), ${c.id}, 'x', 'renovacion', 'placa', 'ABC123')`);
        // Modalidad placa sin placa: rechazada.
        await tx.savepoint(async (sp) => {
          await expect(sp.unsafe(`${base}, tipo_soat, modalidad_consulta) VALUES (gen_random_uuid(), ${c.id}, 'x', 'renovacion', 'placa')`)).rejects.toThrow();
        }).catch(() => undefined);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  });
});
