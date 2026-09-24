// Bug #12913 (Feature #12607, Épica #12245) — Migración 0209: `flito_comprobantes.servicio_tipo_id` (FK
// RESTRICT al catálogo de servicios adicionales) con su CHECK, y el índice único de la fila documental
// partido en dos: trámite digital / logística por (trámite, concepto) y servicios adicionales por
// (trámite, tipo). Calco de migracion-0208.test.ts.
//
// Se afirma «la anterior es 0208_» y NUNCA «la 0209 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { flitoComprobantes } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0209_flito_comprobantes_servicio_tipo.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0209 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0209.replace(/--[^\n]*/g, '');
const plano = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('0209 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0209)).toEqual([]);
    expect(SQL_0209).toMatch(/DO \$servicio_tipo_0209\$/);
    expect(SQL_0209).toMatch(/END \$servicio_tipo_0209\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0209_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0208_ — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0208_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Bug/Feature) y autor', () => {
    const cabecera = SQL_0209.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Bug #12913/);
    expect(cabecera).toMatch(/Feature #12607/);
  });

  it('columna idempotente con FK RESTRICT al catálogo; CHECK por pg_constraint; los dos índices únicos parciales y el viejo fuera', () => {
    const s = plano(SIN_COMENTARIOS);
    expect(s).toContain('ADD COLUMN IF NOT EXISTS servicio_tipo_id uuid NULL REFERENCES flito_servicios_adicionales_tipos(id) ON DELETE RESTRICT');
    expect(s).toContain("conname = 'flito_comprobantes_servicio_tipo_chk'");
    expect(s).toContain("CHECK (servicio_tipo_id IS NULL OR (concepto = 'servicios_adicionales' AND es_pago = true))");
    expect(s).toContain('DROP INDEX IF EXISTS idx_flito_comprobantes_valor_documental;');
    expect(s).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_td_lg ON flito_comprobantes (tramite_id, concepto) WHERE estado = 'aplicado' AND es_pago = true AND concepto IN ('tramite_digital', 'logistica');");
    expect(s).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental_sa ON flito_comprobantes (tramite_id, servicio_tipo_id) WHERE estado = 'aplicado' AND es_pago = true AND concepto = 'servicios_adicionales' AND servicio_tipo_id IS NOT NULL;");
    expect(SIN_COMENTARIOS.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
  });

  it('el modelo Drizzle refleja la 0209: columna, CHECK y los dos uniqueIndex (y ya no el índice viejo)', () => {
    const cfg = getTableConfig(flitoComprobantes);
    expect(cfg.columns.map((c) => c.name)).toContain('servicio_tipo_id');
    expect(cfg.checks.map((c) => c.name)).toContain('flito_comprobantes_servicio_tipo_chk');
    const unicos = cfg.indexes.filter((i) => i.config.unique).map((i) => i.config.name);
    expect(unicos).toEqual(expect.arrayContaining(['idx_flito_comprobantes_valor_documental_td_lg', 'idx_flito_comprobantes_valor_documental_sa']));
    expect(cfg.indexes.map((i) => i.config.name)).not.toContain('idx_flito_comprobantes_valor_documental');
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0209 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 1 columna, 1 CHECK, los dos índices nuevos y el viejo fuera', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0209);
      await tx.unsafe(SQL_0209);
      const cols = await tx`SELECT 1 FROM information_schema.columns WHERE table_name = 'flito_comprobantes' AND column_name = 'servicio_tipo_id'`;
      expect(cols).toHaveLength(1);
      const [chk] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'flito_comprobantes_servicio_tipo_chk'`;
      expect(chk!.n).toBe(1);
      const idx = await tx<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'flito_comprobantes' AND indexname LIKE 'idx_flito_comprobantes_valor_documental%' ORDER BY indexname`;
      expect(idx.map((i) => i.indexname)).toEqual(['idx_flito_comprobantes_valor_documental_sa', 'idx_flito_comprobantes_valor_documental_td_lg']);
    });
  }, 60_000);
});
