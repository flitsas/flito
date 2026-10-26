// HU #13911 (Feature #13887, ADR-0029) — migración 0266: retiro de los seis libros viejos de bolsas a
// `archivo_bolsas`, contra PostgreSQL DE VERDAD y dentro de una transacción que termina en ROLLBACK
// (`helpers/base-en-tx.ts`). `enTxLibrosViejos` devuelve los libros a `public` dentro de la transacción
// si la base local ya tiene la 0266 aplicada, así que la prueba parte siempre del estado previo al retiro.
//
// Se activa con `TEST_DATABASE_URL`; sin ella los tests se SALTAN (el CI no levanta Postgres). Un
// `skipped` NO es verde: el HANDOFF declara con qué URL se corrió.
//
// Cubre AC1 (descuadre → error con solo ids e importes y nada se mueve; un movimiento NUEVO del modelo
// único no es descuadre), AC3 (los seis al archivo, datos intactos, modelo único sin cambios), AC4 (una
// FK de fuera hacia un libro viejo → falla sin mover) y AC5 (re-ejecutar no falla ni cambia nada).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { LIBROS_VIEJOS_BOLSAS, URL_BASE, abrirBase, enTxLibrosViejos, leerMigracion } from '../helpers/base-en-tx.js';

const ARCHIVO = '0266_flito_bolsas_retiro_libros.sql';
const SQL_0266 = leerMigracion(ARCHIVO);
const SQL_0250 = leerMigracion('0250_flito_bolsas_unicas_datos_cliente.sql');
const SQL_0257 = leerMigracion('0257_flito_bolsas_unicas_datos_transito.sql');

const NIT = '900913911-3';
const NOMBRE = 'HU13911 Transportes Retiro S.A.S.';

type Tx = postgres.TransactionSql;

describe('0266 — análisis estático', () => {
  it('sin BEGIN/COMMIT (ADR-DB-001), un solo DO etiquetado, ARCHIVA (SET SCHEMA) y nunca hace DROP', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0266)).toEqual([]);
    expect(SQL_0266).toMatch(/DO \$m0266\$/);
    expect(SQL_0266).toMatch(/CREATE SCHEMA IF NOT EXISTS archivo_bolsas/);
    expect(SQL_0266).toMatch(/ALTER TABLE IF EXISTS public\.%I SET SCHEMA archivo_bolsas/);
    // El DROP SCHEMA diferido solo aparece en comentarios y en el COMMENT ON SCHEMA (texto), nunca como sentencia.
    const ejecutable = SQL_0266.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
    expect(ejecutable).not.toMatch(/\bDROP\b/i);
    for (const t of LIBROS_VIEJOS_BOLSAS) expect(SQL_0266).toContain(`'${t}'`);
  });
});

interface Sembrado { companiaId: number; bolsaA: string; movsA: string[]; cierreA: string; transito: string; movT: string }

async function enSchema(tx: Tx, esquema: string): Promise<string[]> {
  const filas = await tx`SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${esquema} AND table_name IN ${tx([...LIBROS_VIEJOS_BOLSAS])} ORDER BY 1`;
  return filas.map((f) => f.table_name as string);
}

async function conteos(tx: Tx): Promise<Record<string, string>> {
  const [c] = await tx`SELECT
      (SELECT count(*) FROM flito_bolsas_unicas)              AS bolsas,
      (SELECT count(*) FROM flito_bolsas_unicas_movimientos)  AS movimientos,
      (SELECT count(*) FROM flito_bolsas_unicas_cierres)      AS cierres,
      (SELECT count(*) FROM flito_bolsas_unicas_cobertura)    AS cobertura,
      (SELECT COALESCE(sum(saldo), 0) FROM flito_bolsas_unicas) AS saldos`;
  return { ...c } as Record<string, string>;
}

/** Libro de cliente (A: 2 movimientos + cierre) y de tránsito (T: 1 carga), copiados por la 0250 y la 0257. */
async function sembrarYCopiar(tx: Tx): Promise<Sembrado> {
  const [c] = await tx`INSERT INTO clients (name, document) VALUES (${NOMBRE}, ${`${NIT}-${String(Date.now()).slice(-6)}`}) RETURNING id`;
  const companiaId = c!.id as number;
  const [b] = await tx`INSERT INTO flito_bolsas (compania_id, saldo) VALUES (${companiaId}, '420000') RETURNING id`;
  const bolsaA = b!.id as string;
  const movsA: string[] = [];
  for (const [tipo, valor, saldo] of [['entrada', '500000', '500000'], ['salida', '80000', '420000']] as const) {
    const [m] = await tx`INSERT INTO flito_bolsa_movimientos
      (bolsa_id, compania_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
      VALUES (${bolsaA}, ${companiaId}, ${tipo}, 'manual', ${valor}, ${saldo}, '2026-09', '2026-09-15', 'financiera@flit.io')
      RETURNING id`;
    movsA.push(m!.id as string);
  }
  const [ci] = await tx`INSERT INTO flito_bolsa_cierres
    (bolsa_id, compania_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
    VALUES (${bolsaA}, ${companiaId}, '2026-08', '0', '0', '0', '0', 0, 'financiera@flit.io') RETURNING id`;

  const [org] = await tx`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 1`;
  const [t] = await tx`INSERT INTO flito_bolsas_transito (nombre, saldo, ultima_carga_valor, ultima_carga_en)
    VALUES (${`HU13911 Tránsito ${Date.now()}`}, '300000', '300000', now()) RETURNING id`;
  const transito = t!.id as string;
  if (org) {
    await tx`INSERT INTO flito_bolsa_transito_cobertura (bolsa_id, organismo_codigo, concepto)
      VALUES (${transito}, ${org.codigo as string}, 'derecho') ON CONFLICT DO NOTHING`;
  }
  const [mt] = await tx`INSERT INTO flito_bolsa_transito_movimientos
    (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
    VALUES (${transito}, 'entrada', 'carga', '300000', '300000', '2026-09', '2026-09-15', 'tesoreria@flit.io') RETURNING id`;

  await tx.unsafe(SQL_0250);
  await tx.unsafe(SQL_0257);
  return { companiaId, bolsaA, movsA, cierreA: ci!.id as string, transito, movT: mt!.id as string };
}

/** Corre la 0266 en un SAVEPOINT y devuelve el mensaje del error (la transacción externa sigue viva). */
async function errorDe0266(tx: Tx): Promise<string> {
  try {
    await tx.savepoint((sp) => sp.unsafe(SQL_0266));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('la 0266 debía fallar y terminó bien');
}

describe.skipIf(!URL_BASE)('0266 (HU #13911) contra PostgreSQL (rollback al salir)', () => {
  let sql: postgres.Sql;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('AC3 · con todo cuadrado, los seis libros pasan a archivo_bolsas con sus datos y el modelo único no cambia; un movimiento NUEVO del modelo único no bloquea', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      const s = await sembrarYCopiar(tx);
      // Tras la 0250 el modelo único sigue vivo: un descuento nuevo que el libro viejo no tiene NO es descuadre.
      await tx`INSERT INTO flito_bolsas_unicas_movimientos
        (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
        VALUES (${s.bolsaA}, 'salida', 'manual', '20000', '400000', '2026-10', '2026-10-20', 'financiera@flit.io')`;
      await tx`UPDATE flito_bolsas_unicas SET saldo = saldo - 20000 WHERE id = ${s.bolsaA}`;

      const antes = await conteos(tx);
      const [viejo] = await tx`SELECT
          (SELECT count(*) FROM flito_bolsa_movimientos) AS movs,
          (SELECT count(*) FROM flito_bolsa_transito_movimientos) AS movs_t,
          (SELECT saldo FROM flito_bolsas WHERE id = ${s.bolsaA}) AS saldo_a`;
      expect(await enSchema(tx, 'public')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());

      await tx.unsafe(SQL_0266);

      expect(await enSchema(tx, 'public')).toEqual([]);
      expect(await enSchema(tx, 'archivo_bolsas')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());
      const [archivado] = await tx`SELECT
          (SELECT count(*) FROM archivo_bolsas.flito_bolsa_movimientos) AS movs,
          (SELECT count(*) FROM archivo_bolsas.flito_bolsa_transito_movimientos) AS movs_t,
          (SELECT saldo FROM archivo_bolsas.flito_bolsas WHERE id = ${s.bolsaA}) AS saldo_a`;
      expect({ ...archivado }).toEqual({ ...viejo });
      const ids = await tx`SELECT id FROM archivo_bolsas.flito_bolsa_movimientos WHERE bolsa_id = ${s.bolsaA} ORDER BY id`;
      expect(ids.map((r) => r.id)).toEqual([...s.movsA].sort());
      expect(await conteos(tx)).toEqual(antes);
    });
  });

  it('AC1 · un movimiento viejo SIN copia (escrito tras la 0250) → error con id e importes, sin NIT ni nombre, y nada se mueve', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      const s = await sembrarYCopiar(tx);
      await tx`INSERT INTO flito_bolsa_movimientos
        (bolsa_id, compania_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
        VALUES (${s.bolsaA}, ${s.companiaId}, 'entrada', 'manual', '1000', '421000', '2026-10', '2026-10-01', 'financiera@flit.io')`;
      await tx`UPDATE flito_bolsas SET saldo = 421000 WHERE id = ${s.bolsaA}`;
      const antes = await conteos(tx);

      const msg = await errorDe0266(tx);

      expect(msg).toMatch(/1 bolsas no cuadran con el modelo único; no se retira nada/);
      expect(msg).toContain(s.bolsaA);
      expect(msg).toMatch(/movimientos viejo\/copia=3\/2 suma viejo\/copia=421000\.00\/420000\.00/);
      expect(msg).not.toContain(NIT);
      expect(msg).not.toContain(NOMBRE);
      expect(await enSchema(tx, 'public')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());
      expect(await conteos(tx)).toEqual(antes);
    });
  });

  it('AC1 · saldo del libro viejo distinto de su suma, o bolsa de tránsito sin migrar → error con los ids, y nada se mueve', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      const s = await sembrarYCopiar(tx);
      await tx`UPDATE flito_bolsas SET saldo = saldo + 5 WHERE id = ${s.bolsaA}`;
      const [t2] = await tx`INSERT INTO flito_bolsas_transito (nombre, saldo) VALUES (${`HU13911 Sin migrar ${Date.now()}`}, '0') RETURNING id`;

      const msg = await errorDe0266(tx);

      expect(msg).toMatch(/2 bolsas no cuadran/);
      expect(msg).toContain(`${s.bolsaA} [compania] migrada=t saldo_viejo=420005.00`);
      expect(msg).toContain(`${t2!.id as string} [transito] migrada=f`);
      expect(await enSchema(tx, 'public')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());
    });
  });

  it('AC1 · un cierre viejo sin copia fiel → error con su id, y nada se mueve', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      const s = await sembrarYCopiar(tx);
      await tx`UPDATE flito_bolsa_cierres SET saldo_final = 7 WHERE id = ${s.cierreA}`;

      const msg = await errorDe0266(tx);

      expect(msg).toMatch(/1 cierres de cliente sin copia fiel/);
      expect(msg).toContain(s.cierreA);
      expect(await enSchema(tx, 'public')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());
    });
  });

  it('AC4 · una FK de fuera que aún apunta a un libro viejo → falla nombrándola, sin mover ni borrar nada', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      await sembrarYCopiar(tx);
      await tx.unsafe(`CREATE TABLE hu13911_ref_vieja (
        id serial PRIMARY KEY,
        movimiento_id uuid CONSTRAINT hu13911_ref_vieja_mov_fk REFERENCES flito_bolsa_transito_movimientos(id))`);
      const antes = await conteos(tx);

      const msg = await errorDe0266(tx);

      expect(msg).toMatch(/1 restricciones aún referencian un libro viejo/);
      expect(msg).toContain('hu13911_ref_vieja_mov_fk');
      expect(await enSchema(tx, 'public')).toEqual([...LIBROS_VIEJOS_BOLSAS].sort());
      expect(await enSchema(tx, 'archivo_bolsas')).toEqual([]);
      expect(await conteos(tx)).toEqual(antes);
    });
  });

  it('AC5 · re-ejecutar termina sin error y no cambia nada (ya no están en public: no verifica)', async () => {
    await enTxLibrosViejos(sql, async (tx) => {
      await sembrarYCopiar(tx);
      await tx.unsafe(SQL_0266);
      const despues1 = { ...(await conteos(tx)), archivo: (await enSchema(tx, 'archivo_bolsas')).join(',') };
      // Un descuadre introducido ya en el ARCHIVO no la hace fallar: tras el retiro no se re-verifica.
      await tx`UPDATE archivo_bolsas.flito_bolsas SET saldo = saldo + 1`;

      await tx.unsafe(SQL_0266);

      expect({ ...(await conteos(tx)), archivo: (await enSchema(tx, 'archivo_bolsas')).join(',') }).toEqual(despues1);
      expect(await enSchema(tx, 'public')).toEqual([]);
    });
  });
});
