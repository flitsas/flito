// HU #12373 — La 0182: tarifas como VIGENCIAS. Tabla nueva con EXCLUDE (btree_gist) e índice parcial,
// desdoble de `flito_tarifas_compania` (que cae en la misma pasada), dos funciones nuevas, el PRIMER
// retiro de función del motor (`parametrizacion.tarifas.borrar`) y el auditor fuera de tarifas.
//
// Dos mitades, igual que la 0181:
//   · **Estática** (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
//     etiquetado), las dos filas de `permisos_funciones` son EXACTAMENTE lo que el catálogo del código
//     produce, y los DELETE van en la forma canónica que `helpers/permisos-seed-sql.ts` pliega (si el
//     DELETE del auditor desaparece, cae aquí y en permisos.auditor-observa.test.ts: mutante M2).
//   · **Contra PostgreSQL de verdad** (solo si hay base): el desdoble (AC1, AC3, prioridad), el aborto
//     (AC2), las constraints, los permisos y la idempotencia fuerte. TODO dentro de una transacción
//     con ROLLBACK: la base local la usan otras sesiones con el código de `develop` y no se le aplica
//     la 0182 de forma permanente. Se activa con:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0182.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.
//
// TZ=UTC: el desdoble copia instantes (`created_at` → `vigente_desde`) y se comparan como ISO.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { TIPOS_TRAMITE_TARIFA } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import { leerFuncionesSembradas, leerRepartoSembrado, leerRetirosSembrados } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0182_tarifas_vigencias.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0182 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0182.replace(/--[^\n]*/g, '');

const NUEVAS = ['parametrizacion.tarifas.historial', 'parametrizacion.tarifas.ver_por_cliente'] as const;
const RETIRADA = 'parametrizacion.tarifas.borrar';

describe('0182 — reglas del archivo y lo que siembra/retira (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y los tres bloques DO llevan dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0182)).toEqual([]);
    for (const etiqueta of ['ext0182', 'desdoble0182', 'resumen0182']) {
      expect(SQL_0182).toMatch(new RegExp(`DO \\$${etiqueta}\\$`));
      expect(SQL_0182).toMatch(new RegExp(`END \\$${etiqueta}\\$;`));
    }
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0182.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12365/);
    expect(cabecera).toMatch(/HU #12373/);
  });

  it('el número es 0182, sigue a la 0181 sin hueco y no colisiona', () => {
    // Antes exigía «es la última»: eso congela el tip y cae con la primera migración posterior
    // (la 0183 de la HU #12374 y la 0184 de la #12375 lo midieron). Lo que la convención pide es
    // max+1 EN SU MOMENTO: la inmediatamente anterior es la 0181 y nadie más lleva el 0182.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0182_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0181_/);
  });

  it('el modelo: EXCLUDE con btree_gist sobre tstzrange [), índice único PARCIAL sobre las abiertas y los CHECK del catálogo cerrado', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/);
    expect(SIN_COMENTARIOS).toMatch(/EXCLUDE USING gist \([\s\S]*?tstzrange\(vigente_desde, vigente_hasta, '\[\)'\)\) WITH &&/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_tarifas_vigencias_abierta[\s\S]*?WHERE vigente_hasta IS NULL/);
    // Los tres literales del CHECK son los del catálogo compartido: una cuarta forma no cabe.
    // `IS NOT NULL` antes del IN: `NULL IN (...)` es NULL y un CHECK en NULL deja pasar la fila (lo midió este test).
    const chk = SIN_COMENTARIOS.match(/concepto = 'tramite_digital' AND tipo_tramite IS NOT NULL AND tipo_tramite IN \(([^)]*)\)/)?.[1] ?? '';
    expect(chk.match(/'([A-Z]+)'/g)?.map((s) => s.replace(/'/g, ''))).toEqual([...TIPOS_TRAMITE_TARIFA]);
    expect(SIN_COMENTARIOS).toMatch(/concepto = 'logistica' AND tipo_tramite IS NULL/);
    expect(SIN_COMENTARIOS).toMatch(/\(vigente_hasta IS NULL\) = \(cerrado_en IS NULL\)/);
  });

  it('el desdoble corre solo la primera pasada (to_regclass) y deja caída la tabla vieja', () => {
    expect(SIN_COMENTARIOS).toMatch(/to_regclass\('public\.flito_tarifas_compania'\) IS NULL/);
    expect(SIN_COMENTARIOS).toMatch(/DROP TABLE flito_tarifas_compania;/);
    // Aborta y no adivina: tipo fuera del catálogo y logísticas activas con valor distinto.
    expect(SIN_COMENTARIOS).toMatch(/RAISE EXCEPTION '0182: % tarifa\(s\) de tramite_digital con tipo fuera del catalogo/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE EXCEPTION '0182: % compania\(s\) con dos logisticas ACTIVAS de valor distinto/);
  });

  it('siembra exactamente las dos funciones nuevas con los textos del catálogo del código, y su reparto para admin y financiera', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()].sort()).toEqual([...NUEVAS]);
    const catalogo = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    for (const codigo of NUEVAS) {
      const f = catalogo.get(codigo);
      expect(f, `${codigo} en el catálogo del código`).toBeDefined();
      expect(sembradas.get(codigo)).toEqual({ codigo, modulo: f!.modulo, nombre: f!.nombreNegocio, descripcion: f!.descripcion, tipo: 'operacion' });
      expect(f!.roles).toEqual(['admin', 'financiera']);
    }
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    expect([...reparto.get('admin')!].sort()).toEqual([...NUEVAS]);
    expect([...reparto.get('financiera')!].sort()).toEqual([...NUEVAS]);
  });

  it('retira `borrar` (reparto → usuario → función, en ese orden) y al auditor de `listar`, en la forma canónica que el helper pliega (mutante M2)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones).toEqual(new Set([RETIRADA]));
    expect(retiros.reparto).toEqual(new Set([`admin ${RETIRADA}`, `auditor parametrizacion.tarifas.listar`, `financiera ${RETIRADA}`]));
    const iRol = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_rol_funcion');
    const iUsr = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_usuario_funcion');
    const iFun = SIN_COMENTARIOS.indexOf('DELETE FROM permisos_funciones');
    expect(iRol).toBeGreaterThan(-1);
    expect(iUsr).toBeGreaterThan(iRol);
    expect(iFun).toBeGreaterThan(iUsr);
    // Y el código ya no declara `borrar`: una función en la base sin guarda viva no arrancaría.
    const codigos = new Set(catalogoCompleto().map((f) => f.codigo));
    expect(codigos.has(RETIRADA)).toBe(false);
    for (const c of NUEVAS) expect(codigos.has(c)).toBe(true);
  });

  it('el resumen final revienta si los permisos quedaron inconsistentes (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_borrar > 0 OR n_nuevas <> 2 OR n_auditor > 0 THEN\s*RAISE EXCEPTION/);
  });
});

// ─────────────────────────────── Contra la base real ───────────────────────────────

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

/** El DDL de la 0110, para poder desdoblar en una base que ya aplicó la 0182 (la tabla vieja no existe). */
const DDL_0110 = `
CREATE TABLE IF NOT EXISTS flito_tarifas_compania (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compania_id        integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  concepto           varchar(30) NOT NULL,
  tipo_tramite       varchar(60),
  valor              numeric(14,2) NOT NULL,
  activo             boolean NOT NULL DEFAULT true,
  actualizado_por_id integer REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flito_tarifas_valor_no_negativo CHECK (valor >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_tarifas_unica
  ON flito_tarifas_compania (compania_id, concepto, COALESCE(tipo_tramite, ''));`;

interface FilaVieja { concepto: string; tipo: string | null; valor: number; activo?: boolean; creada: string; actualizada?: string }

describe.skipIf(!URL_BASE)('0182 — contra la base real (desdoble, aborto, constraints, permisos e idempotencia)', () => {
  let sql: postgres.Sql;
  let uid: number | null = null;
  let tablaViejaAntes: string | null = null;
  let tablaNuevaAntes: string | null = null;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} });
    uid = (await sql`SELECT min(id)::int AS id FROM users`)[0]!.id ?? null;
    const [r] = await sql`SELECT to_regclass('public.flito_tarifas_compania')::text AS vieja, to_regclass('public.flito_tarifas_vigencias')::text AS nueva`;
    tablaViejaAntes = r!.vieja; tablaNuevaAntes = r!.nueva;
  });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  /** Una compañía desechable (vive solo dentro de la transacción) con sus tarifas viejas. */
  async function companiaVieja(tx: postgres.TransactionSql, nombre: string, filas: FilaVieja[]): Promise<number> {
    await tx.unsafe(DDL_0110);
    const [c] = await tx`INSERT INTO clients (name, document) VALUES (${`HU12373 ${nombre}`}, ${`12373-${nombre}-${String(Date.now()).slice(-8)}`}) RETURNING id`;
    for (const f of filas) {
      await tx`INSERT INTO flito_tarifas_compania (compania_id, concepto, tipo_tramite, valor, activo, actualizado_por_id, created_at, updated_at)
        VALUES (${c!.id}, ${f.concepto}, ${f.tipo}, ${f.valor}, ${f.activo ?? true}, ${uid}, ${f.creada}, ${f.actualizada ?? f.creada})`;
    }
    return c!.id as number;
  }

  const vigenciasDe = (tx: postgres.TransactionSql, companiaId: number) => tx`
    SELECT concepto, tipo_tramite, valor::float8 AS valor, vigente_desde, vigente_hasta, fijado_por_id, fijado_en, cerrado_por_id, cerrado_en
      FROM flito_tarifas_vigencias WHERE compania_id = ${companiaId} ORDER BY concepto, tipo_tramite NULLS FIRST`;

  it('AC1 + AC3: la genérica de trámite digital se desdobla en tres vigencias abiertas y la logística colapsa a una', async () => {
    await enTx(async (tx) => {
      const a = await companiaVieja(tx, 'A', [
        { concepto: 'tramite_digital', tipo: null, valor: 270000, creada: '2026-07-10T10:00:00Z' },
        { concepto: 'logistica', tipo: null, valor: 45000, creada: '2026-07-11T10:00:00Z' },
      ]);
      await tx.unsafe(SQL_0182);

      const filas = await vigenciasDe(tx, a);
      const td = filas.filter((f) => f.concepto === 'tramite_digital');
      expect(td.map((f) => f.tipo_tramite)).toEqual(['MATRICULA', 'OTROS', 'TRASPASO']);
      for (const f of td) {
        expect(f.valor).toBe(270000);
        expect(f.vigente_hasta).toBeNull();
        expect(f.cerrado_en).toBeNull();
        expect(new Date(f.vigente_desde).toISOString()).toBe('2026-07-10T10:00:00.000Z');
        expect(new Date(f.fijado_en).toISOString()).toBe('2026-07-10T10:00:00.000Z');
        expect(f.fijado_por_id).toBe(uid);
      }
      const lg = filas.filter((f) => f.concepto === 'logistica');
      expect(lg).toHaveLength(1);
      expect(lg[0]).toMatchObject({ tipo_tramite: null, valor: 45000, vigente_hasta: null });
      // Ninguna tarifa con tipo nulo en trámite digital, ninguna columna «activo», y la tabla vieja cayó.
      expect((await tx`SELECT count(*)::int AS n FROM flito_tarifas_vigencias WHERE concepto = 'tramite_digital' AND tipo_tramite IS NULL`)[0]!.n).toBe(0);
      expect((await tx`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'flito_tarifas_vigencias' AND column_name = 'activo'`)[0]!.n).toBe(0);
      expect((await tx`SELECT to_regclass('public.flito_tarifas_compania') AS t`)[0]!.t).toBeNull();
    });
  }, 60_000);

  it('prioridad del desdoble: la específica activa manda sobre la genérica; la inactiva no cuenta; la logística ignora el tipo', async () => {
    await enTx(async (tx) => {
      const b = await companiaVieja(tx, 'B', [
        { concepto: 'tramite_digital', tipo: null, valor: 100000, creada: '2026-06-01T00:00:00Z' },
        { concepto: 'tramite_digital', tipo: 'traspaso', valor: 250000, creada: '2026-06-02T00:00:00Z' },
        // Con tilde y espacios a propósito: el plegado va con translate() (no unaccent, que en DEV no
        // resolvía); si no pliega, la 0182 aborta por «tipo fuera del catálogo» y este test cae.
        { concepto: 'tramite_digital', tipo: ' Matrícula ', valor: 180000, creada: '2026-06-04T00:00:00Z' },
        { concepto: 'tramite_digital', tipo: 'OTROS', valor: 50000, activo: false, creada: '2026-05-01T00:00:00Z', actualizada: '2026-05-20T00:00:00Z' },
        { concepto: 'logistica', tipo: 'Matricula', valor: 30000, creada: '2026-06-03T00:00:00Z' },
      ]);
      await tx.unsafe(SQL_0182);
      const filas = await vigenciasDe(tx, b);
      const porLlave = Object.fromEntries(filas.map((f) => [`${f.concepto}:${f.tipo_tramite}`, f]));
      expect(porLlave['tramite_digital:MATRICULA']).toMatchObject({ valor: 180000, vigente_hasta: null });
      expect(porLlave['tramite_digital:TRASPASO']).toMatchObject({ valor: 250000, vigente_hasta: null });
      expect(porLlave['tramite_digital:OTROS']).toMatchObject({ valor: 100000, vigente_hasta: null });
      expect(porLlave['logistica:null']).toMatchObject({ valor: 30000, vigente_hasta: null });
      expect(filas).toHaveLength(4);
    });
  }, 60_000);

  it('una tarifa inactiva sin sucesora migra CERRADA (rango [created_at, updated_at)) y no cuenta como vigente', async () => {
    await enTx(async (tx) => {
      const d = await companiaVieja(tx, 'D', [
        { concepto: 'logistica', tipo: null, valor: 15000, activo: false, creada: '2026-03-01T00:00:00Z', actualizada: '2026-04-01T00:00:00Z' },
      ]);
      await tx.unsafe(SQL_0182);
      const [lg] = await vigenciasDe(tx, d);
      expect(lg).toMatchObject({ concepto: 'logistica', valor: 15000, cerrado_por_id: uid });
      expect(new Date(lg!.vigente_hasta).toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(new Date(lg!.cerrado_en).toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect((await tx`SELECT count(*)::int AS n FROM flito_tarifas_vigencias WHERE compania_id = ${d} AND vigente_hasta IS NULL`)[0]!.n).toBe(0);
    });
  }, 60_000);

  it('AC2: dos logísticas ACTIVAS con valor distinto abortan nombrando la compañía y los dos valores, y nada cambia', async () => {
    const { mensaje, companiaId } = await enTx(async (tx) => {
      const c = await companiaVieja(tx, 'C', [
        { concepto: 'logistica', tipo: null, valor: 45000, creada: '2026-07-01T00:00:00Z' },
        { concepto: 'logistica', tipo: 'Traspaso', valor: 60000, creada: '2026-07-02T00:00:00Z' },
      ]);
      const e = await tx.unsafe(SQL_0182).then(() => null, (x: Error) => x);
      return { mensaje: e?.message ?? '', companiaId: c };
    });
    expect(mensaje).toMatch(/dos logisticas ACTIVAS de valor distinto/);
    expect(mensaje).toContain(`compania ${companiaId}`);
    expect(mensaje).toContain('45000');
    expect(mensaje).toContain('60000');
    // Tras el rollback la base está como antes: ni la tabla vieja cayó ni apareció la nueva.
    const [r] = await sql`SELECT to_regclass('public.flito_tarifas_compania')::text AS vieja, to_regclass('public.flito_tarifas_vigencias')::text AS nueva`;
    expect(r!.vieja).toBe(tablaViejaAntes);
    expect(r!.nueva).toBe(tablaNuevaAntes);
  }, 60_000);

  it('un tipo fuera del catálogo en trámite digital aborta nombrando compañía y tipo', async () => {
    const mensaje = await enTx(async (tx) => {
      await companiaVieja(tx, 'E', [{ concepto: 'tramite_digital', tipo: 'Cancelacion', valor: 1000, creada: '2026-07-01T00:00:00Z' }]);
      const e = await tx.unsafe(SQL_0182).then(() => null, (x: Error) => x);
      return e?.message ?? '';
    });
    expect(mensaje).toMatch(/tipo fuera del catalogo/);
    expect(mensaje).toMatch(/tipo 'Cancelacion'/);
  }, 60_000);

  it('el modelo en pg_catalog: 5 CHECK, la EXCLUDE, el índice parcial; y el motor rechaza una segunda abierta y un solape', async () => {
    await enTx(async (tx) => {
      const a = await companiaVieja(tx, 'F', [{ concepto: 'logistica', tipo: null, valor: 45000, creada: '2026-07-10T10:00:00Z' }]);
      await tx.unsafe(SQL_0182);
      const tipos = await tx`SELECT contype, count(*)::int AS n FROM pg_constraint WHERE conrelid = 'flito_tarifas_vigencias'::regclass GROUP BY contype ORDER BY contype`;
      expect(Object.fromEntries(tipos.map((t) => [t.contype, t.n]))).toMatchObject({ c: 5, x: 1, p: 1, f: 3 });
      const [idx] = await tx`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_flito_tarifas_vigencias_abierta'`;
      expect(idx!.indexdef).toMatch(/UNIQUE INDEX/);
      expect(idx!.indexdef).toMatch(/WHERE \(vigente_hasta IS NULL\)/);
      expect((await tx`SELECT installed_version FROM pg_available_extensions WHERE name = 'btree_gist'`)[0]!.installed_version).not.toBeNull();

      const codigo = async (fn: () => Promise<unknown>) => fn().then(() => null, (e: { code?: string }) => e.code ?? null);
      // Una segunda ABIERTA de la misma llave: el índice parcial (23505) o la EXCLUDE (23P01), la que llegue primero.
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor) VALUES (${a}, 'logistica', NULL, 1)`)))
        .toMatch(/^(23505|23P01)$/);
      // Una CERRADA que solapa con la abierta [2026-07-10, ∞): solo la EXCLUDE la ve.
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, cerrado_en)
        VALUES (${a}, 'logistica', NULL, 1, '2026-07-01T00:00:00Z', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')`)))
        .toBe('23P01');
      // Una CERRADA anterior sin solape ([2026-07-01, 2026-07-10)) sí cabe: el rango es semiabierto.
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor, vigente_desde, vigente_hasta, cerrado_en)
        VALUES (${a}, 'logistica', NULL, 1, '2026-07-01T00:00:00Z', '2026-07-10T10:00:00Z', '2026-07-10T10:00:00Z')`)))
        .toBeNull();
      // Los CHECK del catálogo cerrado.
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor) VALUES (${a}, 'tramite_digital', 'Matricula', 1)`))).toBe('23514');
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor) VALUES (${a}, 'tramite_digital', NULL, 1)`))).toBe('23514');
      expect(await codigo(() => tx.savepoint((s) => s`INSERT INTO flito_tarifas_vigencias (compania_id, concepto, tipo_tramite, valor) VALUES (${a}, 'tramite_digital', 'OTROS', -1)`))).toBe('23514');
    });
  }, 60_000);

  it('permisos tras la 0182: `borrar` no existe, el auditor no tiene ninguna función de tarifas, las dos nuevas son de admin y financiera', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0182);
      expect((await tx`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${RETIRADA}`)[0]!.n).toBe(0);
      expect((await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${RETIRADA}`)[0]!.n).toBe(0);
      expect((await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE rol_codigo = 'auditor' AND funcion_codigo LIKE 'parametrizacion.tarifas.%'`)[0]!.n).toBe(0);
      const filas = await tx`SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx([...NUEVAS])} ORDER BY funcion_codigo, rol_codigo`;
      expect(filas.map((f) => `${f.rol_codigo} ${f.funcion_codigo}`)).toEqual(
        [...NUEVAS].flatMap((c) => [`admin ${c}`, `financiera ${c}`]),
      );
      const nuevas = await tx`SELECT codigo, tipo, activo FROM permisos_funciones WHERE codigo IN ${tx([...NUEVAS])} ORDER BY codigo`;
      expect(nuevas.map((f) => f.codigo)).toEqual([...NUEVAS]);
      expect(nuevas.every((f) => f.tipo === 'operacion' && f.activo === true)).toBe(true);
      // Las tres funciones que sobreviven siguen para admin y financiera.
      expect((await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE rol_codigo IN ('admin', 'financiera') AND funcion_codigo LIKE 'parametrizacion.tarifas.%'`)[0]!.n).toBe(10);
    });
  }, 60_000);

  it('idempotencia fuerte: la segunda pasada (sin tabla vieja) no toca ni una fila de vigencias ni de permisos', async () => {
    const { primera, segunda } = await enTx(async (tx) => {
      await companiaVieja(tx, 'G', [
        { concepto: 'tramite_digital', tipo: null, valor: 270000, creada: '2026-07-10T10:00:00Z' },
        { concepto: 'logistica', tipo: null, valor: 45000, creada: '2026-07-11T10:00:00Z' },
      ]);
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(compania_id||concepto||coalesce(tipo_tramite,'')||valor||vigente_desde||coalesce(vigente_hasta::text,'')||coalesce(fijado_por_id::text,'')||fijado_en||coalesce(cerrado_por_id::text,'')||coalesce(cerrado_en::text,''), ',' ORDER BY compania_id, concepto, tipo_tramite, vigente_desde)) FROM flito_tarifas_vigencias) AS v,
          (SELECT count(*)::int FROM flito_tarifas_vigencias) AS nv,
          (SELECT md5(string_agg(codigo||modulo||nombre_negocio||descripcion||tipo||activo::text, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
          (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS r
      `)[0];
      await tx.unsafe(SQL_0182);
      const a = await huella();
      await tx.unsafe(SQL_0182);
      const d = await huella();
      return { primera: a, segunda: d };
    });
    expect(primera!.nv).toBeGreaterThanOrEqual(4);
    expect(segunda).toEqual(primera);
  }, 60_000);
});
