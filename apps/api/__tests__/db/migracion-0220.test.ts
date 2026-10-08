// HU #13269 (Feature #13267, Épica #12741) — Migración 0220: la función `impuestos.recibos.reemplazar`,
// que guarda SOLO `POST …/impuestos/:id/recibos/reemplazar-pago`, sembrada en el módulo de impuestos
// SIN reparto (AC7): nace sin rol, ni siquiera admin. Calco de migracion-0212.test.ts.
//
// Se afirma «la anterior es 0219_» y NUNCA «la 0220 es la última» (memoria:
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
const ARCHIVO = '0220_permiso_impuestos_recibos_reemplazar.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0220 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0220.replace(/--[^\n]*/g, '');

const CODIGO = 'impuestos.recibos.reemplazar';
const LLAVE = 'flito-impuestos/flito-impuestos.recibo-reemplazo.routes.ts POST /:id/recibos/reemplazar-pago';

describe('0220 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0220)).toEqual([]);
    expect(SQL_0220).toMatch(/DO \$resumen0220\$/);
    expect(SQL_0220).toMatch(/END \$resumen0220\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0220_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0219_ (HU #13268) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0219_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0220.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13269/);
    expect(cabecera).toMatch(/Feature #13267/);
  });

  it('siembra UNA operación del módulo impuestos con los textos byte a byte del catálogo, en la ruta del reemplazo', () => {
    const funciones = funcionesDeSql([SQL_0220]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(LLAVE);
    expect(funciones.get(CODIGO)).toEqual({
      codigo: CODIGO, modulo: 'impuestos', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
    });
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.modulo).toBe('impuestos');
    expect(f.tipo).toBe('operacion');
  });

  it('la foto la lleva como guarda de ruta propia SIN roles de partida', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE);
    expect(g).toBeDefined();
    expect(g!.heredada).toBe(false);
    expect(g!.metodo).toBe('POST');
    expect(g!.roles).toEqual([]);
    expect(repartoDePartida().filter(([, c]) => c === CODIGO)).toEqual([]);
  });

  it('reparto: NINGUNO (AC7) — ni en este archivo ni en la suma de las migraciones de permisos', () => {
    expect(repartoDeSql([SQL_0220]).size).toBe(0);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_rol_funcion/);
    const conElla = [...leerRepartoSembrado().entries()].filter(([, fs]) => fs.has(CODIGO)).map(([rol]) => rol);
    expect(conElla).toEqual([]);
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0218', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBe(MIGRACIONES_CON_REPARTO.indexOf('0218_pagina_perfil.sql') + 1);
  });

  it('idempotente y con resumen que revienta si la función no quedó', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bCREATE\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0220 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe ni duplica; ningún rol la recibe', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0220);
        await tx.unsafe(SQL_0220);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO} AND modulo = 'impuestos'`;
        expect(f!.n).toBe(1);
        const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        expect(r!.n).toBe(0);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
