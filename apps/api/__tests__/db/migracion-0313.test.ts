// HU #14673 (Feature F5 #14327, ADR-0039 §5.2) — la 0313 mantiene las columnas viejas de los perfiles como espejo del
// padre mientras existan, ahora que el código ya no las declara ni las escribe (AC3, AC5).
//
// Solo estática desde la HU #14355: la 0314 retiró las columnas y los triggers que la parte contra PostgreSQL medía.
//
// Mutantes que mataba la parte contra PostgreSQL (retirada): quitar la rama «padre existe» de `perfil_crea_padre` (el perfil insertado solo con `id` violaría el
// NOT NULL de `nombre`); quitar el vaciado de la baja de logística (NIT, contacto y teléfono seguirían en el perfil);
// quitar la copia al reactivar (el espejo quedaría desfasado del padre).
process.env.TZ = 'UTC';

import { describe, it, expect, vi } from 'vitest';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { leerMigracion } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0313_flito_proveedores_perfil_espejo.sql';
const SQL = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0313 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio y con lock_timeout', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/SET LOCAL lock_timeout = '30s';/);
  });

  it('idempotente: CREATE OR REPLACE y DROP TRIGGER IF EXISTS antes de cada CREATE TRIGGER', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE OR REPLACE FUNCTION flito_proveedor_perfil_crea_padre\(\)/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE OR REPLACE FUNCTION flito_proveedor_perfil_espejo_baja\(\)/);
    for (const tabla of ['flito_proveedores_soat', 'flito_proveedores_logistica']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(
        `DROP TRIGGER IF EXISTS perfil_espejo_baja ON ${tabla};\\s*CREATE TRIGGER perfil_espejo_baja BEFORE UPDATE OF deleted_at ON ${tabla}`,
      ));
    }
  });

  it('no toca columnas, tablas ni los triggers de sincronización que no cambian', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(ALTER TABLE|DROP COLUMN|DROP TABLE|DROP FUNCTION)\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/flito_proveedor_padre_a_perfil|flito_proveedor_perfil_a_padre|users_proveedor_sincroniza/);
  });
});

// HU #14355: se retira la parte contra PostgreSQL. Aplicaba la 0313 y medía el espejo sobre las columnas viejas de los
// perfiles, que la 0314 eliminó junto con sus triggers: ya no hay espejo que medir. La parte estática sigue; la
// retirada la mide `migracion-0314.test.ts`.
