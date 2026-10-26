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
//
// HU #13911: desde la 0266 los libros viejos viven en `archivo_bolsas`; `enTxLibrosViejos` los devuelve a
// `public` dentro de la transacción (ROLLBACK al salir), así estas pruebas siguen corriendo tras el retiro.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { URL_BASE, abrirBase, enTxLibrosViejos as enTx, leerMigracion } from '../helpers/base-en-tx.js';

const SQL_0249 = leerMigracion('0249_flito_bolsas_unicas.sql');
const SQL_0250 = leerMigracion('0250_flito_bolsas_unicas_datos_cliente.sql');
const SQL_0257 = leerMigracion('0257_flito_bolsas_unicas_datos_transito.sql');

const NIT_A = '900111222-1';
const NOMBRE_A = 'HU13899 Transportes Alfa S.A.S.';

describe('0249/0250 — análisis estático', () => {
  it('sin BEGIN/COMMIT (ADR-DB-001) y con DO etiquetado', () => {
    expect(scanForTxControl('0249_flito_bolsas_unicas.sql', SQL_0249)).toEqual([]);
    expect(scanForTxControl('0250_flito_bolsas_unicas_datos_cliente.sql', SQL_0250)).toEqual([]);
    expect(SQL_0250).toMatch(/DO \$m0250\$/);
    expect(SQL_0250).toMatch(/LOCK TABLE flito_bolsas, flito_bolsa_movimientos, flito_bolsa_cierres IN EXCLUSIVE MODE/);
    // HU #13906: la hermana de tránsito, mismo contrato.
    expect(scanForTxControl('0257_flito_bolsas_unicas_datos_transito.sql', SQL_0257)).toEqual([]);
    expect(SQL_0257).toMatch(/DO \$m0257\$/);
    expect(SQL_0257).toMatch(/LOCK TABLE flito_bolsas_transito, flito_bolsa_transito_cobertura, flito_bolsa_transito_movimientos\s+IN EXCLUSIVE MODE/);
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

// ─────────────── HU #13906 (Feature #13887) — 0257: libro de TRÁNSITO al modelo único ───────────────
//
// Misma técnica: todo en una transacción con ROLLBACK. Antes de sembrar se devuelve la FK de
// `movimiento_transito_id` al libro VIEJO (dentro de la tx), para reproducir el estado previo a la
// 0257 aunque la base local ya la tenga aplicada.

const NOMBRE_T1 = 'HU13906 Bolsa Norte';
const NOMBRE_T2 = 'HU13906 Bolsa Sur';
const ORG_1 = '05001';
const ORG_2 = '05045';
const ORG_3 = '05079';
const ORG_PAR = '05088';

interface SembradoTransito { t1: string; t2: string; movs: string[]; consumoSoat: string; linea: string | null }

async function estadoPrevioA0257(tx: Tx): Promise<void> {
  await tx.unsafe(SQL_0249);
  await tx.unsafe(`ALTER TABLE flito_conciliacion_lineas DROP CONSTRAINT IF EXISTS flito_conciliacion_lineas_mov_transito_unica_fk;
    ALTER TABLE flito_conciliacion_lineas ADD CONSTRAINT hu13906_fk_previa FOREIGN KEY (movimiento_transito_id)
      REFERENCES flito_bolsa_transito_movimientos(id) ON DELETE RESTRICT;`);
}

async function movTransito(
  tx: Tx, bolsaId: string, tipo: 'entrada' | 'salida', origen: string, valor: string, saldo: string,
  extra: { organismo?: string; concepto?: string; llave?: string } = {},
): Promise<string> {
  const [m] = await tx`INSERT INTO flito_bolsa_transito_movimientos
    (bolsa_id, organismo_codigo, concepto, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre, llave_idempotencia)
    VALUES (${bolsaId}, ${extra.organismo ?? null}, ${extra.concepto ?? null}, ${tipo}, ${origen}, ${valor}, ${saldo},
            '2026-09', '2026-09-15', 'tesoreria@flit.io', ${extra.llave ?? null})
    RETURNING id`;
  return m!.id as string;
}

/** T1: 2 secretarías × 3 conceptos y 8 movimientos (2 cargas). T2: sin movimientos. Línea conciliada → consumo SOAT. */
async function sembrarTransito(tx: Tx): Promise<SembradoTransito> {
  await estadoPrevioA0257(tx);
  const [b1] = await tx`INSERT INTO flito_bolsas_transito (nombre, saldo, ultima_carga_valor, ultima_carga_en)
    VALUES (${NOMBRE_T1}, '10000000', '1000000', ${new Date('2026-09-15T15:00:00Z')}) RETURNING id`;
  const [b2] = await tx`INSERT INTO flito_bolsas_transito (nombre, saldo) VALUES (${NOMBRE_T2}, '0') RETURNING id`;
  const t1 = b1!.id as string;
  const t2 = b2!.id as string;
  for (const org of [ORG_1, ORG_2]) {
    for (const concepto of ['derecho', 'soat', 'impuesto']) {
      await tx`INSERT INTO flito_bolsa_transito_cobertura (bolsa_id, organismo_codigo, concepto) VALUES (${t1}, ${org}, ${concepto})`;
    }
  }
  await tx`INSERT INTO flito_bolsa_transito_cobertura (bolsa_id, organismo_codigo, concepto) VALUES (${t2}, ${ORG_3}, 'derecho')`;

  const sufijo = String(Date.now());
  const m1 = await movTransito(tx, t1, 'entrada', 'carga', '10000000', '10000000');
  const m2 = await movTransito(tx, t1, 'salida', 'automatico', '100000', '9900000',
    { organismo: ORG_1, concepto: 'derecho', llave: `consumo:hu13906:${sufijo}:1` });
  const m3 = await movTransito(tx, t1, 'salida', 'automatico', '200000', '9700000',
    { organismo: ORG_2, concepto: 'impuesto', llave: `consumo:hu13906:${sufijo}:2` });
  const [soat] = await tx`SELECT s.id FROM flito_soat s WHERE NOT EXISTS (
      SELECT 1 FROM flito_conciliacion_lineas l WHERE l.soat_id = s.id AND l.conciliada_en IS NOT NULL) LIMIT 1`;
  const soatId = (soat?.id as string | undefined) ?? null;
  const m4 = await movTransito(tx, t1, 'salida', 'conciliacion', '450000', '9250000',
    { organismo: ORG_1, concepto: 'soat', llave: `consumo:soat:${soatId ?? `hu13906-${sufijo}`}` });
  const m5 = await movTransito(tx, t1, 'entrada', 'automatico', '100000', '9350000', { organismo: ORG_1, concepto: 'derecho', llave: `contra:${m2}` });
  const m6 = await movTransito(tx, t1, 'entrada', 'carga', '1000000', '10350000');
  const m7 = await movTransito(tx, t1, 'salida', 'automatico', '300000', '10050000',
    { organismo: ORG_2, concepto: 'soat', llave: `consumo:hu13906:${sufijo}:7` });
  const m8 = await movTransito(tx, t1, 'salida', 'automatico', '50000', '10000000',
    { organismo: ORG_2, concepto: 'derecho', llave: `consumo:hu13906:${sufijo}:8` });

  let linea: string | null = null;
  if (soatId) {
    const companiaId = await compania(tx, 'HU13906 Conciliada', '900777888-9');
    const [bo] = await tx`INSERT INTO flito_conciliacion_boletas
      (compania_id, archivo_nombre, archivo_hash, filas, total_declarado, fecha_pago, cargada_por_nombre)
      VALUES (${companiaId}, 'hu13906.xlsx', ${`hash-${sufijo}`}, 1, '450000', '2026-09-15', 'tesoreria@flit.io') RETURNING id`;
    const [li] = await tx`INSERT INTO flito_conciliacion_lineas
      (boleta_id, fila_numero, numero_poliza_norm, valor_declarado, resultado, soat_id, conciliada_en, movimiento_transito_id)
      VALUES (${bo!.id as string}, 1, 'POL13906', '450000', 'ok', ${soatId}, now(), ${m4}) RETURNING id`;
    linea = li!.id as string;
  }
  return { t1, t2, movs: [m1, m2, m3, m4, m5, m6, m7, m8], consumoSoat: m4, linea };
}

describe.skipIf(!URL_BASE)('0257 (HU #13906) contra PostgreSQL (rollback al salir)', () => {
  let sql: postgres.Sql;
  beforeAll(() => { sql = abrirBase(); });
  afterAll(async () => { await sql?.end(); });

  it('AC1 · las dos bolsas (con y sin movimientos) pasan al modelo único alcance transito con id, nombre, saldo, cobertura activa, 8 movimientos y cargas → recarga', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrarTransito(tx);
      await tx.unsafe(SQL_0257);

      const bolsas = await tx`SELECT id, alcance, nombre, compania_id, activa, saldo, ultima_entrada_valor
        FROM flito_bolsas_unicas WHERE id IN (${s.t1}, ${s.t2}) ORDER BY nombre`;
      expect(bolsas.map((b) => ({ ...b }))).toEqual([
        { id: s.t1, alcance: 'transito', nombre: NOMBRE_T1, compania_id: null, activa: true, saldo: '10000000.00', ultima_entrada_valor: '1000000.00' },
        { id: s.t2, alcance: 'transito', nombre: NOMBRE_T2, compania_id: null, activa: true, saldo: '0.00', ultima_entrada_valor: null },
      ]);

      const cobertura = await tx`SELECT bolsa_id, organismo_codigo, concepto, activa FROM flito_bolsas_unicas_cobertura
        WHERE bolsa_id IN (${s.t1}, ${s.t2})`;
      expect(cobertura.filter((c) => c.bolsa_id === s.t1)).toHaveLength(6);
      expect(cobertura.filter((c) => c.bolsa_id === s.t2)).toHaveLength(1);
      expect(cobertura.every((c) => c.activa === true)).toBe(true);

      const viejos = await tx`SELECT id, tipo, valor, saldo_resultante, periodo, fecha, organismo_codigo, concepto, llave_idempotencia,
          CASE WHEN origen = 'carga' THEN 'recarga' ELSE origen END AS origen
        FROM flito_bolsa_transito_movimientos WHERE bolsa_id = ${s.t1} ORDER BY id`;
      const nuevos = await tx`SELECT id, tipo, valor, saldo_resultante, periodo, fecha, organismo_codigo, concepto, llave_idempotencia, origen
        FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${s.t1} ORDER BY id`;
      expect(nuevos).toHaveLength(8);
      expect(nuevos.map((n) => ({ ...n }))).toEqual(viejos.map((v) => ({ ...v })));
      expect(nuevos.map((n) => n.id).sort()).toEqual([...s.movs].sort());
      expect(nuevos.filter((n) => n.origen === 'recarga')).toHaveLength(2);
      expect(nuevos.some((n) => n.origen === 'carga')).toBe(false);

      const [libro] = await tx`SELECT COALESCE(sum(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END), 0) AS suma
        FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${s.t1}`;
      expect(Number(libro!.suma)).toBe(10_000_000);

      const eventos = await tx`SELECT bolsa_id, accion, usuario_nombre FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN (${s.t1}, ${s.t2})`;
      expect(eventos.map((e) => e.bolsa_id).sort()).toEqual([s.t1, s.t2].sort());
      expect(eventos.every((e) => e.accion === 'migrar' && e.usuario_nombre === 'migración 0257')).toBe(true);
    });
  });

  it('AC2 · con saldo ≠ libro falla con un mensaje que solo da el conteo y no copia ninguna fila de tránsito', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrarTransito(tx);
      await tx`UPDATE flito_bolsas_transito SET saldo = 1 WHERE id = ${s.t1}`;
      let error: Error | undefined;
      await tx.savepoint(async (sp) => { await sp.unsafe(SQL_0257); }).catch((e: Error) => { error = e; });

      expect(error?.message).toMatch(/^flito_bolsas_unicas: 1 bolsas de tránsito no cuadran/);
      for (const dato of [NOMBRE_T1, NOMBRE_T2, s.t1, s.t2]) expect(error?.message).not.toContain(dato);
      const [n] = await tx`SELECT
          (SELECT count(*)::int FROM flito_bolsas_unicas WHERE id IN (${s.t1}, ${s.t2})) AS bolsas,
          (SELECT count(*)::int FROM flito_bolsas_unicas_cobertura WHERE bolsa_id IN (${s.t1}, ${s.t2})) AS cobertura,
          (SELECT count(*)::int FROM flito_bolsas_unicas_movimientos WHERE id = ANY(${s.movs})) AS movs,
          (SELECT count(*)::int FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN (${s.t1}, ${s.t2})) AS eventos`;
      expect(n).toEqual({ bolsas: 0, cobertura: 0, movs: 0, eventos: 0 });
    });
  });

  it('AC3 · re-ejecutar la 0257 no falla ni duplica bolsas, cobertura, movimientos, eventos ni constraints', async () => {
    await enTx(sql, async (tx) => {
      await sembrarTransito(tx);
      const foto = async () => (await tx`SELECT
          (SELECT count(*)::int FROM flito_bolsas_unicas WHERE alcance = 'transito') AS bolsas,
          (SELECT count(*)::int FROM flito_bolsas_unicas_cobertura) AS cobertura,
          (SELECT count(*)::int FROM flito_bolsas_unicas_movimientos) AS movs,
          (SELECT count(*)::int FROM flito_bolsas_unicas_eventos) AS eventos,
          (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'flito_conciliacion_lineas'::regclass) AS fk_lineas`)[0];
      await tx.unsafe(SQL_0257);
      const primera = await foto();
      await tx.unsafe(SQL_0257);
      expect(await foto()).toEqual(primera);
    });
  });

  it('AC4 · la pareja (secretaría, concepto) es única solo entre bolsas ACTIVAS: la base rechaza la segunda activa y admite la que reemplaza a una inactiva', async () => {
    await enTx(sql, async (tx) => {
      await sembrarTransito(tx);
      await tx.unsafe(SQL_0257);
      const nueva = async (nombre: string) => (await tx`INSERT INTO flito_bolsas_unicas (alcance, nombre)
        VALUES ('transito', ${nombre}) RETURNING id`)[0]!.id as string;
      const a = await nueva('HU13906 Par A');
      const b = await nueva('HU13906 Par B');
      await tx`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto) VALUES (${a}, ${ORG_PAR}, 'impuesto')`;

      let rechazo: { code?: string; constraint_name?: string } | undefined;
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto) VALUES (${b}, ${ORG_PAR}, 'impuesto')`;
      }).catch((e: { code?: string; constraint_name?: string }) => { rechazo = e; });
      expect(rechazo).toMatchObject({ code: '23505', constraint_name: 'uq_flito_bolsas_unicas_cobertura_activa' });

      // Inactivar A (bolsa y su cobertura juntas) libera el par para B.
      await tx`UPDATE flito_bolsas_unicas SET activa = false, inactivada_en = now() WHERE id = ${a}`;
      await tx`UPDATE flito_bolsas_unicas_cobertura SET activa = false WHERE bolsa_id = ${a}`;
      await tx`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto) VALUES (${b}, ${ORG_PAR}, 'impuesto')`;
      const [n] = await tx`SELECT count(*)::int AS n FROM flito_bolsas_unicas_cobertura WHERE organismo_codigo = ${ORG_PAR} AND concepto = 'impuesto'`;
      expect(n!.n).toBe(2);
    });
  });

  it('AC5 · la línea conciliada que apuntaba al consumo de tránsito apunta al MISMO id en el libro único (FK única, RESTRICT)', async () => {
    await enTx(sql, async (tx) => {
      const s = await sembrarTransito(tx);
      await tx.unsafe(SQL_0257);

      const fks = await tx`SELECT con.confrelid::regclass::text AS destino, con.confdeltype
        FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE con.contype = 'f' AND con.conrelid = 'flito_conciliacion_lineas'::regclass
          AND a.attname = 'movimiento_transito_id'`;
      expect(fks.map((f) => ({ ...f }))).toEqual([{ destino: 'flito_bolsas_unicas_movimientos', confdeltype: 'r' }]);

      if (s.linea) {
        const [l] = await tx`SELECT l.movimiento_transito_id, m.bolsa_id, m.llave_idempotencia
          FROM flito_conciliacion_lineas l JOIN flito_bolsas_unicas_movimientos m ON m.id = l.movimiento_transito_id
          WHERE l.id = ${s.linea}`;
        expect(l).toMatchObject({ movimiento_transito_id: s.consumoSoat, bolsa_id: s.t1 });
        expect(String(l!.llave_idempotencia)).toMatch(/^consumo:soat:/);
      }
    });
  });
});
