// HU #13410 — migración 0225 (`flito_storage_borrados_pendientes`) y su reflejo en Drizzle.
//
// La parte con BD (TEST_DATABASE_URL) aplica el SQL DOS veces sobre la base ya migrada (P6) y ejercita
// contra Postgres, dentro de una transacción revertida, el INSERT del pendiente y el UPDATE de cierre
// REAL del servicio (`valoresCierre`): la clave queda NULL al cerrar, y el CHECK impide tanto un
// abierto sin clave como un cerrado que la conserve (Ley 1581). Sin la variable, esa parte se salta.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as dsql, eq, getTableColumns } from 'drizzle-orm';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import * as schema from '../../src/db/schema.js';
import { valoresCierre } from '../../src/modules/flito-soat/flito-soat-borrados-pendientes.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0225_flito_storage_borrados_pendientes.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0225 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0225.replace(/--[^\n]*/g, '');
const DOC_PRIVACIDAD = path.resolve(__dirname, '../../../../docs/privacy/retencion-flito-soat.md');

describe('0225 — análisis estático', () => {
  it('sin BEGIN/COMMIT; número único; la anterior es la 0224_; cabecera con nombre y autor', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0225)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0225_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0224_/);
    expect(SQL_0225.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL_0225).toMatch(/^-- Autor: /m);
  });

  it('idempotente (IF NOT EXISTS); storage_key nullable con el CHECK abierto ⇔ clave; índice parcial de abiertos; nada destructivo', () => {
    const plano = SIN_COMENTARIOS.replace(/\s+/g, ' ');
    expect(plano).toContain('CREATE TABLE IF NOT EXISTS flito_storage_borrados_pendientes (');
    expect(plano).toMatch(/ storage_key text, /);
    expect(plano).toContain('clave_hash varchar(16) NOT NULL');
    expect(plano).toContain('CHECK ((resuelto_en IS NULL) = (storage_key IS NOT NULL))');
    expect(plano).toContain('CHECK ((resuelto_en IS NULL) = (motivo_cierre IS NULL))');
    expect(plano).toContain(
      'CREATE INDEX IF NOT EXISTS idx_flito_storage_borrados_pendientes_abiertos ON flito_storage_borrados_pendientes (creado_en) WHERE resuelto_en IS NULL;',
    );
    expect(SIN_COMENTARIOS).not.toMatch(/DROP|DELETE|UPDATE |ALTER TABLE/);
  });

  it('el esquema Drizzle declara la tabla: storage_key nullable, clave_hash NOT NULL', () => {
    const c = getTableColumns(schema.flitoStorageBorradosPendientes);
    expect(c.storageKey.name).toBe('storage_key');
    expect(c.storageKey.notNull).toBe(false);
    expect(c.claveHash.notNull).toBe(true);
    expect(c.origen.notNull).toBe(true);
    expect(c.resueltoEn.notNull).toBe(false);
  });
});

describe('docs/privacy/retencion-flito-soat.md — borrados pendientes', () => {
  it('declara la tabla, el borrado de la clave al cierre, la alerta de 72 h y la variable', () => {
    const doc = readFileSync(DOC_PRIVACIDAD, 'utf8');
    expect(doc).toMatch(/flito_storage_borrados_pendientes/);
    expect(doc).toMatch(/72 h/);
    expect(doc).toMatch(/SOAT_BORRADOS_PENDIENTES_CRON_ENABLED/);
    expect(doc).toMatch(/storage_key[^\n]*NULL/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0225 — aplicar ×2 sobre BD ya migrada (P6), cierre real y CHECK', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  const enTx = async (fn: (tx: Parameters<Parameters<ReturnType<typeof drizzle<typeof schema>>['transaction']>[0]>[0]) => Promise<void>) => {
    const db = drizzle(sql, { schema });
    try {
      await db.transaction(async (tx) => {
        await tx.execute(dsql.raw(SQL_0225));
        await tx.execute(dsql.raw(SQL_0225));
        await fn(tx);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  };

  it('dos pasadas; índice parcial; INSERT abierto con clave y UPDATE de cierre que la deja NULL (clave_hash sobrevive)', async () => {
    await enTx(async (tx) => {
      const [idx] = (await tx.execute(dsql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_flito_storage_borrados_pendientes_abiertos'`)) as unknown as { indexdef: string }[];
      expect(idx.indexdef).toMatch(/\(creado_en\) WHERE \(resuelto_en IS NULL\)/);
      const t = schema.flitoStorageBorradosPendientes;
      const [p] = await tx.insert(t).values({ storageKey: 'k/900123456/x.pdf', claveHash: 'abcdef0123456789', origen: 'soat.documento_adicional' })
        .returning({ id: t.id, intentos: t.intentos });
      expect(p.intentos).toBe(0);
      const ahora = new Date();
      await tx.update(t).set({ ...valoresCierre('borrado', ahora), intentos: dsql`${t.intentos} + 1` }).where(eq(t.id, p.id));
      const [fila] = await tx.select().from(t).where(eq(t.id, p.id));
      expect(fila.storageKey).toBeNull();
      expect(fila.claveHash).toBe('abcdef0123456789');
      expect(fila.motivoCierre).toBe('borrado');
      expect(fila.intentos).toBe(1);
    });
  });

  /** Drizzle envuelve el error de Postgres («Failed query…»): el CHECK violado va en `cause`. */
  const restriccionViolada = async (p: Promise<void>): Promise<unknown> => {
    try { await p; } catch (e) {
      const err = e as { cause?: { constraint_name?: string }; constraint_name?: string };
      return err.cause?.constraint_name ?? err.constraint_name;
    }
    throw new Error('no lanzó');
  };

  it('CHECK: un abierto sin clave no entra', async () => {
    expect(await restriccionViolada(enTx(async (tx) => {
      await tx.execute(dsql`INSERT INTO flito_storage_borrados_pendientes (storage_key, clave_hash, origen) VALUES (NULL, 'h', 'o')`);
    }))).toBe('ck_flito_storage_borrados_pendientes_clave');
  });

  it('CHECK: un cierre que conserva la clave no entra', async () => {
    expect(await restriccionViolada(enTx(async (tx) => {
      await tx.execute(dsql`INSERT INTO flito_storage_borrados_pendientes (storage_key, clave_hash, origen, resuelto_en, motivo_cierre)
        VALUES ('k', 'h', 'o', now(), 'borrado')`);
    }))).toBe('ck_flito_storage_borrados_pendientes_clave');
  });
});
