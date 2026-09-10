// HU #12085 — La 0187: la página `roles_permisos` (panel «Roles y permisos», `/roles-permisos`) entra al
// motor de permisos como `pagina.roles_permisos`, repartida SOLO a `admin`.
//
// Dos mitades, igual que la 0184 y la 0186:
//   · **Estática** (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
//     etiquetado, numeración), la fila de `permisos_funciones` es EXACTAMENTE la que el catálogo del
//     código produce para ese slug (módulo del grupo «Administración», label de `PAGES`), y el reparto
//     es el que `rolesQueConcedenLaPagina` deriva: `['admin']`, porque el slug NO está en ninguna fila
//     de `DEFAULTS_POR_ROL` (patrón `siigo_credenciales`). Mutantes nombrados:
//       · M1 — añadir `('auditor', 'pagina.roles_permisos')` al INSERT: cae «el reparto es solo admin».
//       · M2 — añadir `roles_permisos` a una fila de DEFAULTS_POR_ROL: cae el mismo aserto por el lado
//         del catálogo (roles !== ['admin']), «no está en los defaults de ningún rol» y la paridad de
//         migracion-0179.test.ts.
//   · **Contra PostgreSQL de verdad** (solo si hay base): la función existe con el módulo del catálogo,
//     `admin` la tiene y ningún otro rol, e idempotencia fuerte (la segunda pasada no cambia una fila).
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0187.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, leerFuncionesSembradas, leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0187_pagina_roles_permisos.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0187 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0187.replace(/--[^\n]*/g, '');
const URL_BASE = process.env.TEST_DATABASE_URL;

const SLUG = 'roles_permisos';
const CODIGO = `pagina.${SLUG}`;

describe('0187 — reglas del archivo y lo que siembra (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el DO lleva dollar-quoting etiquetado, sin nombrar la etiqueta en comentarios', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0187)).toEqual([]);
    expect(SQL_0187).toMatch(/DO \$resumen0187\$/);
    expect(SQL_0187).toMatch(/END \$resumen0187\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const comentarios = SQL_0187.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(comentarios).not.toMatch(/\$resumen0187\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0187.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12085/);
  });

  it('el número 0187 no colisiona y la anterior es la 0186 (la de la HU #12084)', () => {
    // «La anterior es 0186» y NO «es la última»: exigir el tip congela la numeración y pone rojo el
    // CI del PR siguiente que añada una migración.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0187_'))).toEqual([ARCHIVO]);
    const pos = sqls.indexOf(ARCHIVO);
    expect(sqls[pos - 1]).toBe('0186_permisos_roles_mantenimiento.sql');
  });

  it('SOLO siembra: ni CREATE, ni ALTER, ni DROP, ni DELETE, ni UPDATE', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP|DELETE|UPDATE|TRUNCATE)\b/i);
  });

  it('el slug está en PAGES, en el grupo «Administración» de PAGE_GROUPS (una sola vez) y en los defaults de NINGÚN rol (mutante M2)', () => {
    expect(PAGES[SLUG]).toBe('Roles y permisos');
    const grupos = PAGE_GROUPS.filter((g) => g.pages.includes(SLUG)).map((g) => g.label);
    expect(grupos).toEqual(['Administración']);
    // Patrón `siigo_credenciales`: `admin` la obtiene por el catálogo; nadie más la recibe por defecto.
    for (const rol of USER_ROLES.filter((r) => r !== 'admin')) {
      expect(paginasPorDefecto(rol), `defaults de ${rol}`).not.toContain(SLUG);
    }
  });

  it('siembra exactamente la función de la página con los textos del catálogo del código (módulo `administracion`, tipo `pagina`)', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO);
    expect(f, `${CODIGO} en el catálogo del código`).toBeDefined();
    expect(f!.tipo).toBe('pagina');
    expect(f!.modulo).toBe('administracion');
    expect(sembradas.get(CODIGO)).toEqual({ codigo: CODIGO, modulo: f!.modulo, nombre: f!.nombreNegocio, descripcion: f!.descripcion, tipo: 'pagina' });
  });

  it('el reparto es SOLO admin, igual en el SQL que en el catálogo del código (mutantes M1 y M2)', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin']);
  });

  it('no retira nada, y el helper de paridad la lee (está en MIGRACIONES_CON_REPARTO)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    // Plegadas todas las migraciones con reparto, la página sigue concedida solo a admin.
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(CODIGO)).toBe(true);
    for (const [rol, codigos] of total) {
      if (rol !== 'admin') expect(codigos.has(CODIGO), `${rol} no debe tener ${CODIGO}`).toBe(false);
    }
  });

  it('el resumen final revienta si la función o el reparto quedaron inconsistentes (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_funcion <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
  });
});

describe.skipIf(!URL_BASE)('0187 — contra la base real (siembra e idempotencia)', () => {
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

  it('(a) la función existe con el módulo del catálogo, admin la tiene y ningún otro rol', async () => {
    const funciones = await sql`SELECT codigo, modulo, tipo FROM permisos_funciones WHERE codigo = ${CODIGO}`;
    expect(funciones).toHaveLength(1);
    expect(funciones[0]).toMatchObject({ codigo: CODIGO, modulo: 'administracion', tipo: 'pagina' });
    const reparto = await sql`SELECT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo = ${CODIGO} ORDER BY rol_codigo`;
    expect(reparto.map((r) => r.rol_codigo)).toEqual(['admin']);
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
      await tx.unsafe(SQL_0187);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
