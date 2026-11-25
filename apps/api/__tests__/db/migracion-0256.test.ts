// HU #13946 (Feature #13939) — La 0256: `flito_tramites.retenido` + índice parcial por compañía.
//
//   · Estática (siempre corre): sin control de transacción propio; ADD COLUMN IF NOT EXISTS y CREATE INDEX IF NOT
//     EXISTS (idempotente); sin migración de datos; el esquema Drizzle declara la misma columna e índice.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error (AC7); la columna queda
//     `boolean NOT NULL DEFAULT false` y el índice es parcial `WHERE retenido`.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoTramites } from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0256_flito_tramites_retenido.sql';
const SQL_0256 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0256.replace(/--[^\n]*/g, '');
const INDICE = 'idx_flito_tramites_retenido_compania';

describe('0256 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; idempotente; sin migración de datos', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0256)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_tramites ADD COLUMN IF NOT EXISTS retenido boolean NOT NULL DEFAULT false;/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${INDICE} ON flito_tramites \\(compania_id\\) WHERE retenido;`));
    expect(SIN_COMENTARIOS).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/);
  });

  it('el esquema Drizzle declara la columna y el índice parcial', () => {
    expect(flitoTramites.retenido.notNull).toBe(true);
    expect(flitoTramites.retenido.default).toBe(false);
    const idx = getTableConfig(flitoTramites).indexes.find((i) => i.config.name === INDICE);
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeDefined();
  });
});

describe.skipIf(!URL_BASE)('0256 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC7: dos veces sin error; columna boolean NOT NULL DEFAULT false e índice parcial WHERE retenido', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0256);
        await tx.unsafe(SQL_0256);
        const [col] = await tx`SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'flito_tramites' AND column_name = 'retenido'`;
        expect(col).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
        const [idx] = await tx`SELECT indexdef FROM pg_indexes WHERE tablename = 'flito_tramites' AND indexname = ${INDICE}`;
        expect(idx!.indexdef).toMatch(/\(compania_id\) WHERE retenido/);
      });
    } finally {
      await sql.end();
    }
  });
});
