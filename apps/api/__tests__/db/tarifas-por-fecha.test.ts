// HU #12374 — el reporte de costos resuelve la tarifa por la FECHA DE APROBACIÓN, contra PostgreSQL.
//
// Se ejecuta el SQL REAL del reporte (`SELECT_FILA` + `conJoins` + `condiciones`, renderizado por
// Drizzle), no una copia: el mock `chain` ignora el ON del join y devolvería la fila entera con
// cualquier predicado. Todo en UNA transacción con ROLLBACK sobre la base local: se recrea la 0110,
// se corre la 0182 y la 0183 sobre lo que haya, y encima van los fixtures de esta HU con vigencias
// explícitas. La base queda como estaba.
//
// Cubre AC1-AC6, AC8, AC10 y el borde `[)` (mutante M2: con `'[]'` el instante del cambio cae en
// DOS vigencias, el join duplica la fila y `count(*)` da 2). Mutante M1 (resolver con `now()`): el
// aprobado en julio saldría 300000 y el de agosto 250000. Mutante M3 (logística sin fecha): la fila
// de agosto daría 50000.
//
// Se activa con TEST_DATABASE_URL; sin ella se SALTA (el CI no levanta Postgres). TZ=UTC: los
// fixtures son instantes ISO con Z y se comparan como tales.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { and, inArray } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { abrirBase, companiaDesechable, DDL_0110, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { condiciones, conJoins, SELECT_FILA } = await import('../../src/modules/finanzas/finanzas.service.js');
const { flitoTramites } = await import('../../src/db/schema.js');
type Filtros = Parameters<typeof condiciones>[0];

const SQL_0182 = leerMigracion('0182_tarifas_vigencias.sql');
const SQL_0183 = leerMigracion('0183_tarifas_vigencias_desde_siempre.sql');

// Drizzle proyecta SIN alias y mapea la fila por POSICIÓN, en el orden de las claves del objeto.
// Aquí se hace lo mismo: `.values()` de postgres.js y el índice de cada clave en SELECT_FILA.
const CLAVES = Object.keys(SELECT_FILA);
const col = (nombre: keyof typeof SELECT_FILA) => {
  const i = CLAVES.indexOf(nombre);
  if (i < 0) throw new Error(`SELECT_FILA no proyecta ${String(nombre)}`);
  return i;
};

interface FilaCruda { tramiteId: string; tramiteDigital: number | null; logistica: number | null; sellada: boolean; gestionaLogistica: boolean }

describe.skipIf(!URL_BASE)('reporte de costos — la tarifa estimada es la vigente en la fecha de aprobación (HU #12374)', () => {
  let sql: postgres.Sql;
  let vehiculoId: number;
  let nVigenciasAntes: number | null;

  /** Cuántas vigencias hay FUERA de toda transacción (null si la 0182 no está aplicada en esta base). */
  async function huellaBase(): Promise<number | null> {
    const [r] = await sql`SELECT to_regclass('public.flito_tarifas_vigencias') IS NOT NULL AS existe`;
    if (!r!.existe) return null;
    return (await sql`SELECT count(*)::int AS n FROM flito_tarifas_vigencias`)[0]!.n as number;
  }

  beforeAll(async () => {
    sql = abrirBase();
    nVigenciasAntes = await huellaBase();
  });
  afterAll(async () => { await sql?.end(); });

  /** El SQL real del reporte sobre estos ids, ejecutado en la transacción. */
  async function reporte(tx: postgres.TransactionSql, ids: string[], filtros: Filtros = {}): Promise<FilaCruda[]> {
    const q = conJoins(new QueryBuilder().select(SELECT_FILA).from(flitoTramites).$dynamic())
      .where(and(inArray(flitoTramites.id, ids), ...condiciones(filtros)));
    const { sql: texto, params } = q.toSQL();
    expect(params.filter((p) => p instanceof Date)).toHaveLength(0);
    const filas = await tx.unsafe(texto, params as never[]).values();
    for (const f of filas) expect(f).toHaveLength(CLAVES.length);
    const num = (x: unknown) => (x === null ? null : Number(x));
    return filas.map((f) => ({
      tramiteId: f[col('tramiteId')] as string,
      tramiteDigital: num(f[col('tramiteDigital')]),
      logistica: num(f[col('logistica')]),
      sellada: Boolean(f[col('sellada')]),
      gestionaLogistica: Boolean(f[col('gestionaLogistica')]),
    }));
  }

  /** Base: 0110 recreada + 0182 + 0183 sobre lo que haya, un vehículo desechable. */
  async function preparar(tx: postgres.TransactionSql) {
    await tx.unsafe(DDL_0110);
    await tx.unsafe(SQL_0182);
    await tx.unsafe(SQL_0183);
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES ('HU12374', ${`VIN12374${String(Date.now()).slice(-9)}`}) RETURNING id`;
    vehiculoId = v!.id as number;
  }

  let n = 0;
  /** Trámite aprobado en `aprobado` (o sin aprobar) con recibo de derecho, para que solo la tarifa pueda bloquear. */
  async function tramite(tx: postgres.TransactionSql, companiaId: number, tipo: string, aprobado: string | null): Promise<string> {
    n += 1;
    const [t] = await tx`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id, tipo_tramite, fecha_aprobacion, flit_estado)
      VALUES (${`HU12374-${Date.now()}-${n}`}, ${vehiculoId}, now(), ${companiaId}, ${tipo}, ${aprobado}, 'Aprobado') RETURNING id`;
    await tx`INSERT INTO flito_derechos_tramite (tramite_id, compania_id, origen, valor) VALUES (${t!.id}, ${companiaId}, 'manual', 80000)`;
    return t!.id as string;
  }

  interface Vig { concepto: 'tramite_digital' | 'logistica'; tipo?: string; valor: number; desde: string; hasta?: string | null }
  async function vigencia(tx: postgres.TransactionSql, companiaId: number, v: Vig): Promise<void> {
    await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, cerrado_en, fijado_en)
      VALUES (${companiaId}, ${v.concepto}, ${v.tipo ?? null}, ${v.valor}, ${v.desde}, ${v.hasta ?? null}, ${v.hasta ?? null}, ${v.desde})`;
  }

  const X = '2026-09-08T10:00:00Z';

  it('AC1, AC2, borde [), AC3 y AC6: cada trámite toma la vigencia que contiene su aprobación; sin aprobar, la de ahora; y ninguna fila se duplica (AC10)', async () => {
    await enTx(sql, async (tx) => {
      await preparar(tx);
      const a = await companiaDesechable(tx, 'A', { logistica: false });
      const b = await companiaDesechable(tx, 'B', { logistica: true });
      // AC1: MATRICULA 270000 [06-01, 09-01) y 300000 [09-01, ∞).
      await vigencia(tx, a, { concepto: 'tramite_digital', tipo: 'MATRICULA', valor: 270000, desde: '2026-06-01T00:00:00Z', hasta: '2026-09-01T00:00:00Z' });
      await vigencia(tx, a, { concepto: 'tramite_digital', tipo: 'MATRICULA', valor: 300000, desde: '2026-09-01T00:00:00Z' });
      // AC2: TRASPASO 200000 → 250000 en el MISMO instante X (RN-01).
      await vigencia(tx, a, { concepto: 'tramite_digital', tipo: 'TRASPASO', valor: 200000, desde: '2026-06-01T00:00:00Z', hasta: X });
      await vigencia(tx, a, { concepto: 'tramite_digital', tipo: 'TRASPASO', valor: 250000, desde: X });
      // AC3: OTROS abierta 150000.
      await vigencia(tx, a, { concepto: 'tramite_digital', tipo: 'OTROS', valor: 150000, desde: '2026-06-01T00:00:00Z' });
      // AC6: logística 45000 [06-01, 09-01) y 50000 [09-01, ∞), en A y en B (B la autogestiona).
      for (const c of [a, b]) {
        await vigencia(tx, c, { concepto: 'logistica', valor: 45000, desde: '2026-06-01T00:00:00Z', hasta: '2026-09-01T00:00:00Z' });
        await vigencia(tx, c, { concepto: 'logistica', valor: 50000, desde: '2026-09-01T00:00:00Z' });
      }

      const t = {
        matJul: await tramite(tx, a, 'Matricula', '2026-07-15T12:00:00Z'),
        matSep: await tramite(tx, a, 'Matricula', '2026-09-05T12:00:00Z'),
        traAgo: await tramite(tx, a, 'Traspaso', '2026-08-10T12:00:00Z'),
        traSep: await tramite(tx, a, 'Traspaso', '2026-09-09T12:00:00Z'),
        traX: await tramite(tx, a, 'Traspaso', X),
        otrosSinFecha: await tramite(tx, a, 'Otros', null),
        autogestionaLg: await tramite(tx, b, 'Matricula', '2026-08-05T12:00:00Z'),
      };
      const ids = Object.values(t);
      const filas = await reporte(tx, ids);
      // AC10: una fila por trámite aunque cada llave tenga varias vigencias históricas.
      expect(filas).toHaveLength(ids.length);
      expect(new Set(filas.map((f) => f.tramiteId)).size).toBe(ids.length);
      const por = Object.fromEntries(filas.map((f) => [f.tramiteId, f]));

      // AC1
      expect(por[t.matJul]).toMatchObject({ tramiteDigital: 270000, sellada: false });
      expect(por[t.matSep]).toMatchObject({ tramiteDigital: 300000, sellada: false });
      // AC2
      expect(por[t.traAgo]!.tramiteDigital).toBe(200000);
      expect(por[t.traSep]!.tramiteDigital).toBe(250000);
      // Borde [): el instante del cambio pertenece a la vigencia NUEVA, y es UNA fila.
      expect(por[t.traX]!.tramiteDigital).toBe(250000);
      expect(filas.filter((f) => f.tramiteId === t.traX)).toHaveLength(1);
      // AC6: logística por fecha en A; «no aplica» en B (gestiona_logistica = false), sin importar la vigencia.
      expect(por[t.matJul]).toMatchObject({ logistica: 45000, gestionaLogistica: true });
      expect(por[t.matSep]).toMatchObject({ logistica: 50000, gestionaLogistica: true });
      expect(por[t.autogestionaLg]).toMatchObject({ logistica: null, gestionaLogistica: false });

      // AC3: sin fecha → la abierta ahora (150000); se cambia (cierre + apertura en el mismo instante,
      // 1 s antes del now() de la transacción para que el rango nuevo lo contenga) → 160000.
      expect(por[t.otrosSinFecha]!.tramiteDigital).toBe(150000);
      await tx`UPDATE flito_tarifas_vigencias SET vigente_hasta = now() - interval '1 second', cerrado_en = now()
        WHERE compania_id = ${a} AND concepto = 'tramite_digital' AND tipo_tramite = 'OTROS'`;
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde)
        VALUES (${a}, 'tramite_digital', 'OTROS', 160000, now() - interval '1 second')`;
      const [otros] = await reporte(tx, [t.otrosSinFecha]);
      expect(otros!.tramiteDigital).toBe(160000);
      // AC2 (segunda mitad): el cambio de OTROS no movió a los que sí tienen fecha.
      const otraVez = Object.fromEntries((await reporte(tx, ids)).map((f) => [f.tramiteId, f]));
      expect(otraVez[t.matJul]!.tramiteDigital).toBe(270000);
      expect(otraVez[t.traAgo]!.tramiteDigital).toBe(200000);
    });
  }, 60_000);

  it('AC4 y AC5: fecha antes de la primera vigencia o en un hueco → «no configurado» (NULL, nunca 0), incompleto y fuera de la cola de listos', async () => {
    await enTx(sql, async (tx) => {
      await preparar(tx);
      const c = await companiaDesechable(tx, 'C', { logistica: true });
      // AC4: la primera TRASPASO empieza el 09-01.
      await vigencia(tx, c, { concepto: 'tramite_digital', tipo: 'TRASPASO', valor: 250000, desde: '2026-09-01T00:00:00Z' });
      // AC5: MATRICULA [06-01, 08-01) y [08-20, ∞): hueco del 1 al 20 de agosto.
      await vigencia(tx, c, { concepto: 'tramite_digital', tipo: 'MATRICULA', valor: 270000, desde: '2026-06-01T00:00:00Z', hasta: '2026-08-01T00:00:00Z' });
      await vigencia(tx, c, { concepto: 'tramite_digital', tipo: 'MATRICULA', valor: 280000, desde: '2026-08-20T00:00:00Z' });

      const antes = await tramite(tx, c, 'Traspaso', '2026-08-20T12:00:00Z');
      const hueco = await tramite(tx, c, 'Matricula', '2026-08-10T12:00:00Z');
      const bien = await tramite(tx, c, 'Matricula', '2026-08-25T12:00:00Z');
      const ids = [antes, hueco, bien];

      const por = Object.fromEntries((await reporte(tx, ids)).map((f) => [f.tramiteId, f]));
      expect(por[antes]!.tramiteDigital).toBeNull();
      expect(por[hueco]!.tramiteDigital).toBeNull();
      expect(por[bien]!.tramiteDigital).toBe(280000);
      // La cola de listos y la de incompletos se mueven con el MISMO join (sin segunda definición).
      const listos = (await reporte(tx, ids, { etapa: 'listo' })).map((f) => f.tramiteId);
      const incompletos = (await reporte(tx, ids, { etapa: 'incompleto' })).map((f) => f.tramiteId);
      expect(listos).toEqual([bien]);
      expect(incompletos.sort()).toEqual([antes, hueco].sort());
    });
  }, 60_000);

  it('AC8: la fila sellada sigue leyendo flito_liquidaciones aunque la vigencia cambie a 999999', async () => {
    await enTx(sql, async (tx) => {
      await preparar(tx);
      const d = await companiaDesechable(tx, 'D', { logistica: true });
      await vigencia(tx, d, { concepto: 'tramite_digital', tipo: 'MATRICULA', valor: 270000, desde: '2026-06-01T00:00:00Z' });
      const sellado = await tramite(tx, d, 'Matricula', '2026-07-15T12:00:00Z');
      await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, valor_derecho, valor_tramite_digital, base_gmf, tasa_gmf, valor_gmf, total, liquidado_en)
        VALUES (${sellado}, 'liquidado', 80000, 270000, 350000, 0.004, 1400, 351400, '2026-09-01T12:00:00Z')`;
      await tx`UPDATE flito_tarifas_vigencias SET valor = 999999 WHERE compania_id = ${d}`;
      const [fila] = await reporte(tx, [sellado]);
      expect(fila).toMatchObject({ sellada: true, tramiteDigital: 270000 });
      // Y un trámite sin sellar de la misma llave sí ve el cambio: la diferencia es la liquidación, no la fecha.
      const vivo = await tramite(tx, d, 'Matricula', '2026-07-15T12:00:00Z');
      const [estimada] = await reporte(tx, [vivo]);
      expect(estimada).toMatchObject({ sellada: false, tramiteDigital: 999999 });
    });
  }, 60_000);

  it('la base queda como estaba (todo vivió dentro de transacciones con ROLLBACK)', async () => {
    expect(await huellaBase()).toBe(nVigenciasAntes);
    expect((await sql`SELECT count(*)::int AS n FROM clients WHERE name LIKE 'HU12374 %'`)[0]!.n).toBe(0);
  });
});
