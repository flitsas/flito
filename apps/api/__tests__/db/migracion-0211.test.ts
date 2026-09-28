// HU #12997 (Feature #12841, diseño §11.1 opción A) — Migración 0211: las dos funciones de lectura de
// las solicitudes SOAT incompletas (`soat.incompletas.buscar`, `soat.incompleta.ver`), repartidas a
// todo rol que ya tenga `soat.cola.ver` / `soat.solicitud.ver`. Calco de migracion-0208.test.ts.
//
// Se afirma «la anterior es 0210_» y NUNCA «la 0211 es la última» (memoria:
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
const ARCHIVO = '0211_permisos_soat_incompletas.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0211 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0211.replace(/--[^\n]*/g, '');

const FICHERO = 'flito-soat/flito-soat-incompletas.routes.ts';
/** código nuevo → [llave de su ruta, código de la cola/detalle del que hereda el reparto] */
const NUEVAS = {
  'soat.incompletas.buscar': [`${FICHERO} POST /cliente/incompletas/buscar`, 'soat.cola.ver'],
  'soat.incompleta.ver': [`${FICHERO} GET /cliente/incompletas/:id`, 'soat.solicitud.ver'],
} as const;
const CODIGOS = Object.keys(NUEVAS) as (keyof typeof NUEVAS)[];
const ROLES_PARTIDA = ['admin', 'auditor', 'cliente', 'proveedor'];

describe('0211 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0211)).toEqual([]);
    expect(SQL_0211).toMatch(/DO \$resumen0211\$/);
    expect(SQL_0211).toMatch(/END \$resumen0211\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0211_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0210_ (HU #12996) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0210_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0211.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #12997/);
    expect(cabecera).toMatch(/Feature #12841/);
  });

  it('siembra las dos operaciones con los textos byte a byte del catálogo, en su router', () => {
    const funciones = funcionesDeSql([SQL_0211]);
    expect([...funciones.keys()].sort()).toEqual([...CODIGOS].sort());
    for (const codigo of CODIGOS) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      expect(op!.llave).toBe(NUEVAS[codigo][0]);
      const f = catalogoCompleto().find((c) => c.codigo === codigo)!;
      expect(funciones.get(codigo)).toEqual({
        codigo, modulo: f.modulo, nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
      });
      expect(f.tipo).toBe('operacion');
    }
  });

  it('la foto (GUARDAS_MEDIDAS) las lleva como guarda de ruta con los MISMOS roles que la cola / el detalle', () => {
    for (const codigo of CODIGOS) {
      const [llave, origen] = NUEVAS[codigo];
      const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === llave);
      expect(g, llave).toBeDefined();
      expect(g!.heredada).toBe(false);
      const deOrigen = catalogoCompleto().find((c) => c.codigo === origen)!.roles;
      expect([...g!.roles].sort()).toEqual([...deOrigen].sort());
      expect([...g!.roles].sort()).toEqual(ROLES_PARTIDA);
    }
  });

  it('reparto de partida: las 8 filas del SQL son las del catálogo (4 roles × 2 funciones)', () => {
    const reparto = repartoDeSql([SQL_0211]);
    expect([...reparto.keys()].sort()).toEqual(ROLES_PARTIDA);
    for (const rol of ROLES_PARTIDA) expect([...reparto.get(rol)!].sort(), rol).toEqual([...CODIGOS].sort());
    for (const codigo of CODIGOS) {
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r).sort()).toEqual(ROLES_PARTIDA);
    }
  });

  it('y a todo rol del panel que hoy tenga la función de origen (INSERT … SELECT por código exacto)', () => {
    for (const codigo of CODIGOS) {
      const origen = NUEVAS[codigo][1];
      const re = new RegExp(
        `INSERT INTO permisos_rol_funcion \\(rol_codigo, funcion_codigo\\)\\s*SELECT rf\\.rol_codigo, '${codigo.replace(/\./g, '\\.')}' `
        + `FROM permisos_rol_funcion rf WHERE rf\\.funcion_codigo = '${origen.replace(/\./g, '\\.')}'\\s*ON CONFLICT`,
      );
      expect(SIN_COMENTARIOS, codigo).toMatch(re);
    }
  });

  it('no retira nada y el helper de paridad la lee al final; plegado, los roles de partida sí y gestor_impuestos no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBe(MIGRACIONES_CON_REPARTO.indexOf('0208_flito_impuestos_direccion_factura.sql') + 1);
    const total = leerRepartoSembrado();
    for (const rol of ROLES_PARTIDA) for (const c of CODIGOS) expect(total.get(rol)!.has(c), `${rol} ${c}`).toBe(true);
    for (const c of CODIGOS) expect(total.get('gestor_impuestos')?.has(c) ?? false).toBe(false);
  });

  it('idempotente y con resumen que revienta si alguien que ve la cola se queda sin incompletas', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/g)).toHaveLength(3);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 2 OR n_sin_buscar <> 0 OR n_sin_ver <> 0[\s\S]*?RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'soat\.%'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0211 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica; todo rol con la cola / el detalle queda con su incompleta', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0211);
      await tx.unsafe(SQL_0211);
      const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo IN ${tx(CODIGOS)}`;
      expect(f!.n).toBe(2);
      for (const codigo of CODIGOS) {
        const origen = NUEVAS[codigo][1];
        const [h] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM permisos_rol_funcion rf WHERE rf.funcion_codigo = ${origen}
            AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x WHERE x.rol_codigo = rf.rol_codigo AND x.funcion_codigo = ${codigo})`;
        expect(h!.n, codigo).toBe(0);
      }
    });
  }, 60_000);
});
