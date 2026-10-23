// HU #13899 (Feature #13886, ADR-0029) — migraciones 0249 (DDL del modelo único) y 0250 (copia del
// libro de clientes) contra PostgreSQL DE VERDAD, todo dentro de una transacción que termina en
// ROLLBACK (`helpers/base-en-tx.ts`): la base local la comparten otras sesiones.
//
// Se activa con `TEST_DATABASE_URL`; sin ella los tests se SALTAN (el CI no levanta Postgres). Un
// `skipped` NO es verde: el HANDOFF declara con qué URL se corrió.
//
// Cubre AC1 (copia fiel + evento), AC2 (las autocreadas vacías no se migran), AC3 (descuadre → falla
// ENTERA, sin PII, sin filas), AC4 (idempotencia) y AC5 (la FK de conciliación apunta al libro único,
// consultada en `pg_constraint` por tabla y columna, nunca por un nombre supuesto).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { URL_BASE, abrirBase, enTx, leerMigracion } from '../helpers/base-en-tx.js';

const SQL_0249 = leerMigracion('0249_flito_bolsas_unicas.sql');
const SQL_0250 = leerMigracion('0250_flito_bolsas_unicas_datos_cliente.sql');

const NIT_A = '900111222-1';
const NOMBRE_A = 'HU13899 Transportes Alfa S.A.S.';

describe('0249/0250 — análisis estático', () => {
  it('sin BEGIN/COMMIT (ADR-DB-001) y con DO etiquetado', () => {
    expect(scanForTxControl('0249_flito_bolsas_unicas.sql', SQL_0249)).toEqual([]);
    expect(scanForTxControl('0250_flito_bolsas_unicas_datos_cliente.sql', SQL_0250)).toEqual([]);
    expect(SQL_0250).toMatch(/DO \$m0250\$/);
    expect(SQL_0250).toMatch(/LOCK TABLE flito_bolsas, flito_bolsa_movimientos, flito_bolsa_cierres IN EXCLUSIVE MODE/);
  });
});

type Tx = postgres.TransactionSql;

interface Sembrado { companiaA: number; companiaB: number; companiaC: number; bolsaA: string; bolsaB: string; bolsaC: string }

async function compania(tx: Tx, nombre: string, nit: string): Promise<number> {
  const [c] = await tx`INSERT INTO clients (name, document) VALUES (${nombre}, ${`${nit}-${String(Date.now()).slice(-6)}`}) RETURNING id`;
  return c!.id as number;
}

async function bolsa(tx: Tx, companiaId: number, saldo: string): Promise<string> {
  const [b] = await tx`INSERT INTO flito_bolsas (compania_id, saldo, ultima_recarga_valor, ultima_recarga_en)
    VALUES (${companiaId}, ${saldo}, ${saldo === '0' ? null : '500000'}, ${saldo === '0' ? null : new Date('2026-03-04T15:00:00Z')})
    RETURNING id`;
  return b!.id as string;
}

async function movimiento(
  tx: Tx, bolsaId: string, companiaId: number, tipo: 'entrada' | 'salida', valor: string, saldoResultante: string,
  extra: { llave?: string | null; corrige?: string | null; origen?: string; periodo?: string } = {},
): Promise<string> {
  const [m] = await tx`INSERT INTO flito_bolsa_movimientos
    (bolsa_id, compania_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre,
     llave_idempotencia, corrige_movimiento_id)
    VALUES (${bolsaId}, ${companiaId}, ${tipo}, ${extra.origen ?? 'manual'}, ${valor}, ${saldoResultante},
            ${extra.periodo ?? '2026-03'}, '2026-03-04', 'financiera@flit.io', ${extra.llave ?? null}, ${extra.corrige ?? null})
    RETURNING id`;
  return m!.id as string;
}

async function cierre(tx: Tx, bolsaId: string, companiaId: number, periodo: string, saldoFinal: string): Promise<string> {
  const [c] = await tx`INSERT INTO flito_bolsa_cierres
    (bolsa_id, compania_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
    VALUES (${bolsaId}, ${companiaId}, ${periodo}, '0', ${saldoFinal}, '0', ${saldoFinal}, 0, 'financiera@flit.io')
    RETURNING id`;
  return c!.id as string;
}

/** A: movimientos (recarga, salida con llave SOAT, corrección) + cierre. B: solo cierre. C: autocreada vacía. */
async function sembrar(tx: Tx): Promise<Sembrado & { movsA: string[]; cierreA: string }> {
  const companiaA = await compania(tx, NOMBRE_A, NIT_A);
  const companiaB = await compania(tx, 'HU13899 Beta', '900333444-5');
  const companiaC = await compania(tx, 'HU13899 Gama', '900555666-7');
  const bolsaA = await bolsa(tx, companiaA, '420000');
  const bolsaB = await bolsa(tx, companiaB, '0');
  const bolsaC = await bolsa(tx, companiaC, '0');
  const m1 = await movimiento(tx, bolsaA, companiaA, 'entrada', '500000', '500000', { origen: 'recarga', llave: `recarga:${companiaA}:k1` });
  const m2 = await movimiento(tx, bolsaA, companiaA, 'salida', '100000', '400000', {
    origen: 'automatico', llave: 'salida:soat:5a000000-0000-4000-8000-0000000013a9',
  });
  const m3 = await movimiento(tx, bolsaA, companiaA, 'entrada', '20000', '420000', { corrige: m1, periodo: '2026-04' });
  const cierreA = await cierre(tx, bolsaA, companiaA, '2026-02', '0');
  await cierre(tx, bolsaB, companiaB, '2026-02', '0');
  return { companiaA, companiaB, companiaC, bolsaA, bolsaB, bolsaC, movsA: [m1, m2, m3], cierreA };
}

async function migrar(tx: Tx): Promise<void> {
  await tx.unsafe(SQL_0249);
  await tx.unsafe(SQL_0250);
}

describe.skipIf(!URL_BASE)('0249/0250 contra PostgreSQL (rollback al salir)', () => {
  let sql: postgres.Sql;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('TC-01 · copia la bolsa con el mismo id, alcance compania, activa, misma compañía y saldo, y los seis conceptos', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const [u] = await tx`SELECT alcance, compania_id, activa, saldo, ultima_entrada_valor, nombre
        FROM flito_bolsas_unicas WHERE id = ${s.bolsaA}`;
      expect(u).toMatchObject({ alcance: 'compania', compania_id: s.companiaA, activa: true, saldo: '420000.00', nombre: null });
      expect(u!.ultima_entrada_valor).toBe('500000.00');
      const conceptos = await tx`SELECT concepto FROM flito_bolsas_unicas_conceptos WHERE bolsa_id = ${s.bolsaA} ORDER BY 1`;
      expect(conceptos.map((c) => c.concepto)).toEqual(
        ['derecho', 'impuesto', 'logistica', 'servicios_adicionales', 'soat', 'tramite_digital']);
    });
  });

  it('TC-02 · copia cada movimiento con su id, su llave, su corrección, su periodo y su valor', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const viejos = await tx`SELECT id, tipo, origen, valor, saldo_resultante, periodo, fecha, llave_idempotencia, corrige_movimiento_id
        FROM flito_bolsa_movimientos WHERE bolsa_id = ${s.bolsaA} ORDER BY id`;
      const nuevos = await tx`SELECT id, tipo, origen, valor, saldo_resultante, periodo, fecha, llave_idempotencia, corrige_movimiento_id
        FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${s.bolsaA} ORDER BY id`;
      expect(nuevos).toHaveLength(3);
      expect(nuevos.map((n) => ({ ...n }))).toEqual(viejos.map((v) => ({ ...v })));
    });
  });

  it('TC-03 · copia los cierres con su id y sus totales, por bolsa', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const [c] = await tx`SELECT bolsa_id, periodo, saldo_final FROM flito_bolsas_unicas_cierres WHERE id = ${s.cierreA}`;
      expect(c).toMatchObject({ bolsa_id: s.bolsaA, periodo: '2026-02', saldo_final: '0.00' });
    });
  });

  it('TC-04 · el saldo de cada bolsa migrada es igual a Σ entradas − salidas de su libro y al saldo viejo', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const [r] = await tx`SELECT u.saldo, o.saldo AS viejo,
          (SELECT COALESCE(sum(CASE WHEN tipo='entrada' THEN valor ELSE -valor END), 0)
             FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = u.id) AS libro
        FROM flito_bolsas_unicas u JOIN flito_bolsas o ON o.id = u.id WHERE u.id = ${s.bolsaA}`;
      expect(r!.saldo).toBe(r!.viejo);
      expect(Number(r!.saldo)).toBe(Number(r!.libro));
    });
  });

  it('TC-05 · deja UN evento migrar por bolsa migrada, sin PII (ni NIT ni nombre)', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const ev = await tx`SELECT bolsa_id, accion, usuario_nombre, snapshot::text AS snap, motivo
        FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN (${s.bolsaA}, ${s.bolsaB}, ${s.bolsaC})`;
      expect(ev.map((e) => e.bolsa_id).sort()).toEqual([s.bolsaA, s.bolsaB].sort());
      for (const e of ev) {
        expect(e.accion).toBe('migrar');
        expect(`${e.snap} ${e.motivo} ${e.usuario_nombre}`).not.toContain(NIT_A);
        expect(`${e.snap} ${e.motivo} ${e.usuario_nombre}`).not.toContain(NOMBRE_A);
      }
    });
  });

  it('TC-06 · migra la bolsa que solo tiene cierres aunque no tenga movimientos', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const [u] = await tx`SELECT alcance, compania_id FROM flito_bolsas_unicas WHERE id = ${s.bolsaB}`;
      expect(u).toMatchObject({ alcance: 'compania', compania_id: s.companiaB });
    });
  });

  it('TC-07/TC-08 · no migra la autocreada vacía (ni conceptos ni evento) y su compañía queda {existe:false, activa:false}', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const [n] = await tx`SELECT
          (SELECT count(*)::int FROM flito_bolsas_unicas WHERE id = ${s.bolsaC}) AS bolsas,
          (SELECT count(*)::int FROM flito_bolsas_unicas_conceptos WHERE bolsa_id = ${s.bolsaC}) AS conceptos,
          (SELECT count(*)::int FROM flito_bolsas_unicas_eventos WHERE bolsa_id = ${s.bolsaC}) AS eventos`;
      expect(n).toEqual({ bolsas: 0, conceptos: 0, eventos: 0 });
      // La misma consulta que `estadoBolsaDeCompania` (alcance + compañía): sin fila → {false,false}.
      const filas = await tx`SELECT activa FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id = ${s.companiaC}`;
      expect(filas).toHaveLength(0);
    });
  });

  it('TC-09/TC-10 · con saldo ≠ libro lanza, el mensaje solo da el conteo (sin NIT ni nombre) y no deja ninguna fila', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await tx.unsafe(SQL_0249);
      // Descuadre en la bolsa de A: el saldo denormalizado no es el del libro.
      await tx`UPDATE flito_bolsas SET saldo = 999999 WHERE id = ${s.bolsaA}`;
      let error: Error | undefined;
      await tx.savepoint(async (sp) => { await sp.unsafe(SQL_0250); }).catch((e: Error) => { error = e; });

      expect(error?.message).toMatch(/^flito_bolsas_unicas: 1 bolsas de cliente no cuadran/);
      expect(error?.message).not.toContain(NIT_A);
      expect(error?.message).not.toContain(NOMBRE_A);
      expect(error?.message).not.toContain(s.bolsaA);
      // Falla ENTERA: ni la bolsa buena (B) ni nada de A quedó copiado.
      const [n] = await tx`SELECT
          (SELECT count(*)::int FROM flito_bolsas_unicas WHERE id IN (${s.bolsaA}, ${s.bolsaB})) AS bolsas,
          (SELECT count(*)::int FROM flito_bolsas_unicas_movimientos WHERE id IN (${s.movsA[0]!}, ${s.movsA[1]!}, ${s.movsA[2]!})) AS movs,
          (SELECT count(*)::int FROM flito_bolsas_unicas_cierres WHERE id = ${s.cierreA}) AS cierres,
          (SELECT count(*)::int FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN (${s.bolsaA}, ${s.bolsaB})) AS eventos`;
      expect(n).toEqual({ bolsas: 0, movs: 0, cierres: 0, eventos: 0 });
    });
  });

  it('TC-12 · aplicar 0249 y 0250 dos veces no falla ni duplica filas, eventos ni constraints', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      const foto = async () => (await tx`SELECT
          (SELECT count(*)::int FROM flito_bolsas_unicas) AS bolsas,
          (SELECT count(*)::int FROM flito_bolsas_unicas_movimientos) AS movs,
          (SELECT count(*)::int FROM flito_bolsas_unicas_cierres) AS cierres,
          (SELECT count(*)::int FROM flito_bolsas_unicas_conceptos) AS conceptos,
          (SELECT count(*)::int FROM flito_bolsas_unicas_eventos) AS eventos,
          (SELECT count(*)::int FROM pg_constraint WHERE conrelid::regclass::text LIKE 'flito_bolsas_unicas%') AS constraints,
          (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'flito_conciliacion_lineas'::regclass) AS fk_lineas,
          (SELECT saldo FROM flito_bolsas_unicas WHERE id = ${s.bolsaA}) AS saldo_a`)[0];
      await migrar(tx);
      const primera = await foto();
      await migrar(tx);
      expect(await foto()).toEqual(primera);
    });
  });

  it('db-review · la base rechaza un periodo mal formado (movimiento y cierre), un origen fuera del dominio y la autocorrección', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrar(tx);
      await migrar(tx);
      const rechazo = async (q: (sp: Tx) => Promise<unknown>): Promise<string | undefined> => {
        let nombre: string | undefined;
        await tx.savepoint(async (sp) => { await q(sp); })
          .catch((e: { code?: string; constraint_name?: string }) => { if (e.code === '23514') nombre = e.constraint_name; });
        return nombre;
      };
      const mov = (sp: Tx, periodo: string, origen = 'manual') => sp`INSERT INTO flito_bolsas_unicas_movimientos
        (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre)
        VALUES (${s.bolsaA}, 'entrada', ${origen}, '1', '1', ${periodo}, '2026-03-04', 'qa')`;

      expect(await rechazo((sp) => mov(sp, '2026-13'))).toBe('flito_bolsas_unicas_mov_periodo_chk');
      expect(await rechazo((sp) => mov(sp, '2026-3'))).toBe('flito_bolsas_unicas_mov_periodo_chk');
      expect(await rechazo((sp) => mov(sp, '2026-03', 'carga'))).toBe('flito_bolsas_unicas_mov_origen_chk');
      expect(await rechazo((sp) => sp`INSERT INTO flito_bolsas_unicas_cierres
        (bolsa_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
        VALUES (${s.bolsaA}, '2026-00', '0', '0', '0', '0', 0, 'qa')`)).toBe('flito_bolsas_unicas_cierre_periodo_chk');
      expect(await rechazo((sp) => sp`UPDATE flito_bolsas_unicas_movimientos
        SET corrige_movimiento_id = id WHERE id = ${s.movsA[0]!}`)).toBe('flito_bolsas_unicas_mov_corrige_chk');
      // Control: el periodo bien formado sí entra.
      expect(await rechazo((sp) => mov(sp, '2026-03'))).toBeUndefined();
    });
  });

  it('TC-13 · flito_conciliacion_lineas.movimiento_bolsa_id referencia al libro único (pg_constraint por tabla y columna)', async () => {
    await enTx(sql, async (tx) => {
      await sembrar(tx);
      await migrar(tx);
      const fks = await tx`SELECT con.confrelid::regclass::text AS destino, con.confdeltype
        FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE con.contype = 'f' AND con.conrelid = 'flito_conciliacion_lineas'::regclass
          AND a.attname = 'movimiento_bolsa_id'`;
      // Exactamente una FK en esa columna, al libro único y en RESTRICT ('r').
      expect(fks.map((f) => ({ ...f }))).toEqual([{ destino: 'flito_bolsas_unicas_movimientos', confdeltype: 'r' }]);
    });
  });
});
