// HU #13957 (Feature #13940, Épica #13671) — La 0259: baja lógica de `flito_proveedores_soat` + nombre único solo
// entre vigentes.
//
//   · Estática (siempre corre): sin control de transacción propio; idempotente; retira la constraint única global;
//     el esquema Drizzle declara las columnas, la FK y el índice único parcial (y ya no `.unique()`).
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error y solo queda el índice
//     parcial sobre `nombre` (AC5); AC1/AC3/AC4 sobre el índice real con su 23505 reconocido.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoProveedoresSoat } from '../../src/db/schema.js';
import {
  esDuplicadoNombreProveedorSoat, INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO,
} from '../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0259_flito_proveedores_soat_nombre_vivo.sql';
const SQL_0259 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0259.replace(/--[^\n]*/g, '');

describe('0259 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; idempotente; sin escribir datos', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0259)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS deleted_at timestamptz;/);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS deleted_by integer;/);
    expect(SIN_COMENTARIOS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'flito_proveedores_soat_deleted_by_users_id_fk'\)/);
    expect(SIN_COMENTARIOS).toMatch(/REFERENCES users\(id\) ON DELETE RESTRICT/);
    expect(SIN_COMENTARIOS).toMatch(/DROP CONSTRAINT IF EXISTS flito_proveedores_soat_nombre_key;/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO}`));
    expect(SIN_COMENTARIOS.replace(/ON DELETE RESTRICT/g, '')).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|DROP INDEX/);
  });

  it('el esquema Drizzle declara deleted_at/deleted_by, el índice único parcial y ya no la unicidad global', () => {
    expect(flitoProveedoresSoat.deletedAt.notNull).toBe(false);
    expect(flitoProveedoresSoat.deletedBy.notNull).toBe(false);
    expect(flitoProveedoresSoat.nombre.isUnique).toBe(false);
    const cfg = getTableConfig(flitoProveedoresSoat);
    expect(cfg.uniqueConstraints).toHaveLength(0);
    const uq = cfg.indexes.find((i) => i.config.name === INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO);
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.where).toBeDefined();
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'deleted_by');
    expect(fk?.onDelete).toBe('restrict');
  });
});

describe.skipIf(!URL_BASE)('0259 — contra PostgreSQL (tx con ROLLBACK)', () => {
  const NOMBRE = `HU13957 Seguros Andinos ${Date.now()}`;

  it('AC5/P6: dos veces sin error; columnas, FK RESTRICT y SOLO el índice parcial sobre nombre', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0259);
        await tx.unsafe(SQL_0259);
        const cols = await tx`SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'flito_proveedores_soat' AND column_name IN ('deleted_at', 'deleted_by') ORDER BY column_name`;
        expect(cols).toEqual([
          { column_name: 'deleted_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
          { column_name: 'deleted_by', data_type: 'integer', is_nullable: 'YES' },
        ]);
        const [fk] = await tx`SELECT confdeltype FROM pg_constraint WHERE conname = 'flito_proveedores_soat_deleted_by_users_id_fk'`;
        expect(fk!.confdeltype).toBe('r');
        const unicas = await tx`SELECT conname FROM pg_constraint
          WHERE conrelid = 'flito_proveedores_soat'::regclass AND contype = 'u'`;
        expect(unicas).toEqual([]);
        const idx = await tx`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'flito_proveedores_soat' AND indexdef ILIKE '%(nombre)%'`;
        expect(idx.map((i) => i.indexname)).toEqual([INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO]);
        expect(idx[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX/);
        expect(idx[0]!.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);
      });
    } finally {
      await sql.end();
    }
  });

  it('AC1/AC4/AC3 sobre el índice real; el 23505 lo reconoce esDuplicadoNombreProveedorSoat', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0259);
        const choca = async (nombre: string): Promise<unknown> => {
          try { await tx.savepoint((sp) => sp`INSERT INTO flito_proveedores_soat (nombre) VALUES (${nombre})`); return null; } catch (e) { return e; }
        };
        const [a] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES (${NOMBRE}) RETURNING id`;
        // AC1/AC4: el mismo nombre con A vigente choca con el índice parcial → 23505 reconocido (nunca 500).
        expect(esDuplicadoNombreProveedorSoat(await choca(NOMBRE))).toBe(true);
        // Exacta: otra capitalización no choca (misma semántica que la constraint que reemplaza).
        expect(await choca(NOMBRE.toUpperCase())).toBeNull();
        // AC3: A eliminado (baja lógica) libera el nombre.
        await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${a!.id}`;
        expect(await choca(NOMBRE)).toBeNull();
      });
    } finally {
      await sql.end();
    }
  });
});
