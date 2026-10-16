// HU #13631 (Feature #13612, Épica #13576) — Migración 0243: retiro de `sync.sync.lanzar` (sincronización
// manual de FLIT 1) del catálogo y de la matriz. Calco de migracion-0242.test.ts.
//
// Se afirma «la anterior es 0242_» y NUNCA «la 0243 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima). AC3: borra por código y no nombra ningún rol (la 0227 tumbó
// DEV por un literal de rol con FK a permisos_roles).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { USER_ROLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_ANTES_DEL_ARBOL, MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRetirosSembrados, literalesDeRol, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { catalogoCompleto, catalogoPlano } from '../../src/modules/permisos/catalogo.js';
import { ACCIONES_GESTION } from '../../src/modules/permisos/arbol/acciones-gestion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0243_permisos_retirar_sync_lanzar.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0243 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0243.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const CODIGO = 'sync.sync.lanzar';

describe('0243 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0243)).toEqual([]);
    expect(SQL_0243).toMatch(/DO \$resumen0243\$/);
    expect(SQL_0243).toMatch(/END \$resumen0243\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQLS.filter((f) => f.startsWith('0243_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0242_; nunca «es la última»', () => {
    expect(SQLS[SQLS.indexOf(ARCHIVO) - 1]).toMatch(/^0242_/);
  });

  it('cabecera: archivo, HU/Feature y autor', () => {
    const cabecera = SQL_0243.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13631/);
    expect(cabecera).toMatch(/Feature #13612/);
  });

  it('AC3: borra SOLO por código de función, en la forma canónica de la 0240, marcas antes que la función (FK RESTRICT)', () => {
    const rol = SIN_COMENTARIOS.indexOf(`DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN ('${CODIGO}');`);
    const usr = SIN_COMENTARIOS.indexOf(`DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN ('${CODIGO}');`);
    const fun = SIN_COMENTARIOS.indexOf(`DELETE FROM permisos_funciones WHERE codigo IN ('${CODIGO}');`);
    expect(rol).toBeGreaterThan(-1);
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
    // Ningún otro DELETE ni otro código entre comillas: no toca ver_estado ni la configuración.
    expect(SIN_COMENTARIOS.match(/\bDELETE\b/g)).toHaveLength(3);
    const literales = new Set([...SIN_COMENTARIOS.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((x) => !x!.startsWith('0243:')));
    expect([...literales]).toEqual([CODIGO]);
    expect(SIN_COMENTARIOS).not.toMatch(/sync\.sync\.ver_estado|tramites\.sincronizacion\.configurar/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDROP\b|\bALTER\b|\bTRUNCATE\b/);
  });

  it('el pliegue de las migraciones la ve: retira la función y su reparto, y está en la lista con reparto', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_ANTES_DEL_ARBOL).toContain(ARCHIVO); // retiro del mundo plano: su ruta ya no existe
    expect(leerRetirosSembrados([ARCHIVO]).funciones).toEqual(new Set([CODIGO]));
    const reparto = repartoDeSql([`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES ('r', '${CODIGO}'), ('r', 'sync.sync.ver_estado');`, SQL_0243]);
    expect([...reparto.get('r')!]).toEqual(['sync.sync.ver_estado']);
  });

  it('AC3: sin literales de rol ni reparto (la 0227)', () => {
    expect(literalesDeRol(SQL_0243)).toEqual([]);
    for (const r of USER_ROLES) expect(SIN_COMENTARIOS, r).not.toContain(`'${r}'`);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo|permisos_roles/);
    expect(funcionesDeSql([SQL_0243]).size).toBe(0);
    expect(repartoDeSql([SQL_0243]).size).toBe(0);
  });

  it('AC2: el catálogo del código ya no declara la función; ver_estado y configurar siguen', () => {
    // Plano (operaciones sueltas) y completo (árbol): en ninguno está; las otras dos siguen en el plano y
    // siguen expandiéndose desde sus acciones del árbol.
    expect(catalogoCompleto().some((f) => f.codigo === CODIGO)).toBe(false);
    const plano = new Set(catalogoPlano().map((f) => f.codigo));
    expect(plano.has(CODIGO)).toBe(false);
    expect(plano.has('sync.sync.ver_estado')).toBe(true);
    expect(plano.has('tramites.sincronizacion.configurar')).toBe(true);
    const ops = Object.values(ACCIONES_GESTION).flatMap((a) => a.operaciones);
    expect(ops).not.toContain(CODIGO);
    expect(ACCIONES_GESTION['accion.tramites.sincronizar']!.operaciones).toEqual(['sync.sync.ver_estado']);
    expect(ACCIONES_GESTION['accion.tramites.configurar_sincronizacion']!.operaciones).toContain('tramites.sincronizacion.configurar');
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0243 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('retira la función y sus marcas; la segunda pasada no falla ni cambia nada', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo)
                 VALUES (${CODIGO}, 'sync', 'Lanzar la sincronización', 'x', 'operacion') ON CONFLICT (codigo) DO NOTHING`;
        await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
                 SELECT r.codigo, ${CODIGO} FROM permisos_roles r ORDER BY r.codigo LIMIT 1 ON CONFLICT DO NOTHING`;
        const otras = async () => (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo <> ${CODIGO}`)[0]!.n;
        const antes = await otras();
        await tx.unsafe(SQL_0243);
        await tx.unsafe(SQL_0243);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo = ${CODIGO}`;
        const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO}`;
        const [u] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_usuario_funcion WHERE funcion_codigo = ${CODIGO}`;
        expect([f!.n, r!.n, u!.n]).toEqual([0, 0, 0]);
        expect(await otras()).toBe(antes);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
