// HU #12084 — La 0186: SOLO siembra. Las siete funciones `permisos.*` que guardan las rutas de
// `permisos.routes.ts` y su reparto a `admin`. Sin DDL.
//
// Dos mitades, igual que la 0185:
//   · **Estática** (siempre corre, también en CI): cabecera, sin BEGIN/COMMIT, sin DDL de ninguna
//     clase, dollar-quoting etiquetado, `ON CONFLICT DO NOTHING` ×2 y ningún `DO UPDATE`, las siete
//     funciones y los siete pares `admin`, y que los textos sean EXACTAMENTE los de
//     `catalogo-operaciones.ts` (el generador). La paridad con el seed generado entero la comprueba
//     `migracion-0179.test.ts` sumando la 0186 a `MIGRACIONES_CON_REPARTO`.
//   · **Contra PostgreSQL de verdad** (solo si hay base): existen, `admin` las tiene, ningún otro rol las
//     tiene, e idempotencia fuerte (la segunda pasada no cambia una fila). Se activa con:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0186.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { funcionesDeSql, repartoDeSql } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0186_permisos_roles_mantenimiento.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0186 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0186.replace(/--[^\n]*/g, '');
const URL_BASE = process.env.TEST_DATABASE_URL;

const CODIGOS = [
  'permisos.catalogo.ver', 'permisos.cuadro.guardar', 'permisos.cuadro.ver', 'permisos.rol.borrar',
  'permisos.rol.crear', 'permisos.rol.editar', 'permisos.rol.listar',
];

describe('0186 — análisis estático', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el DO lleva dollar-quoting etiquetado, sin nombrar la etiqueta en comentarios', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0186)).toEqual([]);
    expect(SQL_0186).toMatch(/DO \$resumen0186\$/);
    expect(SQL_0186).toMatch(/END \$resumen0186\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const comentarios = SQL_0186.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(comentarios).not.toMatch(/\$resumen0186\$/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0186.split('\n').slice(0, 8).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12084/);
  });

  it('el número es 0186 y no colisiona con ningún otro archivo', () => {
    const con0186 = readdirSync(path.dirname(RUTA)).filter((f) => f.startsWith('0186_'));
    expect(con0186).toEqual([ARCHIVO]);
  });

  it('SOLO siembra: ni CREATE, ni ALTER, ni DROP, ni DELETE, ni UPDATE', () => {
    for (const verbo of ['CREATE', 'ALTER', 'DROP', 'DELETE', 'UPDATE', 'TRUNCATE', 'GRANT', 'REVOKE']) {
      expect(SIN_COMENTARIOS, verbo).not.toMatch(new RegExp(`\\b${verbo}\\b`, 'i'));
    }
    expect(SIN_COMENTARIOS.match(/INSERT INTO/g)).toHaveLength(2);
  });

  it('dos ON CONFLICT DO NOTHING y ningún DO UPDATE (idempotencia fuerte declarada)', () => {
    expect(/ON\s+CONFLICT[\s\S]{0,80}DO\s+UPDATE/i.test(SIN_COMENTARIOS)).toBe(false);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
  });

  it('siembra exactamente las siete funciones del módulo `permisos`, tipo operacion, con los textos del catálogo de negocio', () => {
    const funciones = funcionesDeSql([SQL_0186]);
    expect([...funciones.keys()].sort()).toEqual(CODIGOS);
    const declaradas = new Map(OPERACIONES_DECLARADAS.map((o) => [o.codigo, o]));
    for (const [codigo, f] of funciones) {
      const d = declaradas.get(codigo)!;
      expect(d, codigo).toBeDefined();
      expect(f).toEqual({ codigo, modulo: 'permisos', nombre: d.nombre, descripcion: d.descripcion, tipo: 'operacion' });
      expect(f.descripcion.length).toBeGreaterThan(0);
    }
  });

  it('el reparto son los siete pares (admin, permisos.*) y ninguno para otro rol (el cuadro de roles es administración, no observación)', () => {
    const reparto = repartoDeSql([SQL_0186]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!].sort()).toEqual(CODIGOS);
  });

  it('formato del generador: cada tupla de siembra en su propia línea', () => {
    const tuplas = SQL_0186.split('\n').filter((l) => /^\s+\('/.test(l));
    expect(tuplas).toHaveLength(14);
  });
});

describe.skipIf(!URL_BASE)('0186 — contra la base real (siembra e idempotencia)', () => {
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

  it('(a) las siete funciones existen y admin las tiene todas; ningún otro rol tiene ninguna', async () => {
    const funciones = await sql`SELECT codigo, modulo, tipo FROM permisos_funciones WHERE codigo = ANY(${CODIGOS}) ORDER BY codigo`;
    expect(funciones.map((f) => f.codigo)).toEqual(CODIGOS);
    expect(funciones.every((f) => f.modulo === 'permisos' && f.tipo === 'operacion')).toBe(true);
    const reparto = await sql`SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ANY(${CODIGOS}) ORDER BY rol_codigo, funcion_codigo`;
    expect(reparto.map((r) => `${r.rol_codigo} ${r.funcion_codigo}`)).toEqual(CODIGOS.map((c) => `admin ${c}`));
  });

  it('(b) idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila', async () => {
    const { antes, despues } = await enTx(async (tx) => {
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(codigo||modulo||nombre_negocio||descripcion||tipo, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
          (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS r,
          (SELECT count(*)::int FROM permisos_funciones) AS nf,
          (SELECT count(*)::int FROM permisos_rol_funcion) AS nr
      `)[0];
      const a = await huella();
      await tx.unsafe(SQL_0186);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
