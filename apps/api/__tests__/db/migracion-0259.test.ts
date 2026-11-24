// HU #13957 (Feature #13940, Épica #13671) — La 0259: baja lógica de `flito_proveedores_soat` + nombre único solo
// entre vigentes.
//
//   · Estática (siempre corre): sin control de transacción propio; idempotente; retira la constraint única global;
//     el esquema Drizzle declara las columnas, la FK y el índice único parcial (y ya no `.unique()`).
//   · Contra PostgreSQL (retirada en la HU #14355, ver el final), en tx con ROLLBACK: dos veces sin error y solo queda el índice
//     parcial sobre `nombre` (AC5); AC1/AC3/AC4 sobre el índice real con su 23505 reconocido.
//
// HU #14333 (Feature #14324): el reconocedor propio de este índice se retiró con el CRUD viejo. El 409 por nombre
// repetido lo da ahora `conUnicidadTraducida`, para este índice y para los del padre.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoProveedoresSoat } from '../../src/db/schema.js';
import { db } from '../../src/db/client.js';
import { ProveedorDuplicadoError, conUnicidadTraducida } from '../../src/modules/flito-parametrizacion/flito-proveedores.service.js';
import { leerMigracion } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0259_flito_proveedores_soat_nombre_vivo.sql';
const SQL_0259 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0259.replace(/--[^\n]*/g, '');
const INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO = 'uq_flito_proveedores_soat_nombre_vivo';

/** Lo que la capa de servicio hace con un error de la base: el `db` está simulado y no encuentra al otro proveedor. */
async function traducido(crudo: unknown): Promise<unknown> {
  const sinFilas: Record<string, unknown> = { from: () => sinFilas, where: () => sinFilas, limit: async () => [] };
  vi.mocked(db.select).mockReturnValue(sinFilas as never);
  return conUnicidadTraducida({ nit: '900111222', nombre: 'Seguros Andinos' }, () => Promise.reject(crudo)).catch((e: unknown) => e);
}

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

  // HU #14673 (F5 E1): `nombre` y el índice único parcial siguen en la BD como espejo del padre (0313) hasta la #14355,
  // pero Drizzle ya no los declara. La unicidad del nombre la sostiene el padre (`uq_flito_proveedores_nombre_vivo`).
  it('el esquema Drizzle declara deleted_at/deleted_by y ya no declara nombre ni su índice (HU #14673)', () => {
    expect(flitoProveedoresSoat.deletedAt.notNull).toBe(false);
    expect(flitoProveedoresSoat.deletedBy.notNull).toBe(false);
    expect('nombre' in flitoProveedoresSoat).toBe(false);
    const cfg = getTableConfig(flitoProveedoresSoat);
    expect(cfg.uniqueConstraints).toHaveLength(0);
    expect(cfg.indexes.find((i) => i.config.name === INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO)).toBeUndefined();
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'deleted_by');
    expect(fk?.onDelete).toBe('restrict');
  });

  it('un 23505 de ese índice es un 409 por nombre, también envuelto en `cause` por Drizzle; otro error no se traduce', async () => {
    const crudo = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO });
    for (const e of [crudo, Object.assign(new Error('Failed query'), { cause: crudo })]) {
      const salida = await traducido(e);
      expect(salida).toBeInstanceOf(ProveedorDuplicadoError);
      expect((salida as ProveedorDuplicadoError).campo).toBe('nombre');
    }
    const otro = Object.assign(new Error('otra'), { code: '23503', constraint_name: INDICE_PROVEEDOR_SOAT_NOMBRE_VIVO });
    expect(await traducido(otro)).toBe(otro);
  });
});

// HU #14355: se retira la parte contra PostgreSQL. Reaplicaba la 0259, que crea el índice único sobre
// `flito_proveedores_soat.nombre`, columna que la 0314 eliminó: ya no se puede aplicar sobre un esquema al día. La parte
// estática sigue; el 409 por nombre repetido contra el índice real del padre lo mide `proveedores-gestion.test.ts`.
