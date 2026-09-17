// HU #12654 (Feature #12607, Épica #12245) — Migración 0202: la operación de F3 del módulo
// `comprobantes` (aceptar la diferencia de un comprobante), repartida a admin + financiera.
// Calco de migracion-0201.test.ts: la 0202 NO crea ni altera nada (las columnas
// `diferencia_aceptada_*` existen desde la 0198).
//
// Se afirma «la anterior es 0201_» y NUNCA «la 0202 es la última»: congelar el tip pone rojo el CI del
// PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima).
//
// Mutantes nombrados:
//   · Quitar la `op(...)` del catálogo → «paridad SQL ≠ catálogo» cae (y el arranque también:
//     `verificarCatalogoAlArrancar` compara base y código).
//   · Cambiar un texto de nombre/descripción → «byte a byte del catálogo».
//   · Quitar la tupla del reparto de financiera → «reparte a admin y financiera (2 filas)» cae y la
//     paridad de la 0179 (permisos-seed-sql) también.
//   · Añadir `ALTER TABLE flito_comprobantes` → «no crea ni altera columnas» cae.
//   · Contar `n_ops` por `modulo = 'comprobantes'` → «por código exacto» cae.
//   · Quitar `exigirFuncion` de la ruta → permisos.reconduccion-cierre (260 montajes) cae.

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
const ARCHIVO = '0202_comprobantes_diferencia.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0202 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0202.replace(/--[^\n]*/g, '');

const OP = 'comprobantes.diferencia.aceptar';
const RUTA = 'flito-comprobantes/flito-comprobantes.routes.ts POST /:id/diferencia/aceptar';
const NOMBRE = 'Aceptar la diferencia de un comprobante';

describe('0202 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0202)).toEqual([]);
    expect(SQL_0202).toMatch(/DO \$resumen0202\$/);
    expect(SQL_0202).toMatch(/END \$resumen0202\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0202.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0202_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0201_ (HU #12629) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0201_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Épica/HU) y autor', () => {
    const cabecera = SQL_0202.split('\n').slice(0, 13).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Epica #12245/);
    expect(cabecera).toMatch(/HU #12654/);
  });

  it('NO crea ni altera columnas de flito_comprobantes ni de ninguna tabla, sin unaccent: solo dos INSERT (siembra) y el DO', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent/i);
    expect(SIN_COMENTARIOS).not.toMatch(/flito_comprobantes/);
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/);
  });

  it('siembra UNA operación (comprobantes, tipo operacion) con los textos byte a byte del catálogo', () => {
    const funciones = funcionesDeSql([SQL_0202]);
    expect([...funciones.keys()]).toEqual([OP]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === OP);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(RUTA);
    expect(op!.nombre).toBe(NOMBRE);
    expect(funciones.get(OP)).toEqual({ codigo: OP, modulo: 'comprobantes', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
    const f = catalogoCompleto().find((c) => c.codigo === OP);
    expect(f).toBeDefined();
    expect(f!.tipo).toBe('operacion');
    expect(f!.modulo).toBe('comprobantes');
  });

  it('reparte a admin y financiera (2 filas), igual en el SQL que en el catálogo; auditor NO', () => {
    const reparto = repartoDeSql([SQL_0202]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    for (const rol of ['admin', 'financiera']) expect([...reparto.get(rol)!]).toEqual([OP]);
    expect(reparto.get('auditor')).toBeUndefined();
    expect([...reparto.values()].reduce((n, s) => n + s.size, 0)).toBe(2);
    expect(catalogoCompleto().find((c) => c.codigo === OP)!.roles).toEqual(['admin', 'financiera']);
    expect(repartoDePartida().filter(([, c]) => c === OP).map(([r]) => r).sort()).toEqual(['admin', 'financiera']);
  });

  it('los cardinales del catálogo: 9 operaciones de comprobantes (5 de la 0198 + 3 de la 0201 + 1), y las 9 llaves del fichero de rutas', () => {
    expect(catalogoCompleto().filter((c) => c.tipo === 'operacion' && c.modulo === 'comprobantes')).toHaveLength(9);
    expect(OPERACIONES_DECLARADAS.filter((o) => o.llave.startsWith('flito-comprobantes/flito-comprobantes.routes.ts '))).toHaveLength(9);
  });

  it('no retira nada y el helper de paridad la lee después de la 0201; plegado, admin y financiera sí y auditor no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0201_comprobantes_aplicar.sql') + 1);
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(OP)).toBe(true);
    expect(total.get('financiera')!.has(OP)).toBe(true);
    expect(total.get('auditor')?.has(OP) ?? false).toBe(false);
  });

  it('el resumen final revienta si no cuadra 1 op + 2 de reparto, contando por código exacto (no por módulo ni prefijo)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 OR n_reparto <> 2 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/n_ops FROM permisos_funciones WHERE modulo = 'comprobantes'/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'comprobantes\.%'/);
    expect(SIN_COMENTARIOS).toMatch(/INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo = 'comprobantes\.diferencia\.aceptar'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0202 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 1 función, 2 de reparto', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0202);
      await tx.unsafe(SQL_0202);
      const [funciones] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${OP}`;
      expect(funciones!.n).toBe(1);
      const reparto = await tx<{ rol_codigo: string; n: number }[]>`
        SELECT rol_codigo, count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${OP} GROUP BY rol_codigo ORDER BY rol_codigo`;
      expect(reparto).toEqual([{ rol_codigo: 'admin', n: 1 }, { rol_codigo: 'financiera', n: 1 }]);
    });
  }, 60_000);
});
