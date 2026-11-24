// HU #13952 (Feature #13943, Épica #13671) — La 0257: baja lógica de `clients` + NIT único por sucursal entre vigentes.
//
//   · Estática (siempre corre): sin control de transacción propio; idempotente; el DO aborta con duplicados; el
//     esquema Drizzle declara las columnas, la FK y el índice único parcial.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error (P6); AC1/AC2/AC5/AC6/
//     AC7 sobre el índice real y su 23505 reconocido por `esDuplicadoNitSucursal`; el DO aborta listando los
//     duplicados si los hay.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { clients } from '../../src/db/schema.js';
import { esDuplicadoNitSucursal, INDICE_NIT_SUCURSAL_VIVO } from '../../src/modules/clients/clients.service.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0257_clients_nit_unico_sucursal.sql';
const SQL_0257 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0257.replace(/--[^\n]*/g, '');

describe('0257 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; idempotente; sin escribir datos', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0257)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at timestamptz;/);
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_by integer;/);
    expect(SIN_COMENTARIOS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'clients_deleted_by_users_id_fk'\)/);
    expect(SIN_COMENTARIOS).toMatch(/REFERENCES users\(id\) ON DELETE RESTRICT/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE_NIT_SUCURSAL_VIVO}`));
    expect(SIN_COMENTARIOS.replace(/ON DELETE RESTRICT/g, '')).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|DROP INDEX/);
  });

  it('el esquema Drizzle declara deleted_at/deleted_by y el índice único parcial (conserva el no único)', () => {
    expect(clients.deletedAt.notNull).toBe(false);
    expect(clients.deletedBy.notNull).toBe(false);
    const cfg = getTableConfig(clients);
    const uq = cfg.indexes.find((i) => i.config.name === INDICE_NIT_SUCURSAL_VIVO);
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.where).toBeDefined();
    expect(cfg.indexes.some((i) => i.config.name === 'idx_clients_document_branch')).toBe(true);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'deleted_by');
    expect(fk?.onDelete).toBe('restrict');
  });
});

describe.skipIf(!URL_BASE)('0257 — contra PostgreSQL (tx con ROLLBACK)', () => {
  const NIT = `13952${String(Date.now()).slice(-7)}`;

  it('P6: dos veces sin error; columnas, FK RESTRICT e índice único parcial', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0257);
        await tx.unsafe(SQL_0257);
        const cols = await tx`SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'clients' AND column_name IN ('deleted_at', 'deleted_by') ORDER BY column_name`;
        expect(cols).toEqual([
          { column_name: 'deleted_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
          { column_name: 'deleted_by', data_type: 'integer', is_nullable: 'YES' },
        ]);
        const [fk] = await tx`SELECT confdeltype FROM pg_constraint WHERE conname = 'clients_deleted_by_users_id_fk'`;
        expect(fk!.confdeltype).toBe('r');
        const [idx] = await tx`SELECT indexdef FROM pg_indexes WHERE tablename = 'clients' AND indexname = ${INDICE_NIT_SUCURSAL_VIVO}`;
        expect(idx!.indexdef).toMatch(/CREATE UNIQUE INDEX/);
        expect(idx!.indexdef).toMatch(/WHERE \(\(deleted_at IS NULL\)/);
      });
    } finally {
      await sql.end();
    }
  });

  it('AC1/AC6/AC2/AC5/AC7 sobre el índice real; el 23505 lo reconoce esDuplicadoNitSucursal', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0257);
        const alta = (doc: string | null, sucursal: number) =>
          tx`INSERT INTO clients (name, document, branch_office) VALUES ('HU13952', ${doc}, ${sucursal}) RETURNING id`;
        const choca = async (doc: string | null, sucursal: number): Promise<unknown> => {
          try { await tx.savepoint((sp) => sp`INSERT INTO clients (name, document, branch_office)
            VALUES ('HU13952', ${doc}, ${sucursal})`); return null; } catch (e) { return e; }
        };

        const [primero] = await alta(NIT, 0);
        // AC1/AC6: la misma pareja (también con espacios/minúsculas) choca con el índice → 23505 reconocido.
        const e1 = await choca(NIT, 0);
        expect(esDuplicadoNitSucursal(e1)).toBe(true);
        expect(esDuplicadoNitSucursal(await choca(` ${NIT} `, 0))).toBe(true);
        // AC2: otra sucursal sí.
        expect(await choca(NIT, 1)).toBeNull();
        // AC7: sin NIT (NULL o vacío) no participa.
        expect(await choca(null, 0)).toBeNull();
        expect(await choca(null, 0)).toBeNull();
        expect(await choca('', 0)).toBeNull();
        expect(await choca('', 0)).toBeNull();
        // AC5: dado de baja, deja de ocupar la pareja.
        await tx`UPDATE clients SET deleted_at = now() WHERE id = ${primero!.id}`;
        expect(await choca(NIT, 0)).toBeNull();
      });
    } finally {
      await sql.end();
    }
  });

  it('el DO aborta listando NIT + sucursal duplicados entre vigentes', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0257);
        await tx.unsafe(`DROP INDEX ${INDICE_NIT_SUCURSAL_VIVO}`);
        await tx`INSERT INTO clients (name, document, branch_office) VALUES ('HU13952 a', ${NIT}, 7), ('HU13952 b', ${NIT.toLowerCase() + ' '}, 7)`;
        const err = await tx.savepoint((sp) => sp.unsafe(SQL_0257)).then(() => null, (e: unknown) => e);
        expect(String((err as Error).message)).toMatch(new RegExp(`0257: .*NIT ${NIT} sucursal 7 \\(ids \\d+,\\d+\\)`));
      });
    } finally {
      await sql.end();
    }
  });
});
