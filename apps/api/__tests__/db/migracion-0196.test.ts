// HU #12590 — Migración 0196: `flito_impuestos.liquidado_en` (timestamptz NULL, sin backfill) y el
// UPDATE que unifica el literal del soporte sin marca (`recibo_impuesto_sin_marca` →
// `recibo_impuesto_sin_marca_agua`, el del catálogo `TipoSoporte`), más el índice parcial
// `idx_flito_soportes_impuesto_tipo` que la cola de impuestos necesita. Calco de migracion-0195.test.ts.
//
// Se afirma «la anterior es 0195_» y NUNCA «la 0196 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · M-01 — `ADD COLUMN` sin `IF NOT EXISTS`: cae el aserto estático y, contra base, la 2ª pasada.
//   · M-02 — la columna `NOT NULL` (o con DEFAULT now()): cae el aserto estático; contra base, el
//     `is_nullable` y el backfill implícito que la decisión R6 prohíbe.
//   · M-03 — UPDATE con los literales cambiados de sitio (o un DELETE): caen los asertos del texto
//     exacto y, contra base, el conteo de filas viejas / la fila que debe sobrevivir.
//   · M-04 — quitar el `RAISE EXCEPTION` de las filas viejas: cae el aserto del resumen; con él, una
//     BD con el literal viejo pasaría el CD en verde y el ZIP seguiría sin encontrar el limpio.
//   · M-05 — tocar `descartado` en el UPDATE: cae el aserto de ausencia.
//   · M-06 — quitar el `CREATE INDEX` (o cambiarle columnas / predicado): cae el aserto estático del
//     índice y, contra base, el `RAISE EXCEPTION` del resumen y el aserto sobre `pg_indexes`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { TipoSoporte } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0196_flito_impuestos_liquidado_en.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0196 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0196.replace(/--[^\n]*/g, '');
const SCHEMA_TS = readFileSync(path.resolve(__dirname, '../../src/db/schema.ts'), 'utf8');

const LITERAL_VIEJO = 'recibo_impuesto_sin_marca';
const LITERAL_NUEVO: string = TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA;

describe('0196 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0195', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0196)).toEqual([]);
    expect(SQL_0196).toMatch(/DO \$resumen0196\$/);
    expect(SQL_0196).toMatch(/END \$resumen0196\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0196.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0196_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0195_siigo_mapeo_servicio_adicional.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0196.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12589/);
    expect(cabecera).toMatch(/HU #12590/);
  });

  it('la columna: ADD COLUMN IF NOT EXISTS, timestamptz, NULL y sin default (M-01, M-02)', () => {
    expect(SIN_COMENTARIOS).toMatch(/ALTER TABLE flito_impuestos\s+ADD COLUMN IF NOT EXISTS liquidado_en timestamptz\s*;/);
    const desde = SIN_COMENTARIOS.indexOf('ADD COLUMN IF NOT EXISTS liquidado_en');
    const sentencia = SIN_COMENTARIOS.slice(desde, SIN_COMENTARIOS.indexOf(';', desde));
    expect(sentencia).not.toMatch(/NOT NULL/i);
    expect(sentencia).not.toMatch(/DEFAULT/i);
    // Sin backfill (R6): ningún UPDATE escribe liquidado_en.
    expect(SIN_COMENTARIOS).not.toMatch(/SET\s+liquidado_en/i);
    // R7: el COMMENT deja claro que no es la Liquidación de FLITO.
    expect(SQL_0196).toMatch(/COMMENT ON COLUMN flito_impuestos\.liquidado_en IS '[^']*flito_liquidaciones\.liquidado_en[^']*'/);
    // Y schema.ts la declara con zona horaria, con el mismo nombre de columna.
    expect(SCHEMA_TS).toContain("liquidadoEn: timestamp('liquidado_en', { withTimezone: true })");
  });

  it('el UPDATE renombra el literal viejo al del catálogo, exacto, sin DELETE y sin tocar descartado (M-03, M-05)', () => {
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`UPDATE flito_soportes\\s+SET tipo = '${LITERAL_NUEVO}'\\s+WHERE tipo = '${LITERAL_VIEJO}'\\s*;`));
    expect(LITERAL_NUEVO).toBe('recibo_impuesto_sin_marca_agua');
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDROP\b/i);
    const desde = SIN_COMENTARIOS.indexOf('UPDATE flito_soportes');
    const update = SIN_COMENTARIOS.slice(desde, SIN_COMENTARIOS.indexOf(';', desde));
    expect(update).not.toMatch(/descartado/);
    expect(update).not.toMatch(/impuesto_id|soat_id|hash|storage_key/);
  });

  it('el resumen revienta si falta la columna, si no admite NULL o si quedan filas viejas (M-04)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_col <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_nullable <> 'YES' THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`WHERE tipo = '${LITERAL_VIEJO}';\\s*IF n_viejos <> 0 THEN\\s*RAISE EXCEPTION`));
    expect(SIN_COMENTARIOS).toMatch(/GET DIAGNOSTICS n_renombrados = ROW_COUNT/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0196:/);
  });

  it('crea UN índice parcial (impuesto_id, tipo) para la cola de impuestos, y schema.ts lo espeja (M-06)', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_flito_soportes_impuesto_tipo\s+ON flito_soportes \(impuesto_id, tipo\)\s+WHERE impuesto_id IS NOT NULL AND descartado = false\s*;/);
    expect(SIN_COMENTARIOS.match(/CREATE (?:UNIQUE )?INDEX/gi)).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE UNIQUE INDEX/i);
    // El resumen revienta si el índice no quedó, y el NOTICE lo nombra.
    expect(SIN_COMENTARIOS).toMatch(/indexname = 'idx_flito_soportes_impuesto_tipo';\s*IF n_idx <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0196:[^']*idx_flito_soportes_impuesto_tipo/);
    // Espejo en Drizzle: mismo nombre, mismas columnas y mismo predicado parcial.
    expect(SCHEMA_TS).toMatch(/index\('idx_flito_soportes_impuesto_tipo'\)\.on\(t\.impuestoId, t\.tipo\)\s*\.where\(sql`\$\{t\.impuestoId\} IS NOT NULL AND \$\{t\.descartado\} = false`\)/);
  });

  it('no crea tablas ni toca otras', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE TABLE/i);
    const tablas = [...SIN_COMENTARIOS.matchAll(/\b(?:ALTER TABLE|UPDATE|FROM|ON)\s+([a-z_]+)\b/g)].map((m) => m[1]);
    expect(new Set(tablas)).toEqual(new Set(['flito_impuestos', 'flito_soportes', 'information_schema', 'pg_indexes']));
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0196 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  const HASH = 'a'.repeat(64);

  it('segunda pasada no rompe: columna nullable, 0 filas viejas, la fila renombrada conserva hash y storage (M-01..M-04)', async () => {
    await enTx(async (tx) => {
      // Estado PREVIO reproducido dentro de la transacción: un soporte escrito con el literal viejo.
      // Sin impuesto (la FK es nullable): la migración no mira de quién cuelga.
      await tx`
        INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
        VALUES (${LITERAL_VIEJO}, 'QTQ100.pdf', 'application/pdf', 'flito/impuestos/recibos/test-0196.pdf', ${HASH}, 10, 'test 0196')`;
      const [{ n: viejasAntes }] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM flito_soportes WHERE tipo = ${LITERAL_VIEJO}`;
      expect(Number(viejasAntes)).toBeGreaterThanOrEqual(1);

      await tx.unsafe(SQL_0196);
      const [{ n: nuevasTrasPrimera }] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM flito_soportes WHERE tipo = ${LITERAL_NUEVO}`;
      await tx.unsafe(SQL_0196);

      const [col] = await tx<{ tipo: string; nullable: string; def: string | null }[]>`
        SELECT data_type AS tipo, is_nullable AS nullable, column_default AS def
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'flito_impuestos' AND column_name = 'liquidado_en'`;
      expect(col).toBeDefined();
      expect(col!.tipo).toBe('timestamp with time zone');
      expect(col!.nullable).toBe('YES');
      expect(col!.def).toBeNull();

      const [{ n: viejas }] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM flito_soportes WHERE tipo = ${LITERAL_VIEJO}`;
      expect(viejas).toBe('0');
      const [{ n: nuevasTrasSegunda }] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM flito_soportes WHERE tipo = ${LITERAL_NUEVO}`;
      expect(nuevasTrasSegunda).toBe(nuevasTrasPrimera);

      const [fila] = await tx<{ tipo: string; hash: string; storage_key: string; descartado: boolean }[]>`
        SELECT tipo, hash, storage_key, descartado FROM flito_soportes WHERE hash = ${HASH}`;
      expect(fila).toMatchObject({ tipo: LITERAL_NUEVO, hash: HASH, storage_key: 'flito/impuestos/recibos/test-0196.pdf', descartado: false });

      // M-06: el índice parcial existe tras las dos pasadas, con sus columnas y su predicado.
      const idx = await tx<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'flito_soportes' AND indexname = 'idx_flito_soportes_impuesto_tipo'`;
      expect(idx).toHaveLength(1);
      expect(idx[0]!.indexdef).toMatch(/^CREATE INDEX idx_flito_soportes_impuesto_tipo ON public\.flito_soportes USING btree \(impuesto_id, tipo\) WHERE \(\(impuesto_id IS NOT NULL\) AND \(descartado = false\)\)$/);
    });
  }, 60_000);
});
