// HU #12833 (Feature #12824) — Migración 0208: columnas de la dirección confirmada en
// `flito_impuestos`, backfill de lo ya analizado (decisión de David, 2026-09-24) y la función
// `impuestos.tramite.corregir_direccion` sembrada SOLO a admin (AC7). Calco de migracion-0203.test.ts.
//
// Se afirma «la anterior es 0207_» y NUNCA «la 0208 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima).

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
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0208_flito_impuestos_direccion_factura.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0208 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0208.replace(/--[^\n]*/g, '');

const CODIGO = 'impuestos.tramite.corregir_direccion';
const LLAVE = 'flito-impuestos/flito-impuestos.direccion.routes.ts PATCH /:id/direccion';
const NOMBRE = 'Corregir dirección del comprador';
const COLUMNAS = [
  'direccion_factura', 'municipio_factura', 'departamento_factura', 'direccion_fuente',
  'direccion_pendiente_revision', 'direccion_confirmada_por_id', 'direccion_confirmada_por_nombre', 'direccion_confirmada_en',
];

describe('0208 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0208)).toEqual([]);
    expect(SQL_0208).toMatch(/DO \$resumen0208\$/);
    expect(SQL_0208).toMatch(/END \$resumen0208\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0208.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0208_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0207_ (HU #12827) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0207_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0208.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #12833/);
    expect(cabecera).toMatch(/Feature #12824/);
  });

  it('las 8 columnas, cada una ADD COLUMN IF NOT EXISTS; CHECK de la fuente; FK a users con SET NULL', () => {
    for (const c of COLUMNAS) expect(SIN_COMENTARIOS, c).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s`));
    expect(SIN_COMENTARIOS.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(direccion_fuente IN \('factura', 'manual'\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/direccion_pendiente_revision\s+boolean NOT NULL DEFAULT false/);
    expect(SIN_COMENTARIOS).toMatch(/direccion_confirmada_por_id\s+integer REFERENCES users\(id\) ON DELETE SET NULL/);
    // Nunca en flito_compradores: el sync la borra y reinserta (AC1).
    expect(SIN_COMENTARIOS).not.toMatch(/flito_compradores/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDROP\b/i);
  });

  it('backfill: solo análisis terminado y sin fuente; la confirmación exige confiable y no vacía; luego pendiente', () => {
    const updates = SIN_COMENTARIOS.match(/UPDATE flito_impuestos[\s\S]*?;/g)!;
    expect(updates).toHaveLength(2);
    const [confirma, pendiente] = updates as [string, string];
    for (const u of updates) {
      expect(u).toMatch(/analisis_estado IN \('completado', 'error_analisis'\)/);
      expect(u).toMatch(/direccion_fuente IS NULL/);
      expect(u).toMatch(/AND NOT direccion_pendiente_revision/);
    }
    expect(confirma).toMatch(/direccion_fuente\s+= 'factura'/);
    expect(confirma).toMatch(/\(extraccion_factura_venta->'direccion'->>'confiable'\)::boolean/);
    expect(confirma).toMatch(/nullif\(trim\(extraccion_factura_venta->'direccion'->>'valor'\), ''\) IS NOT NULL/);
    // Municipio/departamento solo si su campo es confiable (si no, NULL y el lector cae a FLIT).
    expect(confirma).toMatch(/municipio_factura\s+= CASE WHEN \(extraccion_factura_venta->'municipio'->>'confiable'\)::boolean/);
    expect(confirma).toMatch(/departamento_factura\s+= CASE WHEN \(extraccion_factura_venta->'departamento'->>'confiable'\)::boolean/);
    expect(pendiente).toMatch(/SET direccion_pendiente_revision = true/);
    // El orden importa: primero se confirma lo confiable, después se marca el resto.
    expect(SIN_COMENTARIOS.indexOf(confirma)).toBeLessThan(SIN_COMENTARIOS.indexOf(pendiente));
  });

  it('siembra la operación con los textos byte a byte del catálogo, en su sub-router', () => {
    const funciones = funcionesDeSql([SQL_0208]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(LLAVE);
    expect(op!.nombre).toBe(NOMBRE);
    expect(funciones.get(CODIGO)).toEqual({ codigo: CODIGO, modulo: 'impuestos', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO);
    expect(f?.tipo).toBe('operacion');
    expect(f?.modulo).toBe('impuestos');
  });

  it('la foto (GUARDAS_MEDIDAS) la lleva como guarda de ruta, no heredada, solo admin', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE);
    expect(g).toBeDefined();
    expect(g!.roles).toEqual(['admin']);
    expect(g!.heredada).toBe(false);
  });

  it('AC7: reparte SOLO a admin (1 fila), igual en el SQL que en el catálogo', () => {
    const reparto = repartoDeSql([SQL_0208]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    expect(catalogoCompleto().find((c) => c.codigo === CODIGO)!.roles).toEqual(['admin']);
    expect(repartoDePartida().filter(([, c]) => c === CODIGO).map(([r]) => r)).toEqual(['admin']);
  });

  it('no retira nada y el helper de paridad la lee detrás de la 0205; plegado, admin sí y los demás no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0205_permisos_reagrupar_modulos.sql') + 1);
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(CODIGO)).toBe(true);
    for (const rol of ['proveedor', 'gestor_impuestos', 'auditor']) expect(total.get(rol)?.has(CODIGO) ?? false, rol).toBe(false);
  });

  it('idempotente: ON CONFLICT DO NOTHING en las dos siembras y el resumen cuenta por código exacto', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'impuestos\.%'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0208 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 8 columnas, 1 función, 1 de reparto (solo admin)', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0208);
      await tx.unsafe(SQL_0208);
      const cols = await tx<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'flito_impuestos' AND column_name IN ${tx(COLUMNAS)}`;
      expect(cols).toHaveLength(8);
      const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO}`;
      expect(f!.n).toBe(1);
      const reparto = await tx<{ rol_codigo: string }[]>`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
      expect(reparto).toEqual([{ rol_codigo: 'admin' }]);
    });
  }, 60_000);
});
