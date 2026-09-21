// Bug #12682 — La 0204: primeras fijaciones vía API (`fijarTarifa` con `now()`) pasan a regir
// «desde siempre» (mismo epoch que la 0183). Solo la vigencia MÁS ANTIGUA de cada llave; `fijado_en`
// intacto; 2ª pasada 0 filas sobre esas filas.
//
// Dos mitades, igual que la 0183:
//   · Estática (siempre corre): reglas del archivo, tip 0204, literales del epoch, tie-break.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL, en tx con ROLLBACK): fixtures con primera
//     fijación «mal» + cambio posterior; tras 0204 un instante en el pasado resuelve con vigenteEn.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { VIGENCIA_DESDE_SIEMPRE } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { abrirBase, companiaDesechable, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0204_tarifas_primera_fijacion_desde_siempre.sql';
const SQL_0204 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0204.replace(/--[^\n]*/g, '');
const EPOCH_SQL = '2000-01-01T00:00:00Z';

describe('0204 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0204)).toEqual([]);
    expect(SQL_0204).toMatch(/DO \$primerafijacion0204\$/);
    expect(SQL_0204).toMatch(/END \$primerafijacion0204\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera nombra el Bug #12682 y el epoch canónico de shared-types', () => {
    const cabecera = SQL_0204.split('\n').slice(0, 16).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/Bug #12682/);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(VIGENCIA_DESDE_SIEMPRE.startsWith('2000-01-01T00:00:00')).toBe(true);
  });

  it('el número es 0204 y es único; la anterior en disco es la 0203 (develop/staging) o la 0185 (release, promoción selectiva)', () => {
    const sqls = readdirSync(path.resolve(__dirname, '../../src/db/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0204_'))).toEqual([ARCHIVO]);
    // La 0204 llegó a `release` por cherry-pick (Bug #12682) antes que la 0186-0203: el runner
    // calcula pendientes por nombre de archivo, así que el hueco no rompe nada. Al promover
    // staging → release el hueco se cierra y vuelve a valer solo la 0203.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^(0203|0185)_/);
  });

  it('un solo UPDATE: al epoch, solo la más antigua por llave (ORDER BY vigente_desde, fijado_en, id), idempotente; fijado_en intacto', () => {
    expect(SIN_COMENTARIOS.match(/UPDATE flito_tarifas_vigencias/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`SET vigente_desde = '${EPOCH_SQL}'`));
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`vigente_desde <> '${EPOCH_SQL}'`));
    expect(SIN_COMENTARIOS).toMatch(/ORDER BY o\.vigente_desde ASC, o\.fijado_en ASC, o\.id ASC/);
    expect(SIN_COMENTARIOS).toMatch(/COALESCE\(o\.tipo_tramite, ''\) = COALESCE\(v\.tipo_tramite, ''\)/);
    expect(SIN_COMENTARIOS).not.toMatch(/fijado_en\s*=/);
    expect(SIN_COMENTARIOS).not.toMatch(/vigente_hasta\s*=/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0204: /);
  });
});

describe.skipIf(!URL_BASE)('0204 — contra la base real (primera fijación, resolución, idempotencia)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  const iso = (d: unknown) => new Date(d as string).toISOString();

  it('la más antigua de la llave pasa al epoch; la posterior no; fijado_en intacto; mayo resuelve 250000; 2ª pasada no mueve', async () => {
    const { flitoTarifasVigencias: v } = await import('../../src/db/schema.js');
    const { vigenteEn } = await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');

    await enTx(sql, async (tx) => {
      const c = await companiaDesechable(tx, 'M');

      // Primera fijación «mal» (API vieja con now()): vigente_desde = fijado_en.
      await tx`INSERT INTO flito_tarifas_vigencias
        (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, fijado_en, cerrado_en)
        VALUES (${c}, 'tramite_digital', 'MATRICULA', 250000,
          '2026-09-15T12:00:00Z', '2026-09-20T12:00:00Z', '2026-09-15T12:00:00Z', '2026-09-20T12:00:00Z')`;
      // Cambio posterior (cambiarOCerrar): no se toca.
      await tx`INSERT INTO flito_tarifas_vigencias
        (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, fijado_en)
        VALUES (${c}, 'tramite_digital', 'MATRICULA', 300000,
          '2026-09-20T12:00:00Z', NULL, '2026-09-20T12:00:00Z')`;

      const valorEn = async (fecha: Date) => {
        const { sql: where, params } = renderizar(and(
          eq(v.companiaId, c), eq(v.concepto, 'tramite_digital'), eq(v.tipoTramite, 'MATRICULA'), vigenteEn(v, fecha),
        )!);
        const filas = await tx.unsafe(`SELECT valor::float8 AS valor FROM flito_tarifas_vigencias WHERE ${where}`, params as never[]);
        return filas.map((f) => f.valor as number);
      };

      const mayo = new Date('2026-05-15T12:00:00Z');
      expect(await valorEn(mayo)).toEqual([]); // antes de 0204: fuera de [2026-09-15, 2026-09-20)

      await tx.unsafe(SQL_0204);

      const filas = await tx`
        SELECT valor::float8 AS valor, vigente_desde, vigente_hasta, fijado_en
          FROM flito_tarifas_vigencias WHERE compania_id = ${c}
          ORDER BY vigente_desde, fijado_en`;
      expect(filas).toHaveLength(2);
      expect(iso(filas[0]!.vigente_desde)).toBe(VIGENCIA_DESDE_SIEMPRE);
      expect(iso(filas[0]!.fijado_en)).toBe('2026-09-15T12:00:00.000Z');
      expect(iso(filas[0]!.vigente_hasta)).toBe('2026-09-20T12:00:00.000Z');
      expect(filas[0]!.valor).toBe(250000);
      expect(iso(filas[1]!.vigente_desde)).toBe('2026-09-20T12:00:00.000Z');
      expect(iso(filas[1]!.fijado_en)).toBe('2026-09-20T12:00:00.000Z');

      expect(await valorEn(mayo)).toEqual([250000]);
      expect(await valorEn(new Date('2026-09-21T00:00:00Z'))).toEqual([300000]);

      const huellaCia = async () => (await tx`
        SELECT md5(string_agg(
          concepto||coalesce(tipo_tramite,'')||valor||vigente_desde||coalesce(vigente_hasta::text,'')||fijado_en,
          ',' ORDER BY concepto, tipo_tramite, vigente_desde)) AS h
          FROM flito_tarifas_vigencias WHERE compania_id = ${c}`)[0];
      const h1 = await huellaCia();
      await tx.unsafe(SQL_0204);
      expect(await huellaCia()).toEqual(h1);
    });
  }, 60_000);
});
