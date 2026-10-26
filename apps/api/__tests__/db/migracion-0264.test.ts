// HU #13971 (Feature #13940) — La 0264: índices de users y clients por su proveedor SOAT.
//
//   · Estática (siempre corre): sin control de transacción propio (el runner la envuelve; por eso nada de
//     CONCURRENTLY); solo `CREATE INDEX IF NOT EXISTS` sobre las dos columnas, completos (sin WHERE); el esquema
//     Drizzle declara los mismos nombres para no tener drift.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error (AC3), los índices
//     existen sobre la columna correcta y sin predicado (AC1/AC2), y la segunda aplicación no cambia su definición.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { users, clients } from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0264_indices_proveedor_soat.sql';
const SQL_0264 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0264.replace(/--[^\n]*/g, '');
const INDICES = {
  idx_users_flito_proveedor_soat: { tabla: 'users', columna: 'flito_proveedor_soat_id' },
  idx_clients_flito_proveedor_soat_sin_tramite: { tabla: 'clients', columna: 'flito_proveedor_soat_sin_tramite_id' },
} as const;

describe('0264 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio ni CONCURRENTLY; solo CREATE INDEX IF NOT EXISTS', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0264)).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/CONCURRENTLY/i);
    const sentencias = SIN_COMENTARIOS.split(';').map((s) => s.trim()).filter(Boolean);
    expect(sentencias).toHaveLength(2);
    for (const s of sentencias) expect(s).toMatch(/^CREATE INDEX IF NOT EXISTS /);
  });

  it.each(Object.entries(INDICES))('%s: sobre %o, completo (sin WHERE)', (nombre, { tabla, columna }) => {
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${nombre}\\s+ON ${tabla} \\(${columna}\\)`));
    expect(SIN_COMENTARIOS).not.toMatch(/\bWHERE\b/i);
  });

  it('el esquema Drizzle declara los mismos índices, misma columna y sin predicado (sin drift)', () => {
    for (const [tabla, def] of [[users, INDICES.idx_users_flito_proveedor_soat], [clients, INDICES.idx_clients_flito_proveedor_soat_sin_tramite]] as const) {
      const cfg = getTableConfig(tabla);
      const nombre = Object.keys(INDICES).find((k) => INDICES[k as keyof typeof INDICES] === def)!;
      const idx = cfg.indexes.find((i) => i.config.name === nombre);
      expect(idx).toBeDefined();
      expect(idx!.config.unique).toBe(false);
      expect(idx!.config.where).toBeUndefined();
      expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual([def.columna]);
    }
  });
});

describe.skipIf(!URL_BASE)('0264 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1/AC2/AC3: dos veces sin error; los índices existen, completos, y la segunda aplicación no los cambia', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const leer = async () => tx`SELECT indexname, tablename, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname IN ${tx(Object.keys(INDICES))} ORDER BY indexname`;
        await tx.unsafe(SQL_0264);
        const primera = await leer();
        await tx.unsafe(SQL_0264);
        const segunda = await leer();
        expect(primera.map((r) => r.indexname)).toEqual(Object.keys(INDICES).sort());
        for (const r of primera) {
          const def = INDICES[r.indexname as keyof typeof INDICES];
          expect(r.tablename).toBe(def.tabla);
          expect(r.indexdef).toMatch(new RegExp(`USING btree \\(${def.columna}\\)$`));
        }
        expect(segunda).toEqual(primera);
      });
    } finally {
      await sql.end();
    }
  });
});
