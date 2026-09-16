// HU #12546 — la expresión de servicios adicionales del reporte, contra PostgreSQL de verdad.
//
// Es el ÚNICO sitio donde este SQL se EJECUTA. El mock `chain` ignora el `where` y los joins, y el
// CI no levanta Postgres, así que sin este archivo tres clases de error viajarían hasta DEV:
//   · 42803 — la subconsulta correlacionada dentro de un agregado, en una consulta que AGRUPA (el
//     consolidado). Es el Bug #12058 otra vez, y tumba el endpoint entero en toda llamada.
//   · 22023 — `jsonb_array_length` sobre algo que no es un array (una liquidación sellada antes de
//     esta HU no tiene la clave). Tumbaría el reporte entero, no una celda.
//   · el ABANICO — si la subconsulta se convirtiera en un `leftJoin`, un trámite con dos servicios
//     saldría DOS veces: dinero duplicado en los totales y en el Excel. Aquí se cuentan las filas.
//
// Todo dentro de UNA transacción que termina en ROLLBACK: la 0194 se aplica ahí dentro (la base
// local la comparten otras sesiones) y los fixtures desaparecen al salir. Se activa con
// TEST_DATABASE_URL; sin ella se SALTA.
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

// La 0193 (la puente) tampoco está aplicada en la base local: se recrea dentro de la transacción,
// como `tarifas-por-fecha.test.ts` hace con la 0182/0183. Las dos son idempotentes.
const SQL_0193 = leerMigracion('0193_tramite_servicios_adicionales.sql');
const SQL_0194 = leerMigracion('0194_liquidaciones_valor_servicios_adicionales.sql');
// Desde la HU #12627 `EXPR_LOGISTICA` lee `flito_tramite_viajes_logistica` (0199) en toda fila del
// reporte, así que la proyección REAL no se puede ejecutar sin la tabla. Idempotente, como las otras.
const SQL_0199 = leerMigracion('0199_tramite_viajes_logistica.sql');

// Drizzle proyecta SIN alias y mapea por POSICIÓN: aquí se hace lo mismo (patrón de
// db/tarifas-por-fecha.test.ts).
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

describe.skipIf(!URL_BASE)('reporte de costos — servicios adicionales contra PostgreSQL (HU #12546)', () => {
  let sql: postgres.Sql;

  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  const SELLO = String(Date.now()).slice(-9);
  const NIT = `12546-${SELLO}`;

  interface Fixtures { sinServicios: string; conServicios: string; selladaNueva: string; selladaVieja: string }

  /** 0193 + 0194 aplicadas, un cliente y un vehículo desechables, y los cuatro casos de la HU. */
  async function preparar(tx: postgres.TransactionSql): Promise<Fixtures> {
    await tx.unsafe(SQL_0193);
    await tx.unsafe(SQL_0194);
    await tx.unsafe(SQL_0199);
    const [c] = await tx`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
      VALUES (${`HU12546 ${SELLO}`}, ${NIT}, true, true, true) RETURNING id`;
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`H12546${SELLO.slice(-3)}`}, ${`VIN12546${SELLO}`}) RETURNING id`;
    const [tipoA] = await tx`INSERT INTO flito_servicios_adicionales_tipos (nombre, valor) VALUES (${`Paz y salvo ${SELLO}`}, 50000) RETURNING id`;
    const [tipoB] = await tx`INSERT INTO flito_servicios_adicionales_tipos (nombre, valor) VALUES (${`Diagnóstico ${SELLO}`}, 35000) RETURNING id`;

    let n = 0;
    const tramite = async (): Promise<string> => {
      n += 1;
      const [t] = await tx`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id, compania_nit, tipo_tramite, fecha_aprobacion, flit_estado)
        VALUES (${`HU12546-${SELLO}-${n}`}, ${v!.id}, now(), ${c!.id}, ${NIT}, 'Traspaso', '2026-09-10T12:00:00Z', 'Aprobado') RETURNING id`;
      await tx`INSERT INTO flito_derechos_tramite (tramite_id, compania_id, origen, valor) VALUES (${t!.id}, ${c!.id}, 'manual', 80000)`;
      return t!.id as string;
    };
    const asignar = async (tramiteId: string, tipoId: string, nombre: string, valor: number) => {
      await tx`INSERT INTO flito_tramite_servicios_adicionales (tramite_id, tipo_id, nombre, valor)
        VALUES (${tramiteId}, ${tipoId}, ${nombre}, ${valor})`;
    };
    const sellar = async (tramiteId: string, valorServicios: string | null, detalle: unknown) => {
      await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, valor_derecho, valor_servicios_adicionales, base_gmf, valor_gmf, total, detalle)
        VALUES (${tramiteId}, 'liquidado', 80000, ${valorServicios}, ${valorServicios === null ? 80000 : 165000},
                ${valorServicios === null ? 320 : 660}, ${valorServicios === null ? 80320 : 165660}, ${tx.json(detalle as never)})`;
    };

    const sinServicios = await tramite();
    const conServicios = await tramite();
    await asignar(conServicios, tipoA!.id as string, 'Paz y salvo', 50000);
    await asignar(conServicios, tipoB!.id as string, 'Diagnóstico', 35000);

    const selladaNueva = await tramite();
    // Sellada POR esta HU: la clave existe, con sus dos items y la columna con la suma.
    await sellar(selladaNueva, '85000', {
      derecho: { valor: 80000, origen: 'Recibo de derecho de tránsito', bloquea: false },
      serviciosAdicionales: {
        valor: 85000, origen: 'asignacion', bloquea: false,
        items: [{ tipoId: tipoA!.id, nombre: 'Paz y salvo', valor: 50000 }, { tipoId: tipoB!.id, nombre: 'Diagnóstico', valor: 35000 }],
      },
    });
    // Y una sellada ANTES de la HU: sin la clave en el detalle y con la columna en NULL (sin backfill).
    const selladaVieja = await tramite();
    await sellar(selladaVieja, null, { derecho: { valor: 80000, origen: 'Recibo de derecho de tránsito', bloquea: false } });

    return { sinServicios, conServicios, selladaNueva, selladaVieja };
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
      servicios: num(f[col('serviciosAdicionales')]),
      cantidad: num(f[col('serviciosAdicionalesCantidad')]),
      gmf: num(f[col('gmf')]),
      total: num(f[col('totalFila')]),
    }));
  }

  it('la fila estimada suma la puente; la sellada lee su columna; la sellada ANTES de la HU no revienta', async () => {
    await enTx(sql, async (tx) => {
      const f = await preparar(tx);
      const filas = await detalle(tx, [f.sinServicios, f.conServicios, f.selladaNueva, f.selladaVieja]);
      const por = (id: string) => filas.find((x) => x.tramiteId === id)!;

      // EL ABANICO: cuatro trámites, cuatro filas, aunque uno lleve DOS servicios. Un `leftJoin` en
      // `conJoins` daría cinco y duplicaría el dinero de los totales y del Excel.
      expect(filas).toHaveLength(4);

      // Sin servicios → NULL («no aplica»), nunca 0; el gravamen no se mueve.
      expect(por(f.sinServicios).servicios).toBeNull();
      expect(por(f.sinServicios).cantidad).toBe(0);
      expect(por(f.sinServicios).total).toBe(80320);

      // Con servicios → la SUMA de la puente, y el 4x1000 sobre la base CON ellos:
      // 80.000 + 85.000 = 165.000; ×0,004 = 660.
      expect(por(f.conServicios).servicios).toBe(85000);
      expect(por(f.conServicios).cantidad).toBe(2);
      expect(por(f.conServicios).gmf).toBe(660);
      expect(por(f.conServicios).total).toBe(165660);

      // Sellada por esta HU: la columna manda y la cantidad sale del array del detalle.
      expect(por(f.selladaNueva).sellada).toBe(true);
      expect(por(f.selladaNueva).servicios).toBe(85000);
      expect(por(f.selladaNueva).cantidad).toBe(2);

      // Sellada ANTES: columna NULL y cantidad NULL («no se sabe»), sin 22023 y sin recalcular desde
      // la puente. Mutante «sin el `jsonb_typeof`»: aquí seguiría verde, pero un detalle con la clave
      // escalar tumbaría la consulta entera; mutante «COALESCE(sellado, estimado)»: daría 0/85000.
      expect(por(f.selladaVieja).servicios).toBeNull();
      expect(por(f.selladaVieja).cantidad).toBeNull();
    });
  }, 60_000);

  it('el consolidado AGRUPA con la subconsulta dentro del agregado: sin 42803 y cuadrando con el detalle', async () => {
    await enTx(sql, async (tx) => {
      const f = await preparar(tx);
      // La consulta REAL del consolidado, restringida a la compañía desechable por su NIT.
      const q = ensamblarConsolidado(
        new QueryBuilder().select(selectConsolidado('mes')).from(flitoTramites).$dynamic(),
        { empresas: [NIT] }, 'mes',
      );
      const { sql: texto, params } = q.toSQL();
      // Si la expresión llevara un parámetro, el del SELECT y el del GROUP BY serían `$n` distintos
      // y PostgreSQL rechazaría esto con 42803 — que es exactamente lo que se está ejecutando.
      const filas = await tx.unsafe(texto, params as never[]).values();

      expect(filas).toHaveLength(1);
      const g = filas[0]!;
      expect(Number(g[colCons('tramites')])).toBe(4);
      // 85.000 de la puente (estimada) + 85.000 de la columna (sellada) = 170.000.
      expect(Number(g[colCons('serviciosAdicionales')])).toBe(170000);
      // RN-02 sobre el grupo: reintegro + servicio = total, con los servicios DENTRO del servicio.
      const total = Number(g[colCons('total')]);
      const reintegro = Number(g[colCons('totalReintegro')]);
      const servicio = Number(g[colCons('totalServicio')]);
      expect(servicio).toBe(170000);
      expect(Math.round((reintegro + servicio) * 100) / 100).toBe(total);
      // Y el total del grupo es el de las cuatro filas del detalle (CF-13).
      const suma = (await detalle(tx, [f.sinServicios, f.conServicios, f.selladaNueva, f.selladaVieja]))
        .reduce((a, x) => a + (x.total ?? 0), 0);
      expect(total).toBe(Math.round(suma * 100) / 100);
    });
  }, 60_000);
});
