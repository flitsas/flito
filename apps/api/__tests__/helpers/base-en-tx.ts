// Contra PostgreSQL de verdad, TODO dentro de una transacción que termina en ROLLBACK.
//
// La base local (5434) la comparten otras sesiones con el código de `develop`, y las migraciones
// 0182/0183 no se le aplican de forma permanente: cada test recrea lo que necesita dentro de su
// transacción (el DDL de la 0110 para poder desdoblar, la 0182, la 0183, los fixtures) y lo deshace
// todo al salir. Se activa con `TEST_DATABASE_URL`; sin ella los tests se SALTAN en vez de fallar
// (el CI no levanta Postgres). Patrón heredado de `db/migracion-0182.test.ts`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRACIONES = path.resolve(__dirname, '../../src/db/migrations');

export const URL_BASE = process.env.TEST_DATABASE_URL;

export const leerMigracion = (archivo: string): string => readFileSync(path.join(MIGRACIONES, archivo), 'utf8');

const ROLLBACK = Symbol('rollback');

export function abrirBase(): postgres.Sql {
  return postgres(URL_BASE!, { max: 1, onnotice: () => {} });
}

/** Ejecuta `fn` en una transacción que SIEMPRE se deshace; devuelve lo que `fn` devolvió. */
export async function enTx<T>(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let salida!: T;
  try {
    await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  return salida;
}

/** El DDL de la 0110, para poder desdoblar en una base que ya aplicó la 0182 (la tabla vieja no existe). */
export const DDL_0110 = `
CREATE TABLE IF NOT EXISTS flito_tarifas_compania (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id        integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  concepto           varchar(30) NOT NULL,
  tipo_tramite       varchar(60),
  valor              numeric(14,2) NOT NULL,
  activo             boolean NOT NULL DEFAULT true,
  actualizado_por_id integer REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_tarifas_valor_no_negativo CHECK (valor >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_tarifas_unica
  ON flito_tarifas_compania (compania_id, concepto, COALESCE(tipo_tramite, ''));`;

/** Una compañía desechable (vive solo dentro de la transacción). */
export async function companiaDesechable(
  tx: postgres.TransactionSql, nombre: string,
  banderas: { soat?: boolean; impuestos?: boolean; logistica?: boolean } = {},
): Promise<number> {
  const [c] = await tx`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
    VALUES (${`HU12374 ${nombre}`}, ${`12374-${nombre}-${String(Date.now()).slice(-8)}`},
            ${banderas.soat ?? true}, ${banderas.impuestos ?? true}, ${banderas.logistica ?? false}) RETURNING id`;
  return c!.id as number;
}
