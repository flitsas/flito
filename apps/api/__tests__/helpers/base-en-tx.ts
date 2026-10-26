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

/**
 * HU #13911 (migración 0266): los seis libros viejos de bolsas salieron de `public` a `archivo_bolsas`.
 * Las pruebas de las migraciones que los LEEN (0250, 0257, 0266) los necesitan en `public`: esto los
 * devuelve allí DENTRO de la transacción —es el mismo paso del rollback del runbook— y el ROLLBACK de
 * `enTx` los deja otra vez en el archivo. En una base sin la 0266 aplicada no hace nada.
 */
export const LIBROS_VIEJOS_BOLSAS = [
  'flito_bolsas', 'flito_bolsa_movimientos', 'flito_bolsa_cierres',
  'flito_bolsas_transito', 'flito_bolsa_transito_cobertura', 'flito_bolsa_transito_movimientos',
] as const;

export async function librosViejosEnPublic(tx: postgres.TransactionSql): Promise<void> {
  for (const t of LIBROS_VIEJOS_BOLSAS) {
    const [f] = await tx`SELECT to_regclass(${`public.${t}`}) IS NULL AS falta,
                                to_regclass(${`archivo_bolsas.${t}`}) IS NOT NULL AS archivada`;
    if (f!.falta && f!.archivada) await tx.unsafe(`ALTER TABLE archivo_bolsas.${t} SET SCHEMA public`);
  }
}

/** `enTx` con los libros viejos de bolsas en `public` (ver `librosViejosEnPublic`). */
export async function enTxLibrosViejos<T>(
  sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return enTx(sql, async (tx) => { await librosViejosEnPublic(tx); return fn(tx); });
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
