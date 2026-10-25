// HU #13965 (Feature #13886) — La 0260: el corte del descuento por comprobante se registra al APLICAR la
// migración (instante `now()`), en una tabla de una sola fila. Reemplaza ADR-0029 D12 (variable de entorno).
//
//   · Estática (siempre corre): sin control de transacción propio; idempotente (IF NOT EXISTS + ON CONFLICT DO
//     NOTHING, nunca DO UPDATE); el esquema Drizzle declara la tabla.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: AC1 — sin tabla la crea con UNA fila
//     cuyo corte es el instante de aplicación; aplicarla otra vez NO cambia `corte_en`; la fila es única (CHECK).
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoBolsasCorte } from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0260_flito_bolsas_corte_automatico.sql';
const SQL_0260 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0260.replace(/--[^\n]*/g, '');

describe('0260 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; idempotente; el re-aplicado no sobrescribe el corte', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0260)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_bolsas_corte/);
    expect(SIN_COMENTARIOS).toMatch(/corte_en\s+timestamptz NOT NULL/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(id = 1\)/);
    expect(SIN_COMENTARIOS).toMatch(/VALUES \(1, now\(\)\)\s*ON CONFLICT \(id\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE|\bUPDATE\b|\bDELETE\b|\bDROP\b/);
  });

  it('el esquema Drizzle declara flito_bolsas_corte con corte_en timestamptz not null y el CHECK de fila única', () => {
    const cfg = getTableConfig(flitoBolsasCorte);
    expect(cfg.name).toBe('flito_bolsas_corte');
    expect(flitoBolsasCorte.corteEn.notNull).toBe(true);
    expect(flitoBolsasCorte.corteEn.getSQLType()).toBe('timestamp with time zone');
    expect(cfg.checks.map((c) => c.name)).toContain('ck_flito_bolsas_corte_fila_unica');
  });
});

describe.skipIf(!URL_BASE)('0260 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1 · sin tabla: la crea con una fila = instante de aplicación; aplicarla otra vez NO cambia corte_en', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx`DROP TABLE IF EXISTS flito_bolsas_corte`;
        const [{ ahora }] = await tx`SELECT now() AS ahora` as unknown as [{ ahora: Date }];
        await tx.unsafe(SQL_0260);
        const primera = await tx`SELECT id, corte_en FROM flito_bolsas_corte`;
        expect(primera).toHaveLength(1);
        expect((primera[0]!.corte_en as Date).getTime()).toBe(ahora.getTime());

        // Un corte ya registrado (otro instante) sobrevive a un segundo y tercer aplicado.
        await tx`UPDATE flito_bolsas_corte SET corte_en = '2026-10-25T20:00:00Z' WHERE id = 1`;
        await tx.unsafe(SQL_0260);
        await tx.unsafe(SQL_0260);
        const despues = await tx`SELECT corte_en FROM flito_bolsas_corte`;
        expect(despues).toHaveLength(1);
        expect((despues[0]!.corte_en as Date).toISOString()).toBe('2026-10-25T20:00:00.000Z');
      });
    } finally {
      await sql.end();
    }
  });

  it('AC1 · la tabla admite una sola fila (CHECK id = 1)', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0260);
        const e = await tx.savepoint((sp) => sp`INSERT INTO flito_bolsas_corte (id, corte_en) VALUES (2, now())`)
          .then(() => null, (err: unknown) => err);
        expect((e as { code?: string } | null)?.code).toBe('23514');
      });
    } finally {
      await sql.end();
    }
  });
});
