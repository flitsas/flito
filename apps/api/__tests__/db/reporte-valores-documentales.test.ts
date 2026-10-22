// HU #12653 — el valor documental en el reporte de costos, contra PostgreSQL de verdad (AC1–AC6).
//
// Es el ÚNICO sitio donde este SQL se EJECUTA (calco de `reporte-viajes-logistica.test.ts`): el
// mock `chain` ignora `where` y joins, y el CI no levanta Postgres. Aquí se ven de verdad los
// 85.000 / 155.000 / 175.000 / 50.000 de los AC, el NULL de la autogestión con comprobante, el
// origen leído del sello, el filtro «Con diferencias» y que el consolidado agrupa sin 42803 con las
// 29 subconsultas nuevas dentro de las sumas.
//
// Todo dentro de UNA transacción que termina en ROLLBACK. Se activa con TEST_DATABASE_URL.
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

const { condiciones, conJoins, SELECT_FILA, SELECT_TOTALES } = await import('../../src/modules/finanzas/finanzas.service.js');
type FiltrosReporte = Parameters<typeof condiciones>[0];
const { ensamblarConsolidado, selectConsolidado } = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const { flitoTramites } = await import('../../src/db/schema.js');

const CLAVES = Object.keys(SELECT_FILA);
const col = (nombre: keyof typeof SELECT_FILA) => {
  const i = CLAVES.indexOf(nombre);
  if (i < 0) throw new Error(`SELECT_FILA no proyecta ${String(nombre)}`);
  return i;
};
const num = (x: unknown) => (x === null ? null : Number(x));

describe.skipIf(!URL_BASE)('reporte de costos — valor documental, origen, diferencia y filtro, contra PostgreSQL (HU #12653)', () => {
  let sql: postgres.Sql;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  const SELLO = String(Date.now()).slice(-9);
  const NIT = `12653-${SELLO}`;
  const NIT_SIN_TARIFA = `12653s-${SELLO}`;
  const NIT_AUTO = `12653a-${SELLO}`;

  interface Fixtures {
    tdDoc: string; tdSin: string; tdSinTarifa: string; lgDoc: string; lgSin: string;
    auto: string; autoExc: string; sa: string; selladaDoc: string; selladaVieja: string; saAceptada: string;
  }

  async function preparar(tx: postgres.TransactionSql): Promise<Fixtures> {
    // La 0199 (viajes) puede no estar en la base local: se aplica dentro de la transacción, como en el test de viajes.
    await tx.unsafe(leerMigracion('0199_tramite_viajes_logistica.sql'));
    const [u] = await tx`SELECT id, username FROM users ORDER BY id LIMIT 1`;
    const usuario = u!.id as number;
    const compania = async (nit: string, auto: boolean): Promise<number> => {
      const [c] = await tx`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
        VALUES (${`HU12653 ${nit}`}, ${nit}, true, true, ${auto}) RETURNING id`;
      return c!.id as number;
    };
    const conTarifa = await compania(NIT, false);
    const sinTarifa = await compania(NIT_SIN_TARIFA, false);
    const autoC = await compania(NIT_AUTO, true);
    // `sinTarifa` solo carece de la de TRÁMITE DIGITAL: la de logística la tiene, para que lo único
    // que pueda bloquearla sea el trámite digital (AC1, tercer Given).
    for (const c of [conTarifa, autoC]) {
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'tramite_digital', 'TRASPASO', 80000, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    }
    for (const c of [conTarifa, autoC, sinTarifa]) {
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica', NULL, 120000, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    }
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`H12653${SELLO.slice(-3)}`}, ${`VIN12653${SELLO}`}) RETURNING id`;

    let n = 0;
    const tramite = async (companiaId: number, nit: string): Promise<string> => {
      n += 1;
      const [t] = await tx`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id, compania_nit, tipo_tramite, fecha_aprobacion, flit_estado)
        VALUES (${`HU12653-${SELLO}-${n}`}, ${v!.id}, now(), ${companiaId}, ${nit}, 'Traspaso', '2026-09-10T12:00:00Z', 'Aprobado') RETURNING id`;
      await tx`INSERT INTO flito_derechos_tramite (tramite_id, compania_id, origen, valor) VALUES (${t!.id}, ${companiaId}, 'manual', 80000)`;
      return t!.id as string;
    };
    const comprobante = async (tramiteId: string, concepto: string, valor: number, tarifa: number | null, aceptada = false): Promise<string> => {
      n += 1;
      const [s] = await tx`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_id, subido_por_nombre)
        VALUES ('comprobante_pago', 'rec.pdf', 'application/pdf', ${`hu12653/${SELLO}/${n}`}, ${`h${SELLO}${n}`}, 10, ${usuario}, 'test') RETURNING id`;
      const diferencia = tarifa === null ? valor : valor - tarifa;
      const [c] = await tx`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre, estado, es_pago, concepto,
          tramite_id, valor, numero_documento, fecha_documento, tarifa_referencia, diferencia_tarifa, marcado_por_diferencia,
          aplicado_en, aplicado_por_id, diferencia_aceptada_por_id, diferencia_aceptada_en, diferencia_aceptada_motivo)
        VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${usuario}, 'test', 'aplicado', true, ${concepto},
          ${tramiteId}, ${valor}, ${`REC-${n}`}, '2026-09-09', ${tarifa}, ${diferencia}, ${diferencia !== 0},
          now(), ${usuario}, ${aceptada ? usuario : null}, ${aceptada ? new Date() : null}, ${aceptada ? 'Pactado' : null}) RETURNING id`;
      return c!.id as string;
    };
    const viaje = async (tramiteId: string, numero: number, valor: number) => {
      await tx`INSERT INTO flito_tramite_viajes_logistica (tramite_id, numero, modo, valor, tarifa_vigente, motivo)
        VALUES (${tramiteId}, ${numero}, 'manual', ${valor}, 120000, 'devolucion')`;
    };
    const servicio = async (tramiteId: string, valor: number) => {
      n += 1;
      const [cat] = await tx`INSERT INTO flito_servicios_adicionales_tipos (nombre, valor, activo) VALUES (${`SA ${SELLO}-${n}`}, ${valor}, true) RETURNING id`;
      await tx`INSERT INTO flito_tramite_servicios_adicionales (tramite_id, tipo_id, nombre, valor, asignado_por_id)
        VALUES (${tramiteId}, ${cat!.id}, ${`SA ${SELLO}-${n}`}, ${valor}, ${usuario})`;
    };
    const sellar = async (tramiteId: string, td: number, detalle: unknown) => {
      const base = 80000 + td;
      await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, valor_derecho, valor_tramite_digital, base_gmf, valor_gmf, total, detalle)
        VALUES (${tramiteId}, 'liquidado', 80000, ${td}, ${base}, ${base * 0.004}, ${base * 1.004}, ${tx.json(detalle as never)})`;
    };

    // AC1: comprobante 85.000 sobre tarifa 80.000.
    const tdDoc = await tramite(conTarifa, NIT);
    await comprobante(tdDoc, 'tramite_digital', 85000, 80000);
    const tdSin = await tramite(conTarifa, NIT);
    // AC1: tarifa NO configurada + comprobante 85.000 (tarifa_referencia NULL).
    const tdSinTarifa = await tramite(sinTarifa, NIT_SIN_TARIFA);
    await comprobante(tdSinTarifa, 'tramite_digital', 85000, null);
    // AC2: logística documental 100.000 + viajes 30.000 y 25.000.
    const lgDoc = await tramite(conTarifa, NIT);
    await comprobante(lgDoc, 'logistica', 100000, 120000);
    await viaje(lgDoc, 2, 30000); await viaje(lgDoc, 3, 25000);
    const lgSin = await tramite(conTarifa, NIT);
    await viaje(lgSin, 2, 30000); await viaje(lgSin, 3, 25000);
    // AC3: autogestiona SIN excepción + comprobante de logística; y CON excepción.
    const auto = await tramite(autoC, NIT_AUTO);
    await comprobante(auto, 'logistica', 100000, null);
    const autoExc = await tramite(autoC, NIT_AUTO);
    await comprobante(autoExc, 'logistica', 100000, 120000);
    await viaje(autoExc, 2, 30000);
    await tx`INSERT INTO flito_excepciones_autogestion (tramite_id, concepto, motivo, creado_por_id)
      VALUES (${autoExc}, 'logistica', 'FLITO lo hace', ${usuario})`;
    // AC4: dos servicios (Σ 50.000) + comprobante de SA 55.000.
    const sa = await tramite(conTarifa, NIT);
    await servicio(sa, 20000); await servicio(sa, 30000);
    await comprobante(sa, 'servicios_adicionales', 55000, 50000);
    // AC5: B — diferencia de SA ACEPTADA.
    const saAceptada = await tramite(conTarifa, NIT);
    await servicio(saAceptada, 20000);
    await comprobante(saAceptada, 'servicios_adicionales', 25000, 20000, true);
    // AC6: sellada con origenValor documental (lo escribe HU-2) y comprobante vivo aceptado después.
    const selladaDoc = await tramite(conTarifa, NIT);
    await comprobante(selladaDoc, 'tramite_digital', 85000, 80000, true);
    await sellar(selladaDoc, 85000, { tramiteDigital: { valor: 85000, origen: 'Comprobante', origenValor: 'documental', bloquea: false } });
    // AC6: sello previo a F3 (sin la clave) con comprobante aplicado antes del sello.
    const selladaVieja = await tramite(conTarifa, NIT);
    await comprobante(selladaVieja, 'tramite_digital', 85000, 80000);
    await sellar(selladaVieja, 80000, { tramiteDigital: { valor: 80000, origen: 'Tarifa', bloquea: false } });

    return { tdDoc, tdSin, tdSinTarifa, lgDoc, lgSin, auto, autoExc, sa, selladaDoc, selladaVieja, saAceptada };
  }

  async function detalle(tx: postgres.TransactionSql, ids: string[], f: FiltrosReporte = {}) {
    const q = conJoins(new QueryBuilder().select(SELECT_FILA).from(flitoTramites).$dynamic())
      .where(and(inArray(flitoTramites.id, ids), ...condiciones(f)));
    const { sql: texto, params } = q.toSQL();
    const filas = await tx.unsafe(texto, params as never[]).values();
    return filas.map((r) => ({
      tramiteId: r[col('tramiteId')] as string,
      sellada: Boolean(r[col('sellada')]),
      gestionaLogistica: Boolean(r[col('gestionaLogistica')]),
      tramiteDigital: num(r[col('tramiteDigital')]), logistica: num(r[col('logistica')]),
      serviciosAdicionales: num(r[col('serviciosAdicionales')]),
      viajes: num(r[col('logisticaViajesCantidad')]),
      incompleta: r[col('tramiteDigital')] === null || (Boolean(r[col('gestionaLogistica')]) && r[col('logistica')] === null),
      origenTd: r[col('origenTd')] as string, origenLg: r[col('origenLg')] as string,
      tdId: r[col('tdComprobanteId')] as string | null, tdRef: num(r[col('tdTarifaReferencia')]), tdDif: num(r[col('tdDiferencia')]),
      tdAceptadaPor: r[col('tdAceptadaPorId')] as number | null, tdNombre: r[col('tdAceptadaPorNombre')] as string | null,
      lgId: r[col('lgComprobanteId')] as string | null, lgDif: num(r[col('lgDiferencia')]), lgRef: num(r[col('lgTarifaReferencia')]),
      saId: r[col('saComprobanteId')] as string | null, saDif: num(r[col('saDiferencia')]), saAceptadaPor: r[col('saAceptadaPorId')] as number | null,
      total: num(r[col('totalFila')]),
    }));
  }

  it('AC1–AC6: los valores, el origen, la diferencia y el filtro, con el SQL real', async () => {
    await enTx(sql, async (tx) => {
      const f = await preparar(tx);
      const ids = Object.values(f);
      const filas = await detalle(tx, ids);
      const por = (id: string) => filas.find((x) => x.tramiteId === id)!;
      expect(filas).toHaveLength(ids.length); // sin abanico: 29 subconsultas escalares, ni un join

      // AC1
      expect(por(f.tdDoc).tramiteDigital).toBe(85000);
      expect(por(f.tdDoc).origenTd).toBe('documental');
      expect(por(f.tdDoc)).toMatchObject({ tdRef: 80000, tdDif: 5000, tdAceptadaPor: null, tdNombre: null });
      expect(por(f.tdDoc).tdId).not.toBeNull();
      expect(por(f.tdSin).tramiteDigital).toBe(80000);
      expect(por(f.tdSin).origenTd).toBe('tarifa');
      expect(por(f.tdSin).tdId).toBeNull();
      expect(por(f.tdSinTarifa).tramiteDigital).toBe(85000);
      expect(por(f.tdSinTarifa).incompleta).toBe(false);
      expect(por(f.tdSinTarifa)).toMatchObject({ tdRef: null, tdDif: 85000 });

      // AC2
      expect(por(f.lgDoc).logistica).toBe(155000);
      expect(por(f.lgDoc).viajes).toBe(3);
      expect(por(f.lgDoc).origenLg).toBe('documental');
      expect(por(f.lgDoc)).toMatchObject({ lgDif: -20000, lgRef: 120000 });
      expect(por(f.lgSin).logistica).toBe(175000);
      expect(por(f.lgSin).origenLg).toBe('tarifa');

      // AC3 (mutante 9)
      expect(por(f.auto).gestionaLogistica).toBe(false);
      expect(por(f.auto).logistica).toBeNull();
      expect(por(f.auto).lgId).not.toBeNull(); // el soporte viaja, el valor no
      expect(por(f.autoExc).logistica).toBe(130000);
      expect(por(f.autoExc).origenLg).toBe('documental');

      // AC4 (mutante 10)
      expect(por(f.sa).serviciosAdicionales).toBe(50000);
      expect(por(f.sa)).toMatchObject({ saDif: 5000, saAceptadaPor: null });

      // AC6
      expect(por(f.selladaDoc).sellada).toBe(true);
      expect(por(f.selladaDoc).tramiteDigital).toBe(85000);
      expect(por(f.selladaDoc).origenTd).toBe('documental');
      expect(por(f.selladaDoc).tdAceptadaPor).not.toBeNull();
      expect(por(f.selladaDoc).tdNombre).toBeTruthy();
      expect(por(f.selladaVieja).tramiteDigital).toBe(80000);
      expect(por(f.selladaVieja).origenTd).toBe('tarifa'); // NO la subconsulta viva
      expect(por(f.selladaVieja).origenLg).toBe('tarifa');
      expect(por(f.selladaVieja).tdId).not.toBeNull();

      // AC5: conDiferencias deja fuera a los sin comprobante, a la aceptada (saAceptada) y a lo sellado sin diferencia viva… pero
      // incluye toda fila con una diferencia marcada y NO aceptada, sellada o no.
      const con = await detalle(tx, ids, { conDiferencias: true });
      const esperados = [f.tdDoc, f.tdSinTarifa, f.lgDoc, f.auto, f.autoExc, f.sa, f.selladaVieja].sort();
      expect(con.map((x) => x.tramiteId).sort()).toEqual(esperados);
      expect(con.map((x) => x.tramiteId)).not.toContain(f.saAceptada);
      expect(con.map((x) => x.tramiteId)).not.toContain(f.tdSin);

      // Totales y consolidado con la MISMA expresión: 85.000 entra; sin 42803.
      const qt = conJoins(new QueryBuilder().select(SELECT_TOTALES).from(flitoTramites).$dynamic())
        .where(and(inArray(flitoTramites.id, [f.tdDoc]), ...condiciones({ conDiferencias: true }))).toSQL();
      const [tot] = await tx.unsafe(qt.sql, qt.params as never[]).values();
      expect(num(tot![Object.keys(SELECT_TOTALES).indexOf('tramiteDigital')])).toBe(85000);
      const qc = ensamblarConsolidado(new QueryBuilder().select(selectConsolidado('mes')).from(flitoTramites).$dynamic(), { empresas: [NIT], conDiferencias: true }, 'mes').toSQL();
      const grupos = await tx.unsafe(qc.sql, qc.params as never[]).values();
      expect(grupos).toHaveLength(1);
      const ic = Object.keys(selectConsolidado('mes'));
      // Del NIT con diferencias sin aceptar: tdDoc (85.000 documental) + lgDoc, sa y selladaVieja (80.000 cada uno).
      expect(num(grupos[0]![ic.indexOf('tramiteDigital')])).toBe(85000 + 80000 * 3);
    });
  });
});
