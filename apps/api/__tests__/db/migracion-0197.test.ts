// HU #12591 — Migración 0197: la función `impuestos.recibos.cargar_caja` (módulo impuestos, tipo
// operacion) repartida SOLO a admin. El gestor de impuestos NO la recibe de partida aunque tenga
// `impuestos.recibos.cargar` (AC1/AC2). Calco de migracion-0193.test.ts.
//
// Se afirma «la anterior es 0196_» y NUNCA «la 0197 es la última»: congelar el tip pone rojo el CI
// del PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · M-C — añadir `('gestor_impuestos', 'impuestos.recibos.cargar_caja')` al reparto: cae «reparte
//     solo a admin» (keys ≠ ['admin']) y, si el catálogo no cambia, la paridad SQL ≠ catálogo.
//   · Cambiar el texto del nombre o la descripción: cae «byte a byte del catálogo».

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0197_permiso_recibo_caja.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const RUTA = path.join(DIR, ARCHIVO);
const SQL_0197 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0197.replace(/--[^\n]*/g, '');

const CODIGO = 'impuestos.recibos.cargar_caja';

describe('0197 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0196', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0197)).toEqual([]);
    expect(SQL_0197).toMatch(/DO \$resumen0197\$/);
    expect(SQL_0197).toMatch(/END \$resumen0197\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0197.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0197_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0196_flito_impuestos_liquidado_en.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Feature/HU) y autor', () => {
    const cabecera = SQL_0197.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12589/);
    expect(cabecera).toMatch(/HU #12591/);
  });

  it('siembra exactamente UNA función (impuestos, operacion, «Cargar recibo de caja») con los textos byte a byte del catálogo', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    // Sin DDL: la 0197 es SOLO permisos (no toca schema.ts).
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE INDEX/);
    const funciones = funcionesDeSql([SQL_0197]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO);
    expect(op).toBeDefined();
    expect(op!.llave).toBe('flito-impuestos/flito-impuestos.routes.ts POST /:id/recibo-caja');
    expect(funciones.get(CODIGO)).toEqual({
      codigo: CODIGO, modulo: 'impuestos', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
    });
    expect(op!.nombre).toBe('Cargar recibo de caja');
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO);
    expect(f).toBeDefined();
    expect(f!.tipo).toBe('operacion');
    expect(f!.modulo).toBe('impuestos');
  });

  it('reparte SOLO a admin, igual en el SQL que en el catálogo; gestor_impuestos NO (M-C)', () => {
    const reparto = repartoDeSql([SQL_0197]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    expect(reparto.get('gestor_impuestos')?.has(CODIGO) ?? false).toBe(false);
    // Paridad con inventario.generado.ts (lo que siembra testToken vía repartoDePartida).
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin']);
    expect(repartoDePartida().filter(([, c]) => c === CODIGO)).toEqual([['admin', CODIGO]]);
  });

  it('los cardinales del catálogo suben en 1 operación de impuestos (18 → 19; 20 con la 0203 del Bug #12642)', () => {
    // El centinela cuenta TODAS las operaciones de impuestos, así que cada función posterior lo
    // mueve: la 0203 (Bug #12642, `impuestos.excel.exportar_pago`, guarda en línea del mismo
    // fichero) lo dejó en 20. Lo que esta migración prueba es «+1», no el número absoluto.
    const impuestos = catalogoCompleto().filter((c) => c.tipo === 'operacion' && c.modulo === 'impuestos');
    expect(impuestos).toHaveLength(20);
    expect(OPERACIONES_DECLARADAS.filter((o) => o.llave.startsWith('flito-impuestos/flito-impuestos.routes.ts '))).toHaveLength(20);
    expect(impuestos.map((c) => c.codigo)).toContain(CODIGO);
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0193; plegado, admin sí y gestor/auditor no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0193_tramite_servicios_adicionales.sql') + 1);
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(CODIGO)).toBe(true);
    expect(total.get('gestor_impuestos')?.has(CODIGO) ?? false).toBe(false);
    expect(total.get('auditor')?.has(CODIGO) ?? false).toBe(false);
  });

  it('el resumen final revienta si no cuadra 1 función + 1 reparto (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_funcion <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0197 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 1 función, 1 reparto y ese reparto es admin', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0197);
      await tx.unsafe(SQL_0197);
      const [funciones] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO}`;
      expect(funciones!.n).toBe(1);
      const reparto = await tx<{ rol_codigo: string }[]>`
        SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO} ORDER BY rol_codigo`;
      expect(reparto).toEqual([{ rol_codigo: 'admin' }]);
    });
  }, 60_000);
});
