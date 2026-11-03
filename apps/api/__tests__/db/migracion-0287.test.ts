// HU #13989 (ADR-0033) — la 0287 crea `uso_legacy_diario`: agregados sin PII, idempotente.
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL (en tx con ROLLBACK).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';
import { usoLegacyDiario } from '../../src/db/schema/uso-legacy.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0287_uso_legacy_diario.sql';
const SQL = leerMigracion(ARCHIVO);
const sinComentarios = (s: string) => s.replace(/--[^\n]*/g, '');

describe('0287 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio, idempotente y sin tocar otras tablas', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const s = sinComentarios(SQL);
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS uso_legacy_diario/);
    expect(s).not.toMatch(/\b(ALTER|DROP|INSERT|REFERENCES)\b/i);
  });

  it('la cabecera declara la política de retención (regla 16)', () => {
    expect(SQL).toMatch(/MÁXIMO de 6 meses/);
    expect(SQL).toMatch(/HU #13990/);
  });

  it('la tabla Drizzle declara las mismas columnas y la misma PK que el SQL', () => {
    const t = getTableConfig(usoLegacyDiario);
    const columnas = t.columns.map((c) => c.name);
    expect(columnas).toEqual(['dia', 'modulo', 'ruta', 'metodo', 'consumidor', 'total']);
    for (const c of columnas) expect(sinComentarios(SQL)).toMatch(new RegExp(`\\b${c}\\b`));
    expect(t.primaryKeys[0]!.columns.map((c) => c.name)).toEqual(['dia', 'modulo', 'ruta', 'metodo', 'consumidor']);
    expect(t.checks.map((c) => c.name).sort()).toEqual(['uso_legacy_diario_modulo_check', 'uso_legacy_diario_total_check']);
  });
});

describe.skipIf(!URL_BASE)('0287 — contra la base real', () => {
  let sql: ReturnType<typeof abrirBase>;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('aplicar dos veces no falla; el UPSERT suma y los CHECK rechazan lo inválido', async () => {
    await enTx(sql, async (tx) => {
      await tx.unsafe(SQL);
      await tx.unsafe(SQL);
      const fila = ['2026-11-03', 'soat', '/api/soat/:id', 'GET', 'admin'] as const;
      const upsert = (n: number) => tx`
        INSERT INTO uso_legacy_diario (dia, modulo, ruta, metodo, consumidor, total)
        VALUES (${fila[0]}, ${fila[1]}, ${fila[2]}, ${fila[3]}, ${fila[4]}, ${n})
        ON CONFLICT (dia, modulo, ruta, metodo, consumidor)
        DO UPDATE SET total = uso_legacy_diario.total + EXCLUDED.total`;
      await upsert(2);
      await upsert(3);
      const [r] = await tx`SELECT total::int AS total FROM uso_legacy_diario WHERE ruta = ${fila[2]} AND dia = ${fila[0]}`;
      expect(r!.total).toBe(5);
      await tx`SAVEPOINT s`;
      await expect(tx`INSERT INTO uso_legacy_diario VALUES ('2026-11-03', 'flito-soat', '/x', 'GET', 'admin', 1)`).rejects.toThrow(/modulo_check/);
      await tx`ROLLBACK TO SAVEPOINT s`;
      await expect(tx`INSERT INTO uso_legacy_diario VALUES ('2026-11-03', 'soat', '/x', 'GET', 'admin', 0)`).rejects.toThrow(/total_check/);
    });
  });
});
