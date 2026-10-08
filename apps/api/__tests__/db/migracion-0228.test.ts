// HU #13425 (Feature #13414, Épica #13411) — Migración 0228: la función `logistica.actas.operar_ajenas`
// (en línea en `flito-logistica.routes.ts`, `ctxConPropiedad`) que sustituye a `role === 'mensajero'`.
// Siembra de EQUIVALENCIA (AC7): `admin` explícito (0226) + todo rol que hoy pasa la regla (los que
// tienen mi ruta/entregar/devolver, menos `mensajero`) + excepciones por usuario equivalentes.
// Calco de migracion-0220.test.ts.
//
// Se afirma «la anterior es 0227_» y NUNCA «la 0228 es la última» (memoria:
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
const ARCHIVO = '0228_permiso_logistica_operar_ajenas.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0228 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0228.replace(/--[^\n]*/g, '');

const CODIGO = 'logistica.actas.operar_ajenas';
const LLAVE = 'flito-logistica/flito-logistica.routes.ts POST /actas/:id/entregar [operarAjenas]';

describe('0228 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0228)).toEqual([]);
    expect(SQL_0228).toMatch(/DO \$resumen0228\$/);
    expect(SQL_0228).toMatch(/END \$resumen0228\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0228_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0227_ (HU #13421) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0227_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0228.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13425/);
    expect(cabecera).toMatch(/Feature #13414/);
  });

  it('siembra UNA operación del módulo logística con los textos byte a byte del catálogo, en línea en entregar', () => {
    const funciones = funcionesDeSql([SQL_0228]);
    expect([...funciones.keys()]).toEqual([CODIGO]);
    const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === CODIGO);
    expect(op).toBeDefined();
    expect(op!.llave).toBe(LLAVE);
    expect(funciones.get(CODIGO)).toEqual({
      codigo: CODIGO, modulo: 'logistica', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
    });
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.modulo).toBe('logistica');
    expect(f.tipo).toBe('operacion');
  });

  it('la foto la lleva como guarda EN LÍNEA con los roles que hoy pasan la regla (admin; no mensajero)', () => {
    const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVE);
    expect(g).toBeDefined();
    expect(g!.condicion).toBe('operarAjenas');
    expect(g!.roles).toEqual(['admin']);
    // Los roles de partida de entregar eran admin y mensajero: la función es esos menos mensajero.
    const entregar = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === 'flito-logistica/flito-logistica.routes.ts POST /actas/:id/entregar')!;
    expect(entregar.roles.filter((r) => r !== 'mensajero')).toEqual(g!.roles);
    expect(repartoDePartida().filter(([, c]) => c === CODIGO).map(([r]) => r)).toEqual(['admin']);
  });

  it('reparto literal: admin y SOLO admin (0226); en la suma de las migraciones de permisos, ni mensajero', () => {
    expect([...repartoDeSql([SQL_0228]).entries()].map(([rol, cs]) => [rol, [...cs]])).toEqual([['admin', [CODIGO]]]);
    const conElla = [...leerRepartoSembrado().entries()].filter(([, fs]) => fs.has(CODIGO)).map(([rol]) => rol);
    expect(conElla).toEqual(['admin']);
  });

  it('equivalencia dinámica: los roles con mi ruta/entregar/devolver menos `mensajero`, y las excepciones por usuario', () => {
    expect(SIN_COMENTARIOS).toMatch(/FROM permisos_rol_funcion rf\s+WHERE rf\.funcion_codigo IN \('logistica\.ruta\.ver', 'logistica\.actas\.entregar', 'logistica\.actas\.devolver'\)\s+AND rf\.rol_codigo <> 'mensajero'/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_usuario_funcion \(user_id, funcion_codigo, efecto\)/);
    expect(SIN_COMENTARIOS).toMatch(/AND u\.role <> 'mensajero'/);
    expect(SIN_COMENTARIOS).toMatch(/uf\.efecto = 'conceder'/);
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0227 (HU #13421)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBe(MIGRACIONES_CON_REPARTO.indexOf('0227_permisos_pesv_por_item.sql') + 1);
  });

  it('idempotente y con resumen que revienta si la siembra no quedó o alcanzó a mensajero', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT/g)).toHaveLength(4);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bCREATE\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 1 OR n_admin <> 1 OR n_mensajero <> 0 THEN\s*RAISE EXCEPTION/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0228 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe ni duplica; admin la tiene y mensajero no', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0228);
        const [antes] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        await tx.unsafe(SQL_0228);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO} AND modulo = 'logistica'`;
        expect(f!.n).toBe(1);
        const [despues] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        expect(despues!.n).toBe(antes!.n);
        const roles = await tx<{ rol_codigo: string }[]>`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        expect(roles.map((r) => r.rol_codigo)).toContain('admin');
        expect(roles.map((r) => r.rol_codigo)).not.toContain('mensajero');
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
