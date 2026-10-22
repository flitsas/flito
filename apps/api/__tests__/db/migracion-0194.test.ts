// HU #12546 — Migración 0194: `flito_liquidaciones.valor_servicios_adicionales numeric(14,2) NULL`,
// la suma SELLADA de los servicios adicionales del trámite, con su COMMENT y SIN backfill. Calco de
// migracion-0193.test.ts.
//
// Se afirma «la anterior es 0193_» y NUNCA «la 0194 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · M-01 — quitar el `IF NOT EXISTS` del ADD COLUMN: cae el aserto de idempotencia estática y,
//     contra base, la segunda pasada del P6 (42701).
//   · M-02 — añadir un backfill (`UPDATE flito_liquidaciones SET valor_servicios_adicionales = 0`):
//     cae «no hay backfill» y, contra base, el aserto de que las filas existentes siguen en NULL.
//   · M-03 — declararla `NOT NULL DEFAULT 0`: cae el aserto de nullable y el de que no hay DEFAULT
//     (un 0 sembrado diría «este trámite no llevaba servicios», que es justo lo que no se sabe).
//   · M-04 — cambiar la precisión a (12,2): cae el aserto de tipo contra base.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0194_liquidaciones_valor_servicios_adicionales.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const RUTA = path.join(DIR, ARCHIVO);
const SQL_0194 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0194.replace(/--[^\n]*/g, '');

describe('0194 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0193', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0194)).toEqual([]);
    expect(SQL_0194).toMatch(/DO \$resumen0194\$/);
    expect(SQL_0194).toMatch(/END \$resumen0194\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0194.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0194_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0193_tramite_servicios_adicionales.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0194.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12544/);
    expect(cabecera).toMatch(/HU #12546/);
  });

  it('añade la columna idempotente, nullable y sin DEFAULT (M-01, M-03)', () => {
    expect(SIN_COMENTARIOS).toMatch(
      /ALTER TABLE flito_liquidaciones\s+ADD COLUMN IF NOT EXISTS valor_servicios_adicionales numeric\(14,2\);/,
    );
    expect(SIN_COMENTARIOS).not.toMatch(/valor_servicios_adicionales[^;]*NOT NULL/);
    expect(SIN_COMENTARIOS).not.toMatch(/valor_servicios_adicionales[^;]*DEFAULT/);
    // Una sola sentencia de DDL: ni índices ni constraints que el AC1 no nombra (el (tramite_id) de
    // la 0193 se queda como está).
    expect(SIN_COMENTARIOS.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE INDEX|DROP INDEX|ADD CONSTRAINT/);
  });

  it('NO hay backfill: ni UPDATE ni INSERT ni DELETE (M-02)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\bUPDATE\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/\bINSERT\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b/i);
  });

  it('el COMMENT explica que NULL = «no aplica» (sin servicios o sellada antes de esta HU)', () => {
    expect(SQL_0194).toMatch(/COMMENT ON COLUMN flito_liquidaciones\.valor_servicios_adicionales IS '/);
    const [, comentario] = /COMMENT ON COLUMN flito_liquidaciones\.valor_servicios_adicionales IS '([\s\S]*?)';/.exec(SQL_0194)!;
    expect(comentario).toMatch(/NULL = no aplica/);
    expect(comentario).toMatch(/antes de esta HU/);
    expect(comentario).toMatch(/[Ss]in backfill/);
  });

  it('el resumen final revienta si la columna no quedó creada', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_col <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0194:/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0194 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe: la columna queda una vez, numeric(14,2), nullable y sin default (M-01, M-03, M-04)', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0194);
      await tx.unsafe(SQL_0194);
      const columnas = await tx<{
        n: string; t: string; p: number; s: number; nulo: string; def: string | null;
      }[]>`
        SELECT column_name AS n, data_type AS t, numeric_precision AS p, numeric_scale AS s,
               is_nullable AS nulo, column_default AS def
          FROM information_schema.columns
         WHERE table_name = 'flito_liquidaciones' AND column_name = 'valor_servicios_adicionales'`;
      expect(columnas).toHaveLength(1);
      expect(columnas[0]!.t).toBe('numeric');
      expect(columnas[0]!.p).toBe(14);
      expect(columnas[0]!.s).toBe(2);
      expect(columnas[0]!.nulo).toBe('YES');
      expect(columnas[0]!.def).toBeNull();
    }, 60_000);
  }, 60_000);

  it('sin backfill: una liquidación creada ANTES de la migración se queda en NULL, y la columna sí acepta un valor (control positivo, M-02)', async () => {
    await enTx(async (tx) => {
      // La columna puede existir ya (la BD local está migrada): se quita dentro de esta transacción
      // para reproducir el estado PREVIO y volver a aplicarla. El ROLLBACK deshace las dos cosas.
      await tx.unsafe('ALTER TABLE flito_liquidaciones DROP COLUMN IF EXISTS valor_servicios_adicionales');
      const [tramite] = await tx<{ id: string }[]>`
        SELECT t.id FROM flito_tramites t
         WHERE NOT EXISTS (SELECT 1 FROM flito_liquidaciones l WHERE l.tramite_id = t.id) LIMIT 1`;
      if (!tramite) return; // base sin trámites libres: el control positivo no se puede montar
      const [previa] = await tx<{ id: string }[]>`
        INSERT INTO flito_liquidaciones (tramite_id, estado, base_gmf, valor_gmf, total)
        VALUES (${tramite.id}, 'liquidado', 100000, 400, 100400) RETURNING id`;

      await tx.unsafe(SQL_0194);

      const [vieja] = await tx<{ v: string | null }[]>`
        SELECT valor_servicios_adicionales AS v FROM flito_liquidaciones WHERE id = ${previa!.id}`;
      expect(vieja!.v).toBeNull();
      // Control positivo: la columna existe de verdad y guarda centavos.
      await tx`UPDATE flito_liquidaciones SET valor_servicios_adicionales = 85000.55 WHERE id = ${previa!.id}`;
      const [nueva] = await tx<{ v: string | null }[]>`
        SELECT valor_servicios_adicionales AS v FROM flito_liquidaciones WHERE id = ${previa!.id}`;
      expect(Number(nueva!.v)).toBe(85000.55);
    });
  }, 60_000);
});
