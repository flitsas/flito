// HU #14106 AC1 — la 0279 mueve `logistica` → `logistica_cliente` sin duplicar ni perder historial,
// y es idempotente (2 corridas). Contra PostgreSQL en transacción con ROLLBACK; solo con
// TEST_DATABASE_URL (sin ella se SALTA).
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { abrirBase, companiaDesechable, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

const SQL_0275 = leerMigracion('0279_flito_tarifas_logistica_cliente_flit.sql');

describe.skipIf(!URL_BASE)('0279 — contra la base real', () => {
  let sql: postgres.Sql;
  beforeAll(async () => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('AC1: historial completo pasa a logistica_cliente, 2ª corrida no cambia nada; logistica_flit nace vacío', async () => {
    await enTx(sql, async (tx) => {
      const c = await companiaDesechable(tx, 'L');
      await tx`INSERT INTO flito_tarifas_vigencias
        (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, fijado_en, cerrado_en)
        VALUES (${c}, 'logistica', NULL, 40000, '2000-01-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')`;
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica', NULL, 45000, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`;
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'tramite_digital', 'MATRICULA', 250000, '2000-01-01T00:00:00Z', '2026-08-01T00:00:00Z')`;

      const foto = async () => tx`
        SELECT id, concepto, valor::float8 AS valor, vigente_desde, vigente_hasta
          FROM flito_tarifas_vigencias WHERE compania_id = ${c} ORDER BY concepto, vigente_desde`;
      const antes = await foto();
      await tx.unsafe(SQL_0275);
      const despues = await foto();
      expect(despues.map((f) => f.concepto)).toEqual(['logistica_cliente', 'logistica_cliente', 'tramite_digital']);
      // Mismo id, valor y rango: el historial no se pierde ni se duplica.
      expect(despues.map((f) => [f.id, f.valor, f.vigente_desde, f.vigente_hasta]).sort())
        .toEqual(antes.map((f) => [f.id, f.valor, f.vigente_desde, f.vigente_hasta]).sort());
      expect(despues.filter((f) => f.concepto === 'logistica_flit')).toHaveLength(0);

      await tx.unsafe(SQL_0275);
      expect(await foto()).toEqual(despues);
    });
  }, 60_000);

  it('una logistica legada que solapa con una logistica_cliente se OMITE (no duplica)', async () => {
    await enTx(sql, async (tx) => {
      const c = await companiaDesechable(tx, 'S');
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica_cliente', NULL, 1, '2000-01-01T00:00:00Z', now())`;
      await tx`INSERT INTO flito_tarifas_vigencias
        (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, fijado_en, cerrado_en)
        VALUES (${c}, 'logistica', NULL, 2, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', now(), now())`;
      await tx.unsafe(SQL_0275);
      const f = await tx`SELECT concepto FROM flito_tarifas_vigencias WHERE compania_id = ${c} ORDER BY valor`;
      expect(f.map((x) => x.concepto)).toEqual(['logistica_cliente', 'logistica']);
    });
  }, 60_000);

  it('el CHECK acepta logistica_flit sin tipo y rechaza logistica_flit con tipo', async () => {
    await enTx(sql, async (tx) => {
      const c = await companiaDesechable(tx, 'K');
      await tx.unsafe(SQL_0275);
      await tx`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica_flit', NULL, 5, '2000-01-01T00:00:00Z', now())`;
      const err = await tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, fijado_en)
        VALUES (${c}, 'logistica_flit', 'OTROS', 5, '2000-01-01T00:00:00Z', now())`).catch((e: { code?: string }) => e);
      expect((err as { code?: string }).code).toBe('23514');
    });
  }, 60_000);
});
