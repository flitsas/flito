// HU #12629 (Feature #12606, Épica #12245) — Migración 0201: las TRES operaciones de F2 del módulo
// `comprobantes` (buscar trámites, aplicar o adjuntar, descartar), repartidas a admin + financiera.
// Calco de migracion-0198.test.ts sin la parte de tabla: la 0201 NO crea ni altera nada.
//
// Se afirma «la anterior es 0200_» y NUNCA «la 0201 es la última»: congelar el tip pone rojo el CI del
// PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). La 0200_ es la del Feature #12621
// (sesión paralela): si en el checkout aún no existe, ese `it` está rojo hasta que entre en develop, y
// el PR de esta HU se abre después.
//
// Mutantes nombrados:
//   · Quitar una `op(...)` del catálogo → «paridad SQL ≠ catálogo» cae (y el arranque también:
//     `verificarCatalogoAlArrancar` compara base y código).
//   · Cambiar un texto de nombre/descripción → «byte a byte del catálogo».
//   · Quitar una tupla del reparto de financiera → «reparte a admin y financiera (6 filas)» cae y la
//     paridad de la 0179 (permisos-seed-sql) también (AC1).
//   · Añadir `ALTER TABLE flito_comprobantes` → «no crea ni altera columnas» cae.
//   · Contar `n_ops` por `modulo = 'comprobantes'` → «por código exacto» cae.

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
const ARCHIVO = '0201_comprobantes_aplicar.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0201 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0201.replace(/--[^\n]*/g, '');

const OPS = ['comprobantes.tramites.buscar', 'comprobantes.comprobante.aplicar', 'comprobantes.comprobante.descartar'] as const;
const RUTAS: Record<(typeof OPS)[number], string> = {
  'comprobantes.tramites.buscar': 'flito-comprobantes/flito-comprobantes.routes.ts POST /tramites/buscar',
  'comprobantes.comprobante.aplicar': 'flito-comprobantes/flito-comprobantes.routes.ts POST /:id/aplicar',
  'comprobantes.comprobante.descartar': 'flito-comprobantes/flito-comprobantes.routes.ts POST /:id/descartar',
};
const NOMBRES: Record<(typeof OPS)[number], string> = {
  'comprobantes.tramites.buscar': 'Buscar trámites para un comprobante',
  'comprobantes.comprobante.aplicar': 'Aplicar o adjuntar un comprobante',
  'comprobantes.comprobante.descartar': 'Descartar un comprobante',
};

describe('0201 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0201)).toEqual([]);
    expect(SQL_0201).toMatch(/DO \$resumen0201\$/);
    expect(SQL_0201).toMatch(/END \$resumen0201\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0201.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0201_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0200_ (Feature #12621; rojo hasta que entre en develop) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0200_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Épica/HU) y autor', () => {
    const cabecera = SQL_0201.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Epica #12245/);
    expect(cabecera).toMatch(/HU #12629/);
  });

  it('NO crea ni altera columnas de flito_comprobantes ni de ninguna tabla: solo dos INSERT (siembra) y el DO', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/flito_comprobantes/);
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/);
  });

  it('siembra las TRES operaciones (comprobantes, tipo operacion) con los textos byte a byte del catálogo', () => {
    const funciones = funcionesDeSql([SQL_0201]);
    expect([...funciones.keys()].sort()).toEqual([...OPS].sort());
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      expect(op!.llave).toBe(RUTAS[codigo]);
      expect(op!.nombre).toBe(NOMBRES[codigo]);
      expect(funciones.get(codigo)).toEqual({ codigo, modulo: 'comprobantes', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
      const f = catalogo.find((c) => c.codigo === codigo);
      expect(f, codigo).toBeDefined();
      expect(f!.tipo).toBe('operacion');
      expect(f!.modulo).toBe('comprobantes');
    }
  });

  it('reparte a admin y financiera (6 filas), igual en el SQL que en el catálogo; auditor NO', () => {
    const reparto = repartoDeSql([SQL_0201]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    for (const rol of ['admin', 'financiera']) expect([...reparto.get(rol)!].sort()).toEqual([...OPS].sort());
    expect(reparto.get('auditor')).toBeUndefined();
    expect([...reparto.values()].reduce((n, s) => n + s.size, 0)).toBe(6);
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      expect(catalogo.find((c) => c.codigo === codigo)!.roles, codigo).toEqual(['admin', 'financiera']);
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r).sort()).toEqual(['admin', 'financiera']);
    }
  });

  it('los cardinales del catálogo: 8 operaciones de comprobantes (5 de la 0198 + 3), y las 8 llaves del fichero de rutas', () => {
    expect(catalogoCompleto().filter((c) => c.tipo === 'operacion' && c.modulo === 'comprobantes')).toHaveLength(8);
    expect(OPERACIONES_DECLARADAS.filter((o) => o.llave.startsWith('flito-comprobantes/flito-comprobantes.routes.ts '))).toHaveLength(8);
  });

  it('no retira nada y el helper de paridad la lee después de la 0199; plegado, admin y financiera sí y auditor no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBeGreaterThan(MIGRACIONES_CON_REPARTO.indexOf('0199_tramite_viajes_logistica.sql'));
    expect(MIGRACIONES_CON_REPARTO.at(-1)).toBe(ARCHIVO);
    const total = leerRepartoSembrado();
    for (const codigo of OPS) {
      expect(total.get('admin')!.has(codigo)).toBe(true);
      expect(total.get('financiera')!.has(codigo)).toBe(true);
      expect(total.get('auditor')?.has(codigo) ?? false).toBe(false);
    }
  });

  it('el resumen final revienta si no cuadra 3 ops + 6 de reparto, contando por código exacto (no por módulo ni prefijo)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 3 OR n_reparto <> 6 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/n_ops FROM permisos_funciones WHERE modulo = 'comprobantes'/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'comprobantes\.%'/);
    expect(SIN_COMENTARIOS).toMatch(/INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN\s*\('comprobantes\.tramites\.buscar', 'comprobantes\.comprobante\.aplicar', 'comprobantes\.comprobante\.descartar'\)/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0201 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 3 funciones, 6 de reparto', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0201);
      await tx.unsafe(SQL_0201);
      const [funciones] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo IN ${tx([...OPS])}`;
      expect(funciones!.n).toBe(3);
      const reparto = await tx<{ rol_codigo: string; n: number }[]>`
        SELECT rol_codigo, count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx([...OPS])} GROUP BY rol_codigo ORDER BY rol_codigo`;
      expect(reparto).toEqual([{ rol_codigo: 'admin', n: 3 }, { rol_codigo: 'financiera', n: 3 }]);
    });
  }, 60_000);
});
