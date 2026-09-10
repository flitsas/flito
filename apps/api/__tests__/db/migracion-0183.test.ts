// HU #12374 — La 0183: las vigencias que la 0182 desdobló del modelo viejo rigen «desde siempre».
//
// La 0182 puso `vigente_desde = created_at` de la tarifa vieja; el modelo viejo era ATEMPORAL, así
// que con la resolución por fecha de aprobación (RN-07) todo trámite aprobado antes de ese instante
// quedaría «sin configurar» sin forma de liquidarse (RN-10 del Feature: las migradas arrancan desde
// siempre). La 0183 lleva `vigente_desde` a 2000-01-01 SOLO en la vigencia más antigua de cada llave
// creada antes del corte (2026-09-10T18:00Z, el merge de la 0182): así no puede crear un solape con
// la EXCLUDE, y las abiertas después por la API nueva no se tocan.
//
// Dos mitades, igual que la 0182:
//   · Estática (siempre corre): reglas del archivo, número max+1, literales del corte y del epoch,
//     la guarda NOT EXISTS y que `fijado_en` no se toca.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL, en tx con ROLLBACK): 0110 con fixtures + 0182 +
//     0183 dos veces; un trámite aprobado en 2026-05 resuelve el valor migrado con la expresión REAL
//     (`vigenteEn`); el solape: una migrada CERRADA más una abierta por la API nueva; y la guarda
//     «más antigua por llave» con DOS vigencias anteriores al corte en la misma llave (insertadas a
//     mano, porque la 0182 nunca deja dos por llave).
//
// TZ=UTC: se comparan instantes como ISO.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { abrirBase, companiaDesechable, DDL_0110, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

// El servicio de tarifas se importa por `vigenteEn` (la expresión real); su `db` no se usa aquí.
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0183_tarifas_vigencias_desde_siempre.sql';
const SQL_0183 = leerMigracion(ARCHIVO);
const SQL_0182 = leerMigracion('0182_tarifas_vigencias.sql');
const SIN_COMENTARIOS = SQL_0183.replace(/--[^\n]*/g, '');

const EPOCH = '2000-01-01T00:00:00Z';
/** Respaldo del corte, solo cuando la 0182 no está registrada en _kyverum_applied_migrations. */
const CORTE = '2026-09-10T18:00:00Z';
const REGISTRO_0182 = '0182_tarifas_vigencias.sql';

describe('0183 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0183)).toEqual([]);
    expect(SQL_0183).toMatch(/DO \$desdesiempre0183\$/);
    expect(SQL_0183).toMatch(/END \$desdesiempre0183\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0183.split('\n').slice(0, 14).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12365/);
    expect(cabecera).toMatch(/HU #12374/);
    expect(cabecera).toMatch(/RN-10/);
  });

  it('el número es 0183, sigue a la 0182 sin hueco y no colisiona', () => {
    // No exige «es la última»: eso congela el tip y cayó con la 0184 (#12375). max+1 EN SU MOMENTO.
    const sqls = readdirSync(path.resolve(__dirname, '../../src/db/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0183_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0182_tarifas_vigencias\.sql$/);
  });

  it('un solo UPDATE: al epoch, antes del applied_at de la 0182 (literal solo de respaldo), idempotente, sin rangos vacíos a ambos lados, solo la más antigua de la llave; fijado_en intacto', () => {
    expect(SIN_COMENTARIOS.match(/UPDATE flito_tarifas_vigencias/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`SET vigente_desde = '${EPOCH}'`));
    // El corte es el instante en que la 0182 se aplicó EN ESTA BASE; el literal es COALESCE de respaldo.
    expect(SIN_COMENTARIOS).toMatch(new RegExp(
      `vigente_desde < COALESCE\\(\\s*\\(SELECT m\\.applied_at FROM _kyverum_applied_migrations m\\s*WHERE m\\.filename = '${REGISTRO_0182}'\\),\\s*'${CORTE}'\\)`,
    ));
    expect(SIN_COMENTARIOS).not.toMatch(new RegExp(`vigente_desde < '${CORTE}'`));
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`vigente_desde <> '${EPOCH}'`));
    expect(SIN_COMENTARIOS).toMatch(/vigente_hasta IS NULL OR v\.vigente_hasta > v\.vigente_desde/);
    // La guarda excluye los rangos vacíos igual que el UPDATE: una [t, t) más antigua no bloquea su llave.
    expect(SIN_COMENTARIOS).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM flito_tarifas_vigencias o[\s\S]*?\(o\.vigente_hasta IS NULL OR o\.vigente_hasta > o\.vigente_desde\)[\s\S]*?o\.vigente_desde < v\.vigente_desde\)/);
    expect(SIN_COMENTARIOS).not.toMatch(/fijado_en\s*=/);
    expect(SIN_COMENTARIOS).not.toMatch(/vigente_hasta\s*=/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0183: /);
  });
});

// ─────────────────────────────── Contra la base real ───────────────────────────────

interface FilaVieja { concepto: string; tipo: string | null; valor: number; activo?: boolean; creada: string; actualizada?: string }

describe.skipIf(!URL_BASE)('0183 — contra la base real (desde siempre, solape, idempotencia, resolución)', () => {
  let sql: postgres.Sql;
  let uid: number | null = null;

  beforeAll(async () => {
    sql = abrirBase();
    uid = (await sql`SELECT min(id)::int AS id FROM users`)[0]!.id ?? null;
  });
  afterAll(async () => { await sql?.end(); });

  /** Compañía desechable con sus tarifas del modelo viejo, ya desdobladas por la 0182 (sin 0183 aún). */
  async function migrada(tx: postgres.TransactionSql, nombre: string, filas: FilaVieja[]): Promise<number> {
    await tx.unsafe(DDL_0110);
    const c = await companiaDesechable(tx, nombre);
    for (const f of filas) {
      await tx`INSERT INTO flito_tarifas_compania (compania_id, concepto, tipo_tramite, valor, activo, actualizado_por_id, created_at, updated_at)
        VALUES (${c}, ${f.concepto}, ${f.tipo}, ${f.valor}, ${f.activo ?? true}, ${uid}, ${f.creada}, ${f.actualizada ?? f.creada})`;
    }
    await tx.unsafe(SQL_0182);
    return c;
  }

  const vigenciasDe = (tx: postgres.TransactionSql, companiaId: number) => tx`
    SELECT concepto, tipo_tramite, valor::float8 AS valor, vigente_desde, vigente_hasta, fijado_en
      FROM flito_tarifas_vigencias WHERE compania_id = ${companiaId} ORDER BY concepto, tipo_tramite NULLS FIRST, vigente_desde`;
  const iso = (d: unknown) => new Date(d as string).toISOString();

  it('la compañía 3 de verdad: la única tarifa activa (creada 2026-08-12) pasa a regir desde 2000-01-01, fijado_en no se mueve, y la segunda pasada no toca nada', async () => {
    await enTx(sql, async (tx) => {
      const a = await migrada(tx, 'A', [
        { concepto: 'tramite_digital', tipo: null, valor: 250000, creada: '2026-08-12T22:14:00Z' },
        { concepto: 'logistica', tipo: null, valor: 45000, creada: '2026-08-12T22:14:00Z' },
      ]);
      const antes = await vigenciasDe(tx, a);
      expect(antes).toHaveLength(4);
      for (const f of antes) expect(iso(f.vigente_desde)).toBe('2026-08-12T22:14:00.000Z');

      await tx.unsafe(SQL_0183);
      const despues = await vigenciasDe(tx, a);
      expect(despues).toHaveLength(4);
      for (const f of despues) {
        expect(iso(f.vigente_desde)).toBe('2000-01-01T00:00:00.000Z');
        expect(f.vigente_hasta).toBeNull();
        expect(iso(f.fijado_en)).toBe('2026-08-12T22:14:00.000Z');
      }
      // Idempotencia fuerte: huella idéntica tras la segunda pasada.
      const huella = async () => (await tx`SELECT md5(string_agg(compania_id||concepto||coalesce(tipo_tramite,'')||valor||vigente_desde||coalesce(vigente_hasta::text,'')||fijado_en, ',' ORDER BY compania_id, concepto, tipo_tramite, vigente_desde)) AS h, count(*)::int AS n FROM flito_tarifas_vigencias`)[0];
      const h1 = await huella();
      await tx.unsafe(SQL_0183);
      expect(await huella()).toEqual(h1);
    });
  }, 60_000);

  it('un trámite aprobado en 2026-05 (antes del created_at migrado) resuelve el valor migrado con la expresión REAL del código (vigenteEn)', async () => {
    const { flitoTarifasVigencias: v } = await import('../../src/db/schema.js');
    const { vigenteEn } = await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');
    await enTx(sql, async (tx) => {
      const a = await migrada(tx, 'B', [{ concepto: 'tramite_digital', tipo: 'Matricula', valor: 250000, creada: '2026-08-12T22:14:00Z' }]);
      const consulta = (fecha: Date) => renderizar(and(
        eq(v.companiaId, a), eq(v.concepto, 'tramite_digital'), eq(v.tipoTramite, 'MATRICULA'), vigenteEn(v, fecha),
      )!);
      const valorEn = async (fecha: Date) => {
        const { sql: where, params } = consulta(fecha);
        const filas = await tx.unsafe(`SELECT valor::float8 AS valor FROM flito_tarifas_vigencias WHERE ${where}`, params as never[]);
        return filas.map((f) => f.valor as number);
      };
      const mayo = new Date('2026-05-15T12:00:00Z');
      // Antes de la 0183: la fecha cae fuera de [2026-08-12, ∞) → «sin configurar» (el R1 del diseño).
      expect(await valorEn(mayo)).toEqual([]);
      await tx.unsafe(SQL_0183);
      expect(await valorEn(mayo)).toEqual([250000]);
      expect(await valorEn(new Date('2026-09-01T12:00:00Z'))).toEqual([250000]);
      // Y antes del epoch sigue sin haber nada: «desde siempre» es finito a propósito.
      expect(await valorEn(new Date('1999-12-31T23:59:59Z'))).toEqual([]);
    });
  }, 60_000);

  it('solape: una migrada CERRADA más una abierta por la API nueva → solo la cerrada (la más antigua) se mueve, la EXCLUDE no salta', async () => {
    await enTx(sql, async (tx) => {
      const c = await migrada(tx, 'C', [
        { concepto: 'logistica', tipo: null, valor: 15000, activo: false, creada: '2026-03-01T00:00:00Z', actualizada: '2026-04-01T00:00:00Z' },
      ]);
      // La API nueva abre otra después del corte (fijarTarifa usa now()).
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica', NULL, 50000, '2026-09-11T10:00:00Z', '2026-09-11T10:00:00Z')`;
      await tx.unsafe(SQL_0183);
      const filas = await vigenciasDe(tx, c);
      expect(filas).toHaveLength(2);
      expect(iso(filas[0]!.vigente_desde)).toBe('2000-01-01T00:00:00.000Z');
      expect(iso(filas[0]!.vigente_hasta)).toBe('2026-04-01T00:00:00.000Z');
      expect(iso(filas[1]!.vigente_desde)).toBe('2026-09-11T10:00:00.000Z');
      expect(filas[1]!.vigente_hasta).toBeNull();
    });
  }, 60_000);

  it('la guarda «más antigua por llave» de verdad: DOS vigencias anteriores al corte en la MISMA llave → solo la más antigua se mueve y la EXCLUDE no dispara', async () => {
    // La 0182 deja a lo sumo UNA vigencia por llave (elige por prioridad), así que este estado no sale
    // del desdoble: se inserta a mano en flito_tarifas_vigencias DESPUÉS de la 0182 y ANTES de la 0183,
    // con los dos `vigente_desde` anteriores al corte. Es el estado que la guarda NOT EXISTS protege:
    // sin ella el UPDATE llevaría las dos a 2000-01-01 y la EXCLUDE (23P01) tumbaría la migración.
    await enTx(sql, async (tx) => {
      const g = await migrada(tx, 'G', [
        { concepto: 'logistica', tipo: null, valor: 15000, activo: false, creada: '2026-03-01T00:00:00Z', actualizada: '2026-04-01T00:00:00Z' },
      ]);
      // Segunda de la misma llave (logistica, sin tipo), abierta desde el 05-01: anterior al corte, sin solape.
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${g}, 'logistica', NULL, 20000, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`;
      const antes = await vigenciasDe(tx, g);
      expect(antes.map((f) => iso(f.vigente_desde))).toEqual(['2026-03-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z']);

      const codigo = await tx.unsafe(SQL_0183).then(() => null, (e: { code?: string }) => e.code ?? 'sin código');
      expect(codigo, 'la 0183 no debe fallar (23P01 = las dos se movieron y solaparon)').toBeNull();

      const despues = await vigenciasDe(tx, g);
      expect(despues).toHaveLength(2);
      expect(iso(despues[0]!.vigente_desde)).toBe('2000-01-01T00:00:00.000Z');
      expect(iso(despues[0]!.vigente_hasta)).toBe('2026-04-01T00:00:00.000Z');
      expect(despues[0]!.valor).toBe(15000);
      expect(iso(despues[1]!.vigente_desde)).toBe('2026-05-01T00:00:00.000Z');
      expect(despues[1]!.vigente_hasta).toBeNull();
      expect(despues[1]!.valor).toBe(20000);
    });
  }, 60_000);

  it('QA/PDN: con la 0182 REGISTRADA en _kyverum_applied_migrations, el corte es su applied_at — una tarifa vieja creada después del literal fijo también pasa a «desde siempre»', async () => {
    // El código viejo sigue escribiendo flito_tarifas_compania hasta el deploy que aplica la 0182: una
    // tarifa creada el 2026-09-15 migra con vigente_desde = 2026-09-15 (> literal), y solo el
    // applied_at real de la 0182 (posterior) la reconoce como migrada. Se simula registrando la 0182
    // en la tabla del runner dentro de la transacción, con applied_at posterior a esa vigencia.
    await enTx(sql, async (tx) => {
      const h = await migrada(tx, 'H', [
        { concepto: 'tramite_digital', tipo: 'Traspaso', valor: 250000, creada: '2026-09-15T10:00:00Z' },
      ]);
      await tx`INSERT INTO _kyverum_applied_migrations (filename, sha256, applied_at)
        VALUES (${REGISTRO_0182}, 'test', '2026-09-20T12:00:00Z')
        ON CONFLICT (filename) DO UPDATE SET applied_at = EXCLUDED.applied_at`;
      // Y una abierta por la API nueva DESPUÉS del applied_at, que no debe tocarse.
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${h}, 'tramite_digital', 'OTROS', 1000, '2026-09-21T09:00:00Z', '2026-09-21T09:00:00Z')`;
      await tx.unsafe(SQL_0183);
      const filas = await vigenciasDe(tx, h);
      const por = Object.fromEntries(filas.map((f) => [f.tipo_tramite, f]));
      expect(iso(por['TRASPASO']!.vigente_desde)).toBe('2000-01-01T00:00:00.000Z');
      expect(iso(por['OTROS']!.vigente_desde)).toBe('2026-09-21T09:00:00.000Z');
      // Segunda pasada: 0 filas (huella idéntica).
      const huella = async () => (await tx`SELECT md5(string_agg(id::text||vigente_desde::text, ',' ORDER BY id)) AS h FROM flito_tarifas_vigencias`)[0]!.h;
      const h1 = await huella();
      await tx.unsafe(SQL_0183);
      expect(await huella()).toBe(h1);
    });
  }, 60_000);

  it('una vigencia migrada con rango vacío [t, t) (creada inactiva y nunca activada) NO se abre hacia el pasado', async () => {
    await enTx(sql, async (tx) => {
      const d = await migrada(tx, 'D', [
        { concepto: 'logistica', tipo: null, valor: 15000, activo: false, creada: '2026-03-01T00:00:00Z', actualizada: '2026-03-01T00:00:00Z' },
      ]);
      await tx.unsafe(SQL_0183);
      const [f] = await vigenciasDe(tx, d);
      expect(iso(f!.vigente_desde)).toBe('2026-03-01T00:00:00.000Z');
      expect(iso(f!.vigente_hasta)).toBe('2026-03-01T00:00:00.000Z');
    });
  }, 60_000);

  it('una vigencia abierta por la API nueva (después del corte) no se toca aunque sea la única de su llave', async () => {
    await enTx(sql, async (tx) => {
      await tx.unsafe(SQL_0182);
      const e = await companiaDesechable(tx, 'E');
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${e}, 'tramite_digital', 'OTROS', 1000, '2026-09-10T18:00:00Z', '2026-09-10T18:00:00Z')`;
      await tx.unsafe(SQL_0183);
      const [f] = await vigenciasDe(tx, e);
      expect(iso(f!.vigente_desde)).toBe('2026-09-10T18:00:00.000Z');
    });
  }, 60_000);
});
