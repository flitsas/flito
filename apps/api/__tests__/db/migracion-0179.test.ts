// HU #12081 — La 0179: el catálogo de funciones, el reparto rol × función y el permiso por usuario.
//
// Dos mitades, igual que su hermana la 0178:
//
//   · **Estática** (siempre corre, también en CI): lo que el `.sql` dice y lo que `schema.ts` dice
//     tienen que ser la misma afirmación en dos idiomas, y el seed pegado en el archivo tiene que ser
//     el que el generador produce hoy. Esto último es lo que impide que el código y el seed se
//     separen sin que nadie lo note.
//   · **Contra PostgreSQL de verdad** (solo si hay base): la idempotencia fuerte, las claves foráneas
//     con sus ON DELETE, el backfill y la paridad del AC7 NO son afirmaciones sobre un archivo, son
//     afirmaciones sobre el motor. El mock de este repo no sirve para probarlas —devuelve la fila
//     entera aunque el `select` pidiera menos e ignora `orderBy`—, así que un test escrito sobre el
//     mock pasaría en verde sin la migración.
//
//     Se activa con la URL de una base con la cadena al día:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0179.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres y un rojo ahí sería un
//     rojo del entorno. Lo que no se hace es fingir que pasó.
//
// Las dos mutaciones nombradas del AC8 y dónde caen:
//   1. Borrar una fila del seed de un rol de sistema (p. ej. `('auditor','pagina.flito_tablero')`)
//      → rojo en «AC7 — la paridad rol × página», señalando el rol y la función concretos.
//   2. Quitarle a `admin` una función del catálogo → rojo en «AC6 — admin no se queda fuera en
//      silencio», que nombra el código que le falta.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { execFileSync } from 'node:child_process';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  permisosFunciones, permisosRolFuncion, permisosUsuarioFuncion,
} from '../../src/db/schema.js';
import { USER_ROLES, paginasPorDefecto, isValidPage } from '@operaciones/shared-types';
import { catalogoCompleto, repartoDePartida, PAGINAS_NO_CONCEDIBLES } from '../../src/modules/permisos/catalogo.js';
import { FUNCIONES_SIN_ADMIN } from '../../src/modules/permisos/permisos.service.js';
import {
  funcionesDeSql, leerFuncionesSembradas, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0179_permisos_modelo.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0179 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0179.replace(/--[^\n]*/g, '');

const CATALOGO = catalogoCompleto();
const REPARTO = repartoDePartida(CATALOGO);

describe('0179 — el archivo dice lo mismo que schema.ts (análisis estático)', () => {
  it('no trae control de transacción propio: el runner lo rechazaría con exit 2 (ADR-DB-001)', () => {
    // El MISMO escáner del runner y no un regex de aquí. A la 0178 le costó un exit 2 nombrar una
    // etiqueta de dollar-quoting dentro de un comentario, porque el escáner corre ANTES de quitarlos.
    expect(scanForTxControl(ARCHIVO, SQL_0179)).toEqual([]);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0179.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12081/);
  });

  it('crea las tres tablas del AC1 con sus tipos', () => {
    expect(SQL_0179).toMatch(/CREATE TABLE IF NOT EXISTS permisos_funciones/);
    expect(SQL_0179).toMatch(/CREATE TABLE IF NOT EXISTS permisos_rol_funcion/);
    expect(SQL_0179).toMatch(/CREATE TABLE IF NOT EXISTS permisos_usuario_funcion/);
    expect(SQL_0179).toMatch(/codigo\s+varchar\(80\)\s+PRIMARY KEY/);
    expect(SQL_0179).toMatch(/permisos_funciones_tipo_chk CHECK \(tipo IN \('pagina','operacion'\)\)/);
    expect(SQL_0179).toMatch(/permisos_usuario_funcion_efecto_chk CHECK \(efecto IN \('conceder','revocar'\)\)/);
  });

  it('las cláusulas ON DELETE del SQL son las que declara schema.ts, una a una (AC1)', () => {
    // La paridad que de verdad importa: un CASCADE que en `schema.ts` fuera RESTRICT no lo caza
    // ningún test de forma, y la diferencia es si borrar una función se lleva por delante el reparto
    // de todo el mundo o lo impide.
    const puente = getTableConfig(permisosRolFuncion);
    const [aRol] = puente.foreignKeys.filter((f) => f.reference().foreignTable !== permisosFunciones);
    const [aFuncion] = puente.foreignKeys.filter((f) => f.reference().foreignTable === permisosFunciones);
    expect(aRol.onDelete).toBe('cascade');
    expect(aFuncion.onDelete).toBe('restrict');

    const usuario = getTableConfig(permisosUsuarioFuncion);
    const aUser = usuario.foreignKeys.find((f) => f.reference().foreignTable !== permisosFunciones)!;
    const aFn = usuario.foreignKeys.find((f) => f.reference().foreignTable === permisosFunciones)!;
    expect(aUser.onDelete).toBe('cascade');
    expect(aFn.onDelete).toBe('restrict');

    // Y lo mismo escrito en el SQL.
    expect(SQL_0179).toMatch(/REFERENCES permisos_roles\(codigo\)\s*\n?\s*ON UPDATE RESTRICT ON DELETE CASCADE/);
    expect(SQL_0179).toMatch(/REFERENCES users\(id\) ON DELETE CASCADE/);
    expect((SIN_COMENTARIOS.match(/REFERENCES permisos_funciones\(codigo\)\s*\n?\s*ON UPDATE RESTRICT ON DELETE RESTRICT/g) ?? [])).toHaveLength(2);
  });

  it('no hay un solo `DO UPDATE`: sería un cambio de fila en la segunda pasada (AC1)', () => {
    expect(/ON\s+CONFLICT[\s\S]{0,80}DO\s+UPDATE/i.test(SIN_COMENTARIOS)).toBe(false);
    expect((SIN_COMENTARIOS.match(/ON CONFLICT[\s\S]{0,60}DO NOTHING/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('el seed pegado en la migración, más la 0181, los retiros de la 0182, la página de la 0184 y la 0185, es lo que el generador produce HOY', () => {
    // Esta es la comprobación que impide que el código y el seed se separen: si alguien amplía la foto
    // (`inventario.generado.ts`) o el catálogo y no escribe la migración, aquí se ve. Y si el generador
    // se rompe, también. Desde la HU #12083 la foto está congelada y el seed vive en VARIOS archivos
    // (0179 + 0181 + 0182 + 0184 + 0185, HU #12171); desde la HU #12373 ya no es solo aditivo (la 0182 retira `borrar` y quita
    // al auditor de tarifas), así que se comparan FUNCIONES y REPARTO por separado, PLEGADOS con los
    // helpers (INSERT suma, DELETE resta), y no como líneas crudas: una tupla de un DELETE leída como
    // siembra daría verde falso.
    const salida = execFileSync('npx', ['tsx', 'src/scripts/generar-seed-permisos.ts'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    const funcionesGeneradas = funcionesDeSql([salida]);
    const repartoGenerado = repartoDeSql([salida]);
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();

    const funcionesSembradas = leerFuncionesSembradas();
    expect([...funcionesSembradas.keys()].sort()).toEqual([...funcionesGeneradas.keys()].sort());
    for (const [codigo, f] of funcionesSembradas) expect(f, codigo).toEqual(funcionesGeneradas.get(codigo));
    expect(aPares(leerRepartoSembrado())).toEqual(aPares(repartoGenerado));

    // Y cada fila de la 0179 SOLA sigue en lo generado, o la retiró una migración posterior con nombre:
    // nadie reescribió la 0179 (una migración aplicada no se edita).
    const retiros = leerRetirosSembrados();
    for (const [codigo, f] of leerFuncionesSembradas([ARCHIVO])) {
      if (retiros.funciones.has(codigo)) continue;
      expect(funcionesGeneradas.get(codigo), codigo).toEqual(f);
    }
    for (const par of aPares(leerRepartoSembrado([ARCHIVO]))) {
      if (retiros.reparto.has(par)) continue;
      expect(aPares(repartoGenerado), par).toContain(par);
    }
    expect(retiros.funciones).toEqual(new Set(['parametrizacion.tarifas.borrar']));
  }, 60_000);
});

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

describe.skipIf(!URL_BASE)('0179 — contra la base real (seed, backfill e idempotencia)', () => {
  let sql: postgres.Sql;

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  /** Ejecuta dentro de una transacción que SIEMPRE termina en ROLLBACK: la base queda intacta. */
  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('las tres tablas existen con las columnas y los tipos del AC1', async () => {
    const cols = await sql`
      SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name IN ('permisos_funciones','permisos_rol_funcion','permisos_usuario_funcion')
       ORDER BY table_name, column_name`;
    const buscar = (t: string, c: string) => cols.find((x) => x.table_name === t && x.column_name === c);

    expect(buscar('permisos_funciones', 'codigo')?.character_maximum_length).toBe(80);
    expect(buscar('permisos_funciones', 'modulo')?.character_maximum_length).toBe(40);
    expect(buscar('permisos_funciones', 'nombre_negocio')?.character_maximum_length).toBe(120);
    expect(buscar('permisos_funciones', 'descripcion')?.data_type).toBe('text');
    expect(buscar('permisos_funciones', 'descripcion')?.is_nullable).toBe('NO');
    expect(buscar('permisos_funciones', 'tipo')?.character_maximum_length).toBe(10);
    expect(buscar('permisos_funciones', 'activo')?.column_default).toBe('true');
    expect(buscar('permisos_usuario_funcion', 'efecto')?.character_maximum_length).toBe(8);
    expect(buscar('permisos_rol_funcion', 'rol_codigo')?.character_maximum_length).toBe(40);
  });

  it('el catálogo de la base es EXACTAMENTE el que el código declara (AC2)', async () => {
    const filas = await sql`
      SELECT codigo, modulo, nombre_negocio, descripcion, tipo, activo
        FROM permisos_funciones ORDER BY codigo`;
    expect(filas.map((f) => f.codigo)).toEqual(CATALOGO.map((f) => f.codigo));
    for (const f of filas) {
      const enCodigo = CATALOGO.find((c) => c.codigo === f.codigo)!;
      expect(f.modulo).toBe(enCodigo.modulo);
      expect(f.nombre_negocio).toBe(enCodigo.nombreNegocio);
      expect(f.descripcion).toBe(enCodigo.descripcion);
      expect(f.tipo).toBe(enCodigo.tipo);
      expect(f.activo).toBe(true);
    }
  });

  it('44 funciones de tipo `pagina` y ninguna es `flito_ayuda` (AC2-bis)', async () => {
    // 43 → 44 desde la HU #12375 (0184 siembra `pagina.flito_tarifas`): la base ya migrada las tiene todas.
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM permisos_funciones WHERE tipo = 'pagina'`;
    expect(n).toBe(44);
    const [{ hay }] = await sql`
      SELECT count(*)::int AS hay FROM permisos_funciones WHERE codigo = 'pagina.flito_ayuda'`;
    expect(hay).toBe(0);
  });

  it('AC3 — ninguna función del canal Cliente retirado, buscada en la BASE', async () => {
    const filas = await sql`
      SELECT codigo FROM permisos_funciones
       WHERE codigo IN ('soat.revision.validar','soat.revision.rechazar','soat.causales.ver','soat.solicitud.subsanar')
          OR (codigo LIKE 'soat.%' AND (codigo LIKE '%causal%' OR codigo LIKE '%subsan%'))`;
    expect(filas.map((f) => f.codigo)).toEqual([]);
  });

  it('AC7 — la paridad rol × página, sobre los códigos de USER_ROLES que sigan existiendo', async () => {
    // Se cuelga de USER_ROLES —«vino con el producto»— y NO de `es_sistema`, que desde el ADR-0015
    // §Decisión 5 es un candado de borrado y solo lo tienen `admin` y `cliente`: colgarla de ahí
    // dejaría once roles sin comprobar. Y se compara la INTERSECCIÓN: un rol que el administrador
    // haya borrado sale de la comparación sin poner nada en rojo, y uno que haya creado tampoco.
    const vivos = (await sql`SELECT codigo FROM permisos_roles`).map((r) => r.codigo as string);
    const aComparar = USER_ROLES.filter((r) => vivos.includes(r) && r !== 'admin');
    expect(aComparar.length).toBeGreaterThan(0);

    for (const rol of aComparar) {
      const sembradas = (await sql`
        SELECT funcion_codigo FROM permisos_rol_funcion
         WHERE rol_codigo = ${rol} AND funcion_codigo LIKE 'pagina.%'
         ORDER BY funcion_codigo`).map((f) => f.funcion_codigo as string);
      const esperadas = paginasPorDefecto(rol)
        .filter((s) => !PAGINAS_NO_CONCEDIBLES.includes(s))
        .map((s) => `pagina.${s}`).sort();
      expect(sembradas, `divergencia en el rol «${rol}»`).toEqual(esperadas);
    }
  });

  it('AC4 — `admin` tiene las 44 páginas marcadas UNA A UNA (lo que hace neutro retirar los atajos)', async () => {
    const suyas = (await sql`
      SELECT funcion_codigo FROM permisos_rol_funcion
       WHERE rol_codigo = 'admin' AND funcion_codigo LIKE 'pagina.%'
       ORDER BY funcion_codigo`).map((f) => f.funcion_codigo as string);
    expect(suyas).toHaveLength(44);
    const todas = (await sql`
      SELECT codigo FROM permisos_funciones WHERE tipo = 'pagina' ORDER BY codigo`)
      .map((f) => f.codigo as string);
    expect(suyas).toEqual(todas);
    // Y son slugs de verdad, no cadenas cualesquiera: lo que el navegador va a recibir.
    for (const c of suyas) expect(isValidPage(c.replace('pagina.', ''))).toBe(true);
  });

  it('AC6 — `admin` no se queda fuera en silencio: solo las tres del canal Cliente', async () => {
    const sinAdmin = (await sql`
      SELECT f.codigo FROM permisos_funciones f
       WHERE NOT EXISTS (
         SELECT 1 FROM permisos_rol_funcion rf
          WHERE rf.rol_codigo = 'admin' AND rf.funcion_codigo = f.codigo)
       ORDER BY f.codigo`).map((f) => f.codigo as string);
    expect(sinAdmin).toEqual([...FUNCIONES_SIN_ADMIN].sort());
  });

  it('AC4 — el reparto entero de la base es el que el generador produce', async () => {
    const enBase = (await sql`
      SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion
       ORDER BY rol_codigo, funcion_codigo`).map((f) => `${f.rol_codigo}|${f.funcion_codigo}`);
    expect(enBase).toEqual(REPARTO.map(([r, c]) => `${r}|${c}`));
  });

  it('AC4 — el backfill por usuario copia `allowed_pages`, y solo lo válido', async () => {
    const filas = await sql`
      SELECT u.id, u.allowed_pages,
             -- FILTER y no array_agg a secas: con LEFT JOIN sin coincidencias, array_agg devuelve
             -- un array con NULL dentro y el driver lo entrega como la CADENA 'NULL', o sea una
             -- fila fantasma para todo usuario sin paginas concedidas.
             array_agg(puf.funcion_codigo ORDER BY puf.funcion_codigo)
               FILTER (WHERE puf.funcion_codigo IS NOT NULL) AS sembradas
        FROM users u
        LEFT JOIN permisos_usuario_funcion puf ON puf.user_id = u.id AND puf.efecto = 'conceder'
       GROUP BY u.id, u.allowed_pages`;
    for (const f of filas) {
      const esperadas = [...new Set((f.allowed_pages as string[]))]
        .filter((s) => isValidPage(s) && !PAGINAS_NO_CONCEDIBLES.includes(s))
        .map((s) => `pagina.${s}`).sort();
      const sembradas = ((f.sembradas as (string | null)[]) ?? []).filter(Boolean).sort();
      expect(sembradas, `usuario ${f.id}`).toEqual(esperadas);
    }
  });

  it('AC4 — no existe todavía ninguna fila con efecto `revocar`', async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM permisos_usuario_funcion WHERE efecto = 'revocar'`;
    expect(n).toBe(0);
  });

  it('la FK hacia `permisos_funciones` es RESTRICT: una función concedida no se borra', async () => {
    const error = await enTx(async (tx) => {
      try {
        await tx`DELETE FROM permisos_funciones WHERE codigo = 'pagina.users'`;
        return null;
      } catch (e) { return e as { code?: string }; }
    });
    expect(error?.code).toBe('23503');
  });

  it('la FK hacia `permisos_roles` es CASCADE: borrar un rol se lleva SU reparto y nada más', async () => {
    const { borradas, quedan } = await enTx(async (tx) => {
      await tx`INSERT INTO permisos_roles (codigo, nombre) VALUES ('rol_efimero_0179', 'Efímero')`;
      await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
               VALUES ('rol_efimero_0179', 'pagina.dashboard')`;
      const antes = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion`;
      await tx`DELETE FROM permisos_roles WHERE codigo = 'rol_efimero_0179'`;
      const despues = await tx`SELECT count(*)::int AS n FROM permisos_rol_funcion`;
      return { borradas: antes[0].n - despues[0].n, quedan: despues[0].n };
    });
    expect(borradas).toBe(1);
    expect(quedan).toBe(REPARTO.length);
  });

  it('el CHECK de `efecto` rechaza cualquier otro valor', async () => {
    const error = await enTx(async (tx) => {
      const [u] = await tx`SELECT id FROM users LIMIT 1`;
      try {
        await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
                 VALUES (${u.id}, 'pagina.dashboard', 'quizas')`;
        return null;
      } catch (e) { return e as { code?: string }; }
    });
    expect(error?.code).toBe('23514');
  });

  // ── El paso 0: la ventana del token viejo ──────────────────────────────────────────────────────
  //
  // Se simula la PRIMERA aplicacion tirando las tres tablas dentro de la transaccion que revierte:
  // el paso 0 se condiciona a `to_regclass('permisos_funciones') IS NULL`, asi que sobre la base ya
  // migrada NO corre —y ese es justo el otro caso, el de la idempotencia—. Sin tirarlas, este caso
  // pasaria en verde sin ejecutar ni una vez la linea que dice comprobar.
  it('AC4 — la primera aplicacion invalida la sesion de los `admin`, que se quedarian con 2 de 43', async () => {
    const { antes, admins, otros } = await enTx(async (tx) => {
      await tx`UPDATE users SET session_invalidated_at = NULL`;
      const a = (await tx`SELECT count(*)::int AS n FROM users WHERE session_invalidated_at IS NOT NULL`)[0].n;
      await tx`DROP TABLE IF EXISTS permisos_usuario_funcion, permisos_rol_funcion, permisos_funciones CASCADE`;
      await tx.unsafe(SQL_0179);
      return {
        antes: a,
        admins: (await tx`SELECT count(*)::int AS n FROM users
                           WHERE role = 'admin' AND session_invalidated_at IS NULL`)[0].n,
        otros: (await tx`SELECT count(*)::int AS n FROM users
                          WHERE role <> 'admin' AND session_invalidated_at IS NOT NULL`)[0].n,
      };
    });

    expect(antes).toBe(0);                 // se partio de cero marcas: el bump es de esta migracion
    expect(admins).toBe(0);                // ni un admin se queda sin invalidar
    // Y NADIE mas: los once roles no-admin resuelven igual con su token viejo, porque
    // `paginasPorDefecto` les devuelve sus defaults compilados. Bumpearlos seria cerrar la sesion de
    // todo el sistema para arreglar algo que a ninguno le pasa.
    expect(otros).toBe(0);
  }, 60_000);

  it('el UPDATE del paso 0 esta acotado a `admin` tambien en el texto del SQL', async () => {
    // El caso de arriba prueba el EFECTO sobre esta base, donde hay 2 admin y 8 no-admin. Este ata el
    // PREDICADO: si manana la base de pruebas no tuviera un no-admin, aquel caso pasaria con el
    // `WHERE` podado y nadie lo notaria.
    expect(SIN_COMENTARIOS)
      .toMatch(/UPDATE users SET session_invalidated_at = now\(\) WHERE role = 'admin'/);
    expect((SIN_COMENTARIOS.match(/UPDATE\s+users/gi) ?? [])).toHaveLength(1);
  });

  it('idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila (AC1)', async () => {
    // Se aplica el SQL NUEVO sobre la base ya migrada, dentro de una transacción que revierte. No se
    // reconstruye la cadena entera con un CREATE DATABASE: eso probaría otra cosa y tardaría minutos.
    const { antes, despues } = await enTx(async (tx) => {
      // `users` entra en la huella, y no es cosmetica: el paso 0 escribe en esa tabla y la version
      // anterior de este caso solo miraba las tres de permisos, asi que un `UPDATE ... now()`
      // incondicional habria pasado en verde rompiendo la promesa del AC1. Se incluye
      // `session_invalidated_at` COLUMNA A COLUMNA por eso mismo.
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(codigo||modulo||nombre_negocio||descripcion||tipo||activo::text, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
          (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS rf,
          (SELECT md5(string_agg(user_id::text||funcion_codigo||efecto, ',' ORDER BY user_id, funcion_codigo)) FROM permisos_usuario_funcion) AS uf,
          (SELECT md5(string_agg(id::text||role||coalesce(session_invalidated_at::text,'-'), ',' ORDER BY id)) FROM users) AS u
      `)[0];
      const a = await huella();
      await tx.unsafe(SQL_0179);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
