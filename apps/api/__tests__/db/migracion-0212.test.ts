// HU #12998 (Feature #12841, diseño §11 Q2 y §11.1) — Migración 0212: la función
// `soat.solicitud.reintentar_runt`, que guarda SOLO `POST …/incompletas/:id/reintentar`, sembrada
// SOLO a admin (P-8). Calco de migracion-0211.test.ts y de la 0203.
//
// Se afirma «la anterior es 0211_» y NUNCA «la 0212 es la última» (memoria:
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
import { RUTAS_PERMITIDAS_CLIENTE } from '../../src/shared/middleware/canal-cliente.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0212_permiso_soat_reintentar_runt.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0212 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0212.replace(/--[^\n]*/g, '');

const CODIGO = 'soat.solicitud.reintentar_runt';
const LLAVE = 'flito-soat/flito-soat-incompletas.routes.ts POST /cliente/incompletas/:id/reintentar';

describe('0212 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0212)).toEqual([]);
    expect(SQL_0212).toMatch(/DO \$resumen0212\$/);
    expect(SQL_0212).toMatch(/END \$resumen0212\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0212_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0211_ (HU #12997) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0211_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0212.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #12998/);
    expect(cabecera).toMatch(/Feature #12841/);
  });

  it('siembra UNA operación con los textos byte a byte del catálogo, en la ruta del reintento', () => {
    const funciones = funcionesDeSql([SQL_0212]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(LLAVE);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(funciones.get(CODIGO)).toEqual({
      codigo: CODIGO, modulo: 'soat', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
    });
    expect(f.modulo).toBe('soat');
    expect(f.tipo).toBe('operacion');
  });

  it('la foto la lleva como guarda de ruta con roles de partida = solo admin', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE);
    expect(g).toBeDefined();
    expect(g!.heredada).toBe(false);
    expect(g!.metodo).toBe('POST');
    expect([...g!.roles]).toEqual(['admin']);
    expect(repartoDePartida().filter(([, c]) => c === CODIGO).map(([r]) => r)).toEqual(['admin']);
  });

  it('reparto: SOLO admin (P-8); el auditor NO la recibe (es una acción) y nadie más', () => {
    const r = repartoDeSql([SQL_0212]);
    expect([...r.keys()]).toEqual(['admin']);
    expect([...r.get('admin')!]).toEqual([CODIGO]);
    const total = leerRepartoSembrado();
    const conElla = [...total.entries()].filter(([, fs]) => fs.has(CODIGO)).map(([rol]) => rol);
    expect(conElla).toEqual(['admin']);
    expect(total.get('auditor')?.has(CODIGO) ?? false).toBe(false);
  });

  it('el Cliente PUEDE recibirla desde el panel: su ruta está en RUTAS_PERMITIDAS_CLIENTE con esta función', () => {
    const e = RUTAS_PERMITIDAS_CLIENTE.find((x) => x.funcion === CODIGO);
    expect(e).toBeDefined();
    expect(e!.metodo).toBe('POST');
    expect(e!.patron).toBe('/api/flito/soat/cliente/incompletas/:id/reintentar');
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0211', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBe(MIGRACIONES_CON_REPARTO.indexOf('0211_permisos_soat_incompletas.sql') + 1);
  });

  it('idempotente y con resumen que revienta si no cuadra', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bCREATE\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'soat\.%'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0212 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe ni duplica; solo admin la tiene', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0212);
        await tx.unsafe(SQL_0212);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO}`;
        expect(f!.n).toBe(1);
        const roles = await tx<{ rol_codigo: string }[]>`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        expect(roles.map((r) => r.rol_codigo)).toContain('admin');
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
