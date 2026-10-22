// HU #12547 — Migración 0195: la fila de mapeo de `servicio_adicional` en los DOS ambientes de
// `siigo_mapeo_conceptos`, con `factura_linea_propia = true`, `linea_propia_pendiente = false` y
// SIN código de producto. Calco de migracion-0194.test.ts y de la semilla de la 0128.
//
// Se afirma «la anterior es 0194_» y NUNCA «la 0195 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · M-01 — quitar el `ON CONFLICT DO NOTHING`: cae el aserto estático y, contra base, la segunda
//     pasada del P6 (23505 contra idx_siigo_mapeo_unico_activo).
//   · M-02 — sembrar un solo ambiente: cae el aserto de `('pruebas'), ('produccion')` y, contra
//     base, el conteo de 2 filas.
//   · M-03 — sembrar `factura_linea_propia = false` (o `linea_propia_pendiente = true`): cae el
//     aserto de la tupla y, contra base, el de las columnas. Apagado, `lineasDe` descartaría el
//     concepto en silencio y ninguna factura llevaría los servicios.
//   · M-04 — sembrar `codigo_producto` o `validacion_estado`: caen los asertos de ausencia. Un
//     producto inventado emitiría ante la DIAN con un código que nadie configuró, y un
//     `validacion_estado` distinto del default movería VALIDACION_BLOQUEA_FACTURACION sin HU.
//   · M-05 — cambiar el `RAISE EXCEPTION` de `< 2` a `< 1`: cae el aserto del resumen; con él, una
//     migración que solo sembrara un ambiente pasaría el CD en verde.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CONCEPTOS_FACTURABLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0195_siigo_mapeo_servicio_adicional.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0195 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0195.replace(/--[^\n]*/g, '');

describe('0195 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0194', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0195)).toEqual([]);
    expect(SQL_0195).toMatch(/DO \$resumen0195\$/);
    expect(SQL_0195).toMatch(/END \$resumen0195\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0195.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0195_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0194_liquidaciones_valor_servicios_adicionales.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0195.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12544/);
    expect(cabecera).toMatch(/HU #12547/);
  });

  it('siembra `servicio_adicional` con línea propia y sin pendiente, en los dos ambientes (M-02, M-03)', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO siigo_mapeo_conceptos \(ambiente, concepto, factura_linea_propia, linea_propia_pendiente, notas\)/);
    expect(SIN_COMENTARIOS).toContain("('pruebas'), ('produccion')");
    // La tupla exacta: concepto, línea propia, pendiente, notas.
    const tuplas = [...SIN_COMENTARIOS.matchAll(/\('([a-z_]+)',\s*(true|false),\s*(true|false),\s*(NULL|'[^']*')\)/g)]
      .map((m) => [m[1], m[2], m[3], m[4]]);
    expect(tuplas).toEqual([['servicio_adicional', 'true', 'false', 'NULL']]);
    // El concepto sembrado existe en la constante compartida: la migración y el enum no divergen.
    expect(CONCEPTOS_FACTURABLES).toContain('servicio_adicional');
  });

  it('idempotente por el índice único PARCIAL: ON CONFLICT DO NOTHING sin target (M-01)', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT DO NOTHING;/);
    // Sin target a propósito: con el `index_predicate` Postgres SÍ admite un índice parcial como
    // target, pero obligaría a repetir la expresión del índice y a mantenerla en sincronía. Que
    // nadie lo «arregle» creyendo que es obligatorio.
    expect(SIN_COMENTARIOS).not.toMatch(/ON CONFLICT\s*\(/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/i);
  });

  it('no siembra producto, ni confirmación de contabilidad, ni validación (M-04)', () => {
    // Solo la sentencia INSERT: el bloque DO del resumen sí nombra `codigo_producto` (cuenta
    // cuántas filas ya lo tienen), y arrastrarlo aquí dejaría el aserto rojo sin que la semilla
    // hubiera sembrado nada.
    const desde = SIN_COMENTARIOS.indexOf('INSERT INTO siigo_mapeo_conceptos');
    const insert = SIN_COMENTARIOS.slice(desde, SIN_COMENTARIOS.indexOf(';', desde));
    expect(insert).not.toMatch(/codigo_producto/);
    expect(insert).not.toMatch(/confirmado_contabilidad/);
    expect(insert).not.toMatch(/clasificacion_tributaria/);
    // `validacion_estado` toma su DEFAULT: VALIDACION_BLOQUEA_FACTURACION lo mira, y sembrarlo
    // movería el bloqueo de facturación sin que ninguna HU lo pida.
    expect(insert).not.toMatch(/validacion_estado/);
  });

  it('no toca el esquema: es una semilla, no una DDL', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/ALTER TABLE|CREATE TABLE|CREATE INDEX|DROP /i);
    expect(SIN_COMENTARIOS).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
  });

  it('el resumen revienta si no quedaron las dos filas (M-05)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_filas < 2 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0195:/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0195 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe: quedan DOS filas, una por ambiente, con línea propia y sin producto (M-01, M-02, M-03, M-04)', async () => {
    await enTx(async (tx) => {
      // Estado PREVIO reproducido dentro de la transacción: la BD local ya puede tener la fila.
      await tx`DELETE FROM siigo_mapeo_conceptos WHERE concepto = 'servicio_adicional'`;
      await tx.unsafe(SQL_0195);
      await tx.unsafe(SQL_0195);

      const filas = await tx<{
        ambiente: string; propia: boolean; pendiente: boolean;
        producto: string | null; confirmado: boolean; validacion: string; activo: boolean;
      }[]>`
        SELECT ambiente, factura_linea_propia AS propia, linea_propia_pendiente AS pendiente,
               codigo_producto AS producto, confirmado_contabilidad AS confirmado,
               validacion_estado AS validacion, activo
          FROM siigo_mapeo_conceptos
         WHERE concepto = 'servicio_adicional'
         ORDER BY ambiente`;

      expect(filas.map((f) => f.ambiente)).toEqual(['produccion', 'pruebas']);
      for (const f of filas) {
        expect(f.propia).toBe(true);
        expect(f.pendiente).toBe(false);
        expect(f.producto).toBeNull();
        expect(f.confirmado).toBe(false);
        expect(f.validacion).toBe('sin_validar');
        expect(f.activo).toBe(true);
      }
    }, 60_000);
  }, 60_000);

  it('no pisa lo ya parametrizado: una fila con producto sobrevive a la migración (control positivo)', async () => {
    await enTx(async (tx) => {
      await tx`DELETE FROM siigo_mapeo_conceptos WHERE concepto = 'servicio_adicional'`;
      await tx.unsafe(SQL_0195);
      // Quien parametriza elige el producto…
      await tx`
        UPDATE siigo_mapeo_conceptos SET codigo_producto = 'FLIT-SERVICIO-ADICIONAL'
         WHERE concepto = 'servicio_adicional' AND ambiente = 'pruebas'`;
      // …y una reejecución de la migración no lo borra.
      await tx.unsafe(SQL_0195);

      const [fila] = await tx<{ producto: string | null }[]>`
        SELECT codigo_producto AS producto FROM siigo_mapeo_conceptos
         WHERE concepto = 'servicio_adicional' AND ambiente = 'pruebas'`;
      expect(fila!.producto).toBe('FLIT-SERVICIO-ADICIONAL');
      const [{ n }] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM siigo_mapeo_conceptos WHERE concepto = 'servicio_adicional'`;
      expect(n).toBe('2');
    }, 60_000);
  }, 60_000);
});
