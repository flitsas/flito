// 0320 — nombre_gestor / correo_gestor en flito_tramites (FLIT 1 y FLIT 2). Dos pruebas:
//   · paridad (sin BD): los anchos de `MAX_GESTOR` (adaptador FLIT 1) son los de la columna del esquema Drizzle
//     y los del SQL escrito a mano;
//   · BD (con TEST_DATABASE_URL, siempre ROLLBACK): el SQL corre dos veces sin error y deja dos varchar nullable.
import { describe, it, expect, afterAll } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flitoTramites } from '../../src/db/schema.js';
import { MAX_GESTOR } from '../../src/modules/flito-sync/flit-http.adapter.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

const SQL = leerMigracion('0320_flito_tramite_gestor.sql');

describe('0320 — paridad de anchos', () => {
  it('MAX_GESTOR = columnas del esquema = SQL de la migración', () => {
    const cols = getTableConfig(flitoTramites).columns;
    const largo = (n: string) => (cols.find((c) => c.name === n) as unknown as { length: number }).length;
    expect(largo('nombre_gestor')).toBe(MAX_GESTOR.nombreGestor);
    expect(largo('correo_gestor')).toBe(MAX_GESTOR.correoGestor);
    expect(SQL).toContain(`nombre_gestor varchar(${MAX_GESTOR.nombreGestor})`);
    expect(SQL).toContain(`correo_gestor varchar(${MAX_GESTOR.correoGestor})`);
  });
});

describe.skipIf(!URL_BASE)('0320 — sobre la base (en transacción, siempre con ROLLBACK)', () => {
  const sql = URL_BASE ? abrirBase() : null;
  afterAll(async () => { await sql?.end(); });

  it('es idempotente y deja las dos columnas varchar nullable', async () => {
    const filas = await enTx(sql!, async (tx) => {
      await tx.unsafe(SQL);
      await tx.unsafe(SQL);
      return tx`SELECT column_name, data_type, character_maximum_length AS largo, is_nullable
                  FROM information_schema.columns
                 WHERE table_name = 'flito_tramites' AND column_name IN ('nombre_gestor', 'correo_gestor')
                 ORDER BY column_name`;
    });
    expect(filas.map((f) => [f.column_name, f.data_type, f.largo, f.is_nullable])).toEqual([
      ['correo_gestor', 'character varying', 254, 'YES'],
      ['nombre_gestor', 'character varying', 200, 'YES'],
    ]);
  });
});
