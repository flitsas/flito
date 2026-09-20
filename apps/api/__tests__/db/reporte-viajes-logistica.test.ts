// HU #12627 — la columna «Logística» como tarifa + viajes y la cantidad de viajes, contra PostgreSQL
// de verdad (AC1–AC6).
//
// Es el ÚNICO sitio donde este SQL se EJECUTA (calco de `reporte-servicios-adicionales.test.ts`): el
// mock `chain` ignora el `where` y los joins, y el CI no levanta Postgres. Sin este archivo viajarían
// hasta DEV: el 42803 del consolidado (subconsulta con parámetro dentro del GROUP BY), el 22023 de un
// `::int` sobre un detalle que no es array, y el ABANICO (un `leftJoin` a la tabla de viajes
// duplicaría la fila de un trámite con dos viajes, y con ella el dinero de los totales).
//
// Todo dentro de UNA transacción que termina en ROLLBACK: la 0199 (la tabla de viajes) se aplica ahí
// dentro. Se activa con TEST_DATABASE_URL; sin ella se SALTA.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { and, inArray } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { condiciones, conJoins, SELECT_FILA } = await import('../../src/modules/finanzas/finanzas.service.js');
const { ensamblarConsolidado, selectConsolidado } = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const { flitoTramites } = await import('../../src/db/schema.js');

const SQL_0199 = leerMigracion('0199_tramite_viajes_logistica.sql');

// Drizzle proyecta SIN alias y mapea por POSICIÓN: aquí se hace lo mismo.
const CLAVES = Object.keys(SELECT_FILA);
const col = (nombre: keyof typeof SELECT_FILA) => {
  const i = CLAVES.indexOf(nombre);
  if (i < 0) throw new Error(`SELECT_FILA no proyecta ${String(nombre)}`);
  return i;
};
const CLAVES_CONS = Object.keys(selectConsolidado('mes'));
const colCons = (nombre: string) => {
  const i = CLAVES_CONS.indexOf(nombre);
  if (i < 0) throw new Error(`selectConsolidado no proyecta ${nombre}`);
  return i;
};

const num = (x: unknown) => (x === null ? null : Number(x));

describe.skipIf(!URL_BASE)('reporte de costos — logística = tarifa + viajes, contra PostgreSQL (HU #12627)', () => {
  let sql: postgres.Sql;

  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  const SELLO = String(Date.now()).slice(-9);
  const NIT = `12627-${SELLO}`;
  const NIT_SIN_TARIFA = `12627s-${SELLO}`;
  const NIT_AUTO = `12627a-${SELLO}`;

  interface Fixtures {
    conViajes: string; sinViajes: string; selladaNueva: string; selladaVieja: string; selladaSinAdicionales: string;
    selladaEscalar: string; sinTarifa: string; autogestiona: string;
  }

  /** 0199 aplicada, tres compañías desechables (con tarifa, sin tarifa, autogestiona) y los casos de la HU. */
  async function preparar(tx: postgres.TransactionSql): Promise<Fixtures> {
    await tx.unsafe(SQL_0199);
    const compania = async (nit: string, autogestiona: boolean): Promise<number> => {
      const [c] = await tx`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
        VALUES (${`HU12627 ${nit}`}, ${nit}, true, true, ${autogestiona}) RETURNING id`;
      return c!.id as number;
    };
    const conTarifa = await compania(NIT, false);
    const sinTarifa = await compania(NIT_SIN_TARIFA, false);
    const auto = await compania(NIT_AUTO, true);
    // La tarifa de logística (viaje 1): 35.000 vigente desde antes de la aprobación, sin tipo (RN-03).
    await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
      VALUES (${conTarifa}, 'logistica', NULL, 35000, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`H12627${SELLO.slice(-3)}`}, ${`VIN12627${SELLO}`}) RETURNING id`;

    let n = 0;
    const tramite = async (companiaId: number, nit: string): Promise<string> => {
      n += 1;
      const [t] = await tx`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id, compania_nit, tipo_tramite, fecha_aprobacion, flit_estado)
        VALUES (${`HU12627-${SELLO}-${n}`}, ${v!.id}, now(), ${companiaId}, ${nit}, 'Traspaso', '2026-09-10T12:00:00Z', 'Aprobado') RETURNING id`;
      await tx`INSERT INTO flito_derechos_tramite (tramite_id, compania_id, origen, valor) VALUES (${t!.id}, ${companiaId}, 'manual', 80000)`;
      return t!.id as string;
    };
    const viaje = async (tramiteId: string, numero: number, valor: number) => {
      await tx`INSERT INTO flito_tramite_viajes_logistica (tramite_id, numero, modo, valor, tarifa_vigente, motivo)
        VALUES (${tramiteId}, ${numero}, 'manual', ${valor}, 35000, 'devolucion')`;
    };
    const sellar = async (tramiteId: string, valorLogistica: number | null, detalle: unknown) => {
      const base = 80000 + (valorLogistica ?? 0);
      await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, valor_derecho, valor_logistica, base_gmf, valor_gmf, total, detalle)
        VALUES (${tramiteId}, 'liquidado', 80000, ${valorLogistica}, ${base}, ${base * 0.004}, ${base * 1.004}, ${tx.json(detalle as never)})`;
    };
    const snapshot = (numero: number, valor: number) => ({
      id: `v${numero}`, numero, modo: 'manual', valor, tarifaVigente: 35000, motivo: 'devolucion',
      motivoDetalle: null, registradoPorNombre: 'Ana', registradoEn: '2026-09-11T10:00:00.000Z',
    });
    const derecho = { valor: 80000, origen: 'Recibo de derecho de tránsito', bloquea: false };

    // AC1: tarifa + 35.000 + 20.000 = 90.000, 3 viajes.
    const conViajes = await tramite(conTarifa, NIT);
    await viaje(conViajes, 2, 35000);
    await viaje(conViajes, 3, 20000);
    // AC2/AC5: tarifa y cero viajes → 35.000, 1 viaje.
    const sinViajes = await tramite(conTarifa, NIT);
    // AC4/AC5: sellada POR la HU #12626 con 90.000 y dos snapshots; la tabla viva trae OTRA cosa
    // (un viaje de 999.999) que NO debe sumarse ni contarse.
    const selladaNueva = await tramite(conTarifa, NIT);
    await viaje(selladaNueva, 2, 999999);
    await sellar(selladaNueva, 90000, {
      derecho,
      logistica: { valor: 90000, origen: 'Tarifa + 2 viajes adicionales', bloquea: false, tarifa: 35000, viajes: [snapshot(2, 35000), snapshot(3, 20000)], totalViajes: 3 },
    });
    // AC4/AC5: sellada ANTES (sin la clave `viajes`) con 35.000; la tabla viva trae viajes que no se suman.
    const selladaVieja = await tramite(conTarifa, NIT);
    await viaje(selladaVieja, 2, 40000);
    await sellar(selladaVieja, 35000, { derecho, logistica: { valor: 35000, origen: 'Tarifa', bloquea: false } });
    // AC5: sellada por la HU #12626 SIN adicionales: `viajes: []`, totalViajes 1.
    const selladaSinAdicionales = await tramite(conTarifa, NIT);
    await sellar(selladaSinAdicionales, 35000, { derecho, logistica: { valor: 35000, origen: 'Tarifa', bloquea: false, tarifa: 35000, viajes: [], totalViajes: 1 } });
    // Robustez: un detalle con `viajes` ESCALAR. Sin el `jsonb_typeof`, el reporte entero moriría.
    const selladaEscalar = await tramite(conTarifa, NIT);
    await sellar(selladaEscalar, 35000, { derecho, logistica: { valor: 35000, origen: 'Tarifa', bloquea: false, viajes: 5, totalViajes: 5 } });
    // AC2: compañía SIN tarifa de logística y con un viaje manual → NULL («no configurado»), no 20.000.
    const sinTarifaT = await tramite(sinTarifa, NIT_SIN_TARIFA);
    await viaje(sinTarifaT, 2, 20000);
    // AC3: autogestiona sin excepción, con filas huérfanas → NULL y 0 viajes.
    const autogestiona = await tramite(auto, NIT_AUTO);
    await viaje(autogestiona, 2, 35000);
    await viaje(autogestiona, 3, 35000);

    return {
      conViajes, sinViajes, selladaNueva, selladaVieja, selladaSinAdicionales, selladaEscalar,
      sinTarifa: sinTarifaT, autogestiona,
    };
  }

  /** El SQL REAL del detalle sobre esos ids. */
  async function detalle(tx: postgres.TransactionSql, ids: string[]) {
    const q = conJoins(new QueryBuilder().select(SELECT_FILA).from(flitoTramites).$dynamic())
      .where(and(inArray(flitoTramites.id, ids), ...condiciones({})));
    const { sql: texto, params } = q.toSQL();
    const filas = await tx.unsafe(texto, params as never[]).values();
    return filas.map((f) => ({
      tramiteId: f[col('tramiteId')] as string,
      sellada: Boolean(f[col('sellada')]),
      gestionaLogistica: Boolean(f[col('gestionaLogistica')]),
      logistica: num(f[col('logistica')]),
      cantidad: num(f[col('logisticaViajesCantidad')]),
      gmf: num(f[col('gmf')]),
      total: num(f[col('totalFila')]),
    }));
  }

  it('AC1–AC5: la estimada suma tarifa + viajes; sin tarifa o sin gestionar, NULL; la sellada lee su columna y su snapshot', async () => {
    await enTx(sql, async (tx) => {
      const f = await preparar(tx);
      const ids = Object.values(f);
      const filas = await detalle(tx, ids);
      const por = (id: string) => filas.find((x) => x.tramiteId === id)!;

      // EL ABANICO: ocho trámites, ocho filas, aunque varios lleven DOS viajes. Un `leftJoin` daría más.
      expect(filas).toHaveLength(8);

      // AC1: 35.000 + 35.000 + 20.000 = 90.000 (mutante «sin la tarifa»: 55.000); el 4x1000 sobre la
      // base CON los viajes: 80.000 + 90.000 = 170.000 → GMF 680, total 170.680. Cantidad 1 + 2 = 3.
      expect(por(f.conViajes).logistica).toBe(90000);
      expect(por(f.conViajes).gmf).toBe(680);
      expect(por(f.conViajes).total).toBe(170680);
      expect(por(f.conViajes).cantidad).toBe(3);

      // AC2/AC5: tarifa y cero viajes → la tarifa a secas y 1 viaje (mutante «olvidar el +1»: 0).
      expect(por(f.sinViajes).logistica).toBe(35000);
      expect(por(f.sinViajes).cantidad).toBe(1);

      // AC2: sin tarifa → NULL aunque haya un viaje manual (mutante «COALESCE(lg.valor, 0) + Σ»: 20.000).
      expect(por(f.sinTarifa).gestionaLogistica).toBe(true);
      expect(por(f.sinTarifa).logistica).toBeNull();
      expect(por(f.sinTarifa).cantidad).toBe(2);

      // AC3: autogestiona sin excepción → NULL y 0 viajes, con dos filas huérfanas en la tabla
      // (mutante «sumar antes del WHEN NOT gestiona»: 70.000 y 3).
      expect(por(f.autogestiona).gestionaLogistica).toBe(false);
      expect(por(f.autogestiona).logistica).toBeNull();
      expect(por(f.autogestiona).cantidad).toBe(0);

      // AC4/AC5: sellada por la HU #12626: la columna (90.000) y el `totalViajes` del snapshot (3);
      // la fila viva de 999.999 no entra (mutante «sumar la tabla viva»: 1.089.999 / 2).
      expect(por(f.selladaNueva).sellada).toBe(true);
      expect(por(f.selladaNueva).logistica).toBe(90000);
      expect(por(f.selladaNueva).cantidad).toBe(3);

      // AC4/AC5: sellada ANTES: 35.000 sellados aunque la tabla viva tenga 40.000 más, y cantidad
      // NULL («no se sabe»), NO 0 ni 1 (mutante «ELSE 0» en el CASE interno).
      expect(por(f.selladaVieja).logistica).toBe(35000);
      expect(por(f.selladaVieja).cantidad).toBeNull();

      // AC5: sellada sin adicionales (`viajes: []`) → 1, del snapshot.
      expect(por(f.selladaSinAdicionales).cantidad).toBe(1);

      // Robustez: `viajes` escalar → NULL sin 22023 (mutante «quitar jsonb_typeof»: la consulta
      // entera fallaría y este `it` no llegaría hasta aquí).
      expect(por(f.selladaEscalar).logistica).toBe(35000);
      expect(por(f.selladaEscalar).cantidad).toBeNull();
    });
  }, 60_000);

  it('AC6: el consolidado AGRUPA con la subconsulta dentro del agregado (sin 42803) y suma la MISMA logística que el detalle', async () => {
    await enTx(sql, async (tx) => {
      const f = await preparar(tx);
      const q = ensamblarConsolidado(
        new QueryBuilder().select(selectConsolidado('mes')).from(flitoTramites).$dynamic(),
        { empresas: [NIT] }, 'mes',
      );
      const { sql: texto, params } = q.toSQL();
      // Si la subconsulta llevara un parámetro, el del SELECT y el del GROUP BY serían `$n`
      // distintos y PostgreSQL rechazaría esto con 42803 — que es exactamente lo que se ejecuta.
      const filas = await tx.unsafe(texto, params as never[]).values();

      expect(filas).toHaveLength(1);
      const g = filas[0]!;
      expect(Number(g[colCons('tramites')])).toBe(6);
      // 90.000 + 35.000 + 90.000 + 35.000 + 35.000 + 35.000 = 320.000: con los viajes de la estimada
      // y sin los de la tabla viva de las selladas (mutante «copia sin viajes»: 265.000).
      expect(Number(g[colCons('logistica')])).toBe(320000);
      // RN-02 sobre el grupo: reintegro + servicio = total, con la logística DENTRO del reintegro.
      const total = Number(g[colCons('total')]);
      const reintegro = Number(g[colCons('totalReintegro')]);
      const servicio = Number(g[colCons('totalServicio')]);
      expect(servicio).toBe(0);
      expect(Math.round((reintegro + servicio) * 100) / 100).toBe(total);
      // Y el total del grupo es el de las seis filas del detalle (CF-13).
      const seis = [f.conViajes, f.sinViajes, f.selladaNueva, f.selladaVieja, f.selladaSinAdicionales, f.selladaEscalar];
      const suma = (await detalle(tx, seis)).reduce((a, x) => a + (x.total ?? 0), 0);
      expect(total).toBe(Math.round(suma * 100) / 100);
    });
  }, 60_000);
});
