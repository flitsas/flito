// HU #12089 — Migración 0190: DDL de baja lógica + siembra de funciones. Análisis estático
// e idempotencia contra BD local si hay DATABASE_URL / TEST_DATABASE_URL (P6).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { funcionesDeSql, repartoDeSql } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0190_users_baja_logica.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0190 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0190.replace(/--[^\n]*/g, '');

describe('0190 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0190)).toEqual([]);
    expect(SQL_0190).toMatch(/DO \$resumen0190\$/);
    expect(SQL_0190).toMatch(/END \$resumen0190\$;/);
    const con0190 = readdirSync(path.dirname(RUTA)).filter((f) => f.startsWith('0190_'));
    expect(con0190).toEqual([ARCHIVO]);
  });

  it('añade deleted_at / deleted_by con ON DELETE RESTRICT e índices parciales', () => {
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS deleted_at timestamptz/i);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS deleted_by integer/i);
    expect(SIN_COMENTARIOS).toMatch(/REFERENCES users\(id\) ON DELETE RESTRICT/i);
    expect(SIN_COMENTARIOS).toMatch(/idx_users_vivos/i);
    expect(SIN_COMENTARIOS).toMatch(/WHERE deleted_at IS NULL/i);
    // username/email NO se liberan — documentado en COMMENT
    expect(SQL_0190).toMatch(/username\/email NO se liberan/i);
  });

  it('siembra las dos funciones y el reparto a admin', () => {
    const funciones = funcionesDeSql([SQL_0190]);
    expect([...funciones.keys()].sort()).toEqual([
      'usuarios.usuario.baja', 'usuarios.usuario.reactivar',
    ]);
    const reparto = repartoDeSql([SQL_0190]);
    expect([...reparto.get('admin')!].sort()).toEqual([
      'usuarios.usuario.baja', 'usuarios.usuario.reactivar',
    ]);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0190 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => {
    sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe (idempotente)', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0190);
      await tx.unsafe(SQL_0190);
      const cols = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'
           AND column_name IN ('deleted_at', 'deleted_by')`;
      expect(cols[0]!.n).toBe(2);
    });
  }, 60_000);
});
