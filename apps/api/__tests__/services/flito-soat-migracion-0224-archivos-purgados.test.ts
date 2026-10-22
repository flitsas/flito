// HU #13409 — migración 0224 (`flito_soat_incompletas.archivos_purgados_en` + índice parcial de lo
// pendiente) y la política escrita en `docs/privacy/retencion-flito-soat.md` (AC9).
//
// La parte con BD (TEST_DATABASE_URL) aplica el SQL DOS veces sobre la base ya migrada (P6) y ejecuta
// la condición REAL de candidatas del servicio contra Postgres, dentro de una transacción revertida:
// la frontera inclusiva ±1 s con el tipo `timestamptz` de verdad, no con el mock.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as dsql, getTableColumns } from 'drizzle-orm';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import * as schema from '../../src/db/schema.js';
import { condicionCandidatas, corteRetencion } from '../../src/modules/flito-soat/flito-soat-retencion.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0224_flito_soat_incompletas_archivos_purgados_en.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0224 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0224.replace(/--[^\n]*/g, '');
const DOC = path.resolve(__dirname, '../../../../docs/privacy/retencion-flito-soat.md');

describe('0224 — análisis estático', () => {
  it('sin BEGIN/COMMIT; número único; la anterior es la 0223_; cabecera con nombre y autor', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0224)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0224_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0223_/);
    expect(SQL_0224.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL_0224).toMatch(/^-- Autor: /m);
  });

  it('columna nullable e idempotente; índice parcial idempotente de lo pendiente; nada destructivo', () => {
    const plano = SIN_COMENTARIOS.replace(/\s+/g, ' ');
    expect(plano).toContain('ALTER TABLE flito_soat_incompletas ADD COLUMN IF NOT EXISTS archivos_purgados_en timestamptz;');
    expect(plano).toContain(
      "CREATE INDEX IF NOT EXISTS idx_flito_soat_incompletas_retencion_pendiente ON flito_soat_incompletas (resuelta_en) WHERE estado = 'descartada' AND archivos_purgados_en IS NULL;",
    );
    expect(SIN_COMENTARIOS).not.toMatch(/NOT NULL|DROP|DELETE|UPDATE /);
  });

  it('el esquema Drizzle declara la columna (nullable, con zona)', () => {
    const c = getTableColumns(schema.flitoSoatIncompletas).archivosPurgadosEn;
    expect(c.name).toBe('archivos_purgados_en');
    expect(c.notNull).toBe(false);
    expect(c.getSQLType()).toBe('timestamp with time zone');
  });
});

describe('AC9 — docs/privacy/retencion-flito-soat.md', () => {
  it('TC9.2 existe y declara plazo, base legal, qué se borra y qué se conserva', () => {
    expect(existsSync(DOC)).toBe(true);
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).toMatch(/30 días/);
    expect(doc).toMatch(/Ley 1581/);
    expect(doc).toMatch(/Se borra del almacenamiento/);
    expect(doc).toMatch(/factura_storage_key/);
    expect(doc).toMatch(/documento_adicional_soat/);
    expect(doc).toMatch(/Se conserva/);
    expect(doc).toMatch(/SOAT_RETENCION_CRON_ENABLED/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0224 — aplicar ×2 sobre BD ya migrada (P6) y frontera real', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('dos pasadas; columna e índice; la condición del servicio toma −30 d y deja −30 d +1 s, incompletas y purgadas', async () => {
    const db = drizzle(sql, { schema });
    try {
      await db.transaction(async (tx) => {
        await tx.execute(dsql.raw(SQL_0224));
        await tx.execute(dsql.raw(SQL_0224));
        const [col] = (await tx.execute(dsql`
          SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'flito_soat_incompletas' AND column_name = 'archivos_purgados_en'`)) as unknown as { data_type: string; is_nullable: string }[];
        expect(col).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
        const [idx] = (await tx.execute(dsql`
          SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_flito_soat_incompletas_retencion_pendiente'`)) as unknown as { indexdef: string }[];
        expect(idx.indexdef).toMatch(/\(resuelta_en\) WHERE/);
        expect(idx.indexdef).toMatch(/archivos_purgados_en IS NULL/);

        const [cliente] = (await tx.execute(dsql`SELECT id FROM clients LIMIT 1`)) as unknown as { id: number }[];
        if (!cliente) throw ROLLBACK; // BD sin compañías: la parte de la frontera no aplica

        const ahora = new Date();
        const MS_30D = 30 * 24 * 60 * 60 * 1000;
        const t = schema.flitoSoatIncompletas;
        const base = {
          companiaId: cliente.id, vin: '9BWZZZ377VT0042', facturaStorageKey: 'k', facturaHash: 'h',
          facturaNombreArchivo: 'f.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1,
          solicitadoPorNombre: 'test-0224',
        };
        const descartada = (resueltaEn: Date, archivosPurgadosEn: Date | null = null) => ({
          ...base, id: randomUUID(), soatIdReservado: randomUUID(), estado: 'descartada',
          motivoDescarte: 'soat_vigente', resueltaEn, resueltaPorNombre: 'test-0224', archivosPurgadosEn,
        });
        const enFrontera = descartada(new Date(ahora.getTime() - MS_30D));
        const unSegundoAntes = descartada(new Date(ahora.getTime() - MS_30D + 1000));
        const yaPurgada = descartada(new Date(ahora.getTime() - 2 * MS_30D), ahora);
        const abierta = { ...base, vin: '9BWZZZ377VT9999', id: randomUUID(), soatIdReservado: randomUUID() };
        await tx.insert(t).values([enFrontera, unSegundoAntes, yaPurgada, abierta] as never);

        const ids: string[] = [enFrontera.id, unSegundoAntes.id, yaPurgada.id, abierta.id];
        const filas = await tx.select({ id: t.id }).from(t)
          .where(condicionCandidatas(corteRetencion(ahora)));
        const elegidas = filas.map((f) => f.id).filter((id) => ids.includes(id));
        expect(elegidas).toEqual([enFrontera.id]);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  });
});
