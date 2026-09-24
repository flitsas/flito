// HU #12716 — Migración 0205: cada pantalla FLITO se agrupa con las acciones de su módulo. Solo DML
// sobre `permisos_funciones.modulo`: 47 tuplas `(codigo, modulo)` en un `UPDATE … FROM (VALUES …)`
// idempotente (`IS DISTINCT FROM`), de las que 46 cambian el valor (`pagina.transito_organismos` ya
// estaba en `transito`). Ni códigos, ni `permisos_rol_funcion`, ni `permisos_usuario_funcion` (AC6).
//
// Se afirma «la anterior es 0204_» y NUNCA «la 0205 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · cambiar una tupla del SQL (`'soat'` → `'soatx'`): cae «las tuplas son `reagrupaciones()`» y el
//     plegado de la 0179 (`leerFuncionesSembradas` vs generado).
//   · quitar `AND f.modulo IS DISTINCT FROM v.modulo`: contra base, la 2.ª pasada deja de ser
//     UPDATE 0 (el helper de paridad tampoco reconocería la forma y `reagrupadas.size` caería a 0).
//   · escribir el UPDATE de otra forma (CASE, sin alias `v`): cae «una sola forma canónica».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerReagrupacionesSembradas, leerRepartoSembrado,
  leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { reagrupaciones } from '../../src/modules/permisos/catalogo-agrupacion.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0205_permisos_reagrupar_modulos.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const RUTA = path.join(DIR, ARCHIVO);
const SQL_0205 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0205.replace(/--[^\n]*/g, '');

const PARES = reagrupaciones();
const MAPA = new Map(PARES);

/** Las tuplas `('codigo', 'modulo')` del VALUES tal como están en el archivo, en su orden. */
function tuplasDelArchivo(): [string, string][] {
  const bloque = /FROM \(VALUES([\s\S]*?)\) AS v\(codigo, modulo\)/.exec(SIN_COMENTARIOS)?.[1] ?? '';
  return [...bloque.matchAll(/\('((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)/g)].map((m) => [m[1]!, m[2]!]);
}

describe('0205 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; número único; la anterior es la 0204 (no «es la última»)', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0205)).toEqual([]);
    expect(SQL_0205.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0205_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0204_tarifas_primera_fijacion_desde_siempre.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0205.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12716/);
  });

  it('solo DML sobre `modulo`: un único UPDATE en la forma canónica, sin CREATE/ALTER/DROP/INSERT/DELETE ni otra columna', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|DELETE|TRUNCATE)\b/i);
    expect(SIN_COMENTARIOS.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(SIN_COMENTARIOS).toMatch(/UPDATE permisos_funciones AS f\s+SET modulo = v\.modulo\s+FROM \(VALUES/);
    expect(SIN_COMENTARIOS).toMatch(/\) AS v\(codigo, modulo\)\s+WHERE f\.codigo = v\.codigo\s+AND f\.modulo IS DISTINCT FROM v\.modulo;/);
    // Solo `modulo` en el SET: ni `codigo`, ni `tipo`, ni `activo` (AC6: nadie gana ni pierde nada).
    expect(SIN_COMENTARIOS.match(/\bSET\b[^;]*?\bFROM\b/i)![0]).toBe('SET modulo = v.modulo\n  FROM');
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_rol_funcion|permisos_usuario_funcion|session_invalidated_at/);
    // El bloque va entre las marcas que dicen que se generó.
    expect(SQL_0205).toMatch(/-- REAGRUPACIÓN GENERADA \(inicio\)/);
    expect(SQL_0205).toMatch(/-- REAGRUPACIÓN GENERADA \(fin\)/);
  });

  it('las tuplas del archivo son EXACTAMENTE `reagrupaciones()`: 47 pares, mismos valores, orden por código', () => {
    const tuplas = tuplasDelArchivo();
    expect(tuplas).toHaveLength(47);
    expect(tuplas).toEqual([...PARES]);
    // Y todas existen en el catálogo del código con ESE módulo (la 0205 escribe lo que el código dice).
    const catalogo = new Map(catalogoCompleto().map((f) => [f.codigo, f.modulo]));
    for (const [codigo, modulo] of tuplas) expect(catalogo.get(codigo), codigo).toBe(modulo);
  });

  it('el bloque es byte a byte lo que produce `generar-seed-permisos.ts --reagrupar`', () => {
    const salida = execFileSync('npx', ['tsx', 'src/scripts/generar-seed-permisos.ts', '--reagrupar'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    const inicio = SQL_0205.indexOf('-- REAGRUPACIÓN GENERADA (inicio)\n') + '-- REAGRUPACIÓN GENERADA (inicio)\n'.length;
    const fin = SQL_0205.indexOf('-- REAGRUPACIÓN GENERADA (fin)');
    expect(SQL_0205.slice(inicio, fin)).toBe(salida);
  }, 60_000);

  it('el helper de paridad la pliega: `leerReagrupacionesSembradas()` devuelve los 47 pares y `funcionesDeSql` cambia el módulo', () => {
    // Posición RELATIVA (detrás de la 0203), nunca «es la última»: la 0208 (HU #12833) va detrás.
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0203_permiso_excel_exportar_pago.sql') + 1);
    const sembradas = leerReagrupacionesSembradas([ARCHIVO]);
    expect(sembradas.size).toBe(47);
    expect([...sembradas.entries()].sort()).toEqual([...MAPA.entries()].sort());
    // Plegada sobre un INSERT mínimo: el módulo cambia; sobre nada, revienta (error de orden).
    const insert = `INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
      ('pagina.flito_soat', 'flito_soat_e_impuestos', 'SOAT', 'Entrar.', 'pagina') ON CONFLICT (codigo) DO NOTHING;`;
    const solo = `UPDATE permisos_funciones AS f\n   SET modulo = v.modulo\n  FROM (VALUES\n    ('pagina.flito_soat', 'soat')\n  ) AS v(codigo, modulo)\n WHERE f.codigo = v.codigo\n   AND f.modulo IS DISTINCT FROM v.modulo;`;
    expect(funcionesDeSql([insert, solo]).get('pagina.flito_soat')!.modulo).toBe('soat');
    expect(() => funcionesDeSql([solo])).toThrow(/no sembrada antes: pagina\.flito_soat/);
  });

  it('no siembra ni retira funciones ni reparto: el reparto plegado hasta la 0205 es el mismo que hasta la 0203 (AC6)', () => {
    // Plegada SOLA revienta (UPDATE sobre nada sembrado): eso ya dice que no trae INSERT propio.
    expect(() => funcionesDeSql([SQL_0205])).toThrow(/no sembrada antes/);
    expect(repartoDeSql([SQL_0205]).size).toBe(0);
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    const hasta0203 = MIGRACIONES_CON_REPARTO.filter((m) => m < ARCHIVO);
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    const hasta0205 = MIGRACIONES_CON_REPARTO.filter((m) => m <= ARCHIVO);
    expect(aPares(leerRepartoSembrado(hasta0205))).toEqual(aPares(leerRepartoSembrado(hasta0203)));
  });

  it('los módulos que nacen y los que desaparecen son los de la HU (AC1, AC2)', () => {
    const destinos = new Set(PARES.map(([, m]) => m));
    for (const m of ['clientes', 'tarifas', 'servicios_adicionales', 'catalogos_compartidos', 'transito', 'tramites']) {
      expect(destinos).toContain(m);
    }
    for (const m of ['flito_soat_e_impuestos', 'parametrizacion', 'sync', 'finanzas']) expect(destinos).not.toContain(m);
    expect(PARES.filter(([c]) => c.startsWith('pagina.'))).toHaveLength(24);
    expect(PARES.filter(([c]) => !c.startsWith('pagina.'))).toHaveLength(23);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0205 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  const huella = (tx: postgres.TransactionSql) => tx`
    SELECT
      (SELECT md5(string_agg(codigo||modulo||nombre_negocio||descripcion||tipo||activo::text, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
      (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS rf,
      (SELECT md5(string_agg(user_id::text||funcion_codigo||efecto, ',' ORDER BY user_id, funcion_codigo)) FROM permisos_usuario_funcion) AS uf`;

  it('segunda pasada: 0 filas afectadas y la huella de las tres tablas no cambia', async () => {
    const { afectadas2, antes, despues } = await enTx(async (tx) => {
      await tx.unsafe(SQL_0205);                 // 1.ª: sobre la base local ya puede ser 0 (aplicada) o 46
      const a = (await huella(tx))[0];
      const r = await tx.unsafe(SQL_0205);       // 2.ª: siempre 0
      const d = (await huella(tx))[0];
      return { afectadas2: r.count, antes: a, despues: d };
    });
    expect(afectadas2).toBe(0);
    expect(despues).toEqual(antes);
  }, 60_000);

  it('tras aplicarla, los 47 códigos del mapa llevan en la base el módulo del mapa, y el reparto no se mueve (AC6)', async () => {
    await enTx(async (tx) => {
      const repartoAntes = (await huella(tx))[0].rf;
      await tx.unsafe(SQL_0205);
      const filas = await tx<{ codigo: string; modulo: string }[]>`
        SELECT codigo, modulo FROM permisos_funciones WHERE codigo = ANY(${[...MAPA.keys()]}) ORDER BY codigo`;
      expect(filas).toHaveLength(47);
      for (const f of filas) expect(f.modulo, f.codigo).toBe(MAPA.get(f.codigo));
      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_funciones WHERE modulo IN ('flito_soat_e_impuestos', 'parametrizacion', 'sync')`;
      expect(n).toBe(0);
      expect((await huella(tx))[0].rf).toBe(repartoAntes);
    });
  }, 60_000);
});
