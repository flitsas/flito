// HU #12169 — La 0178: el catálogo de roles, la FK y los dos triggers.
//
// Este archivo tiene DOS mitades y la diferencia importa:
//
//   · **Estática** (siempre corre, también en CI): lo que el `.sql` dice y lo que `schema.ts` dice
//     tienen que ser la misma afirmación en dos idiomas. Es la paridad de las hermanas 0151/0158/0160.
//   · **Contra PostgreSQL de verdad** (solo si hay base): la FK, el `RESTRICT`, los dos triggers y la
//     idempotencia NO son afirmaciones sobre un archivo, son afirmaciones sobre el motor. El mock de
//     este repo no puede probarlas —devuelve la fila entera aunque el `select` pidiera menos, ignora
//     `orderBy` y su `transaction` es un stub pelado—, así que un test de trigger escrito sobre el
//     mock pasaría en verde SIN el trigger. Eso no es una prueba, es una decoración.
//
//     Se activa con la URL de una base con la cadena al día:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0178.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres y un rojo ahí sería un
//     rojo del entorno, no del código. Lo que no se hace es fingir que pasó: `describe.skipIf` lo
//     reporta como saltado.
//
// Las tres mutaciones nombradas del AC7 y dónde caen:
//   1. Quitar la FK `users.role → permisos_roles.codigo` → rojo en «la FK existe y es RESTRICT» y en
//      «un rol inexistente no entra». Ojo: el trigger TAMBIÉN rechaza un rol inexistente (23503), así
//      que el caso de comportamiento por sí solo sobreviviría a la mutación; por eso el aserto de
//      catálogo sobre `pg_constraint` es obligatorio y no redundante.
//   2. `tipo_enlace = 'ninguno'` para `cliente` en el backfill → rojo en el trigger del AC4 (el alta
//      sin compañía pasaría) y también en la paridad estática del backfill.
//   3. `tipo_principal = 'interno'` para `cliente` → rojo en el backfill del AC3, estático y en base.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { permisosRoles, users } from '../../src/db/schema.js';
import { ROLE_LABELS, USER_ROLES } from '@operaciones/shared-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0178_permisos_roles_modelo.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0178 = readFileSync(RUTA, 'utf8');

/** El ámbito que el AC3 le asigna a cada uno de los doce. */
const TIPO_ENLACE_ESPERADO: Record<string, string> = {
  admin: 'ninguno', proveedor: 'proveedor_soat', transito: 'organismos_transito',
  compliance: 'ninguno', lider_pesv: 'ninguno', supervisor_flota: 'ninguno', conductor: 'ninguno',
  auditor: 'ninguno', gestor_impuestos: 'organismos_transito', mensajero: 'ninguno',
  financiera: 'ninguno', cliente: 'compania',
};
/** El candado de borrado va en DOS filas y solo dos (ADR-0015 §Decisión 5). */
const CON_CANDADO = ['admin', 'cliente'];
// Lo que la BASE debe tener HOY, en la punta de la cadena: la 0180 (HU #12082) retiró el candado de
// `cliente` al pasar la frontera del canal externo de su literal a `tipo_principal`. La mitad estática
// de este spec sigue leyendo el archivo 0178, que sí lo sembraba; la mitad contra base mira el resultado
// de toda la cadena y por eso usa esta constante y no la de arriba.
const CON_CANDADO_HOY = ['admin'];
/** El único rol externo de hoy. */
const EXTERNOS = ['cliente'];

/**
 * El SQL sin sus comentarios. Hace falta de verdad: este archivo NOMBRA en sus comentarios lo que
 * promete no hacer («ningún ALTER TYPE … ADD VALUE», «ON CONFLICT DO NOTHING y no DO UPDATE»), y un
 * regex sobre el texto crudo se pondría rojo por la explicación en lugar de por el código. Es el
 * mismo motivo por el que `scanForTxControl` quita los comentarios antes de buscar.
 */
const SIN_COMENTARIOS = SQL_0178.replace(/--[^\n]*/g, '');

interface FilaBackfill {
  codigo: string; nombre: string; tipoEnlace: string; tipoPrincipal: string; esSistema: boolean;
}

/** Lee del propio `.sql` las doce tuplas del `INSERT` del paso 2. */
function backfillDelArchivo(sql: string): FilaBackfill[] {
  const bloque = sql.split('INSERT INTO permisos_roles')[1]?.split('ON CONFLICT')[0] ?? '';
  const re = /\(\s*'([a-z_]+)',\s*'([^']+)',\s*'([a-z_]+)',\s*'([a-z]+)',\s*(true|false)\s*\)/g;
  const filas: FilaBackfill[] = [];
  for (const m of bloque.matchAll(re)) {
    filas.push({
      codigo: m[1], nombre: m[2], tipoEnlace: m[3], tipoPrincipal: m[4], esSistema: m[5] === 'true',
    });
  }
  return filas;
}

describe('0178 — el archivo dice lo mismo que schema.ts (análisis estático)', () => {
  it('no trae control de transacción propio: el runner lo rechazaría con exit 2 (ADR-DB-001)', () => {
    // Se usa el MISMO escáner del runner y no un regex de aquí: una copia se desincroniza, y este
    // archivo ya cayó una vez por nombrar una etiqueta de dollar-quoting dentro de un comentario.
    expect(scanForTxControl(ARCHIVO, SQL_0178)).toEqual([]);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    // Ningún aserto de este archivo leía la cabecera, así que un cambio ahí pasaba inadvertido —lo
    // que es tanto como no tener convención—. Las tres migraciones anteriores (0175/0176/0177) abren
    // igual: nombre del archivo, Feature/HU y `Autor:` con antecedentes.
    const cabecera = SQL_0178.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12169/);
  });

  it('declara las puertas que quedan abiertas, incluida la que sostiene la garantía nueva', () => {
    // La cabecera es donde se lee lo que la migración NO garantiza. Dos de esas puertas están
    // MEDIDAS contra la base y no deducidas: `users.transito_codigo` no tiene ninguna FK (cero
    // constraints de tipo `f`; su hermana de la tabla puente sí la tiene, con RESTRICT), y el
    // trigger acepta un '99999' inexistente como prueba de ámbito. Que eso esté escrito es parte de
    // la entrega: el brazo diferido se apoya en esa columna.
    expect(SQL_0178).toMatch(/No comprueban que `users\.transito_codigo` APUNTE A ALGO/);
    expect(SQL_0178).toMatch(/#12088/);
    expect(SQL_0178).toMatch(/UPDATE \.\.\. SET user_id = <otro>/);
  });

  it('no extiende el enum: cero ALTER TYPE … ADD VALUE (AC2)', () => {
    expect(/ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(SIN_COMENTARIOS)).toBe(false);
  });

  it('declara la tabla con sus dos CHECK y no borra el tipo user_role (AC1/AC2)', () => {
    expect(SQL_0178).toMatch(/CREATE TABLE IF NOT EXISTS permisos_roles/);
    expect(SQL_0178).toMatch(/permisos_roles_tipo_enlace_chk[\s\S]*?'ninguno','compania','proveedor_soat','organismos_transito'/);
    expect(SQL_0178).toMatch(/permisos_roles_tipo_principal_chk[\s\S]*?'interno','externo'/);
    expect(SQL_0178).toMatch(/COMMENT ON TYPE user_role IS[\s\S]*?OBSOLETO/);
    expect(/DROP\s+TYPE\s+user_role/i.test(SIN_COMENTARIOS)).toBe(false);
  });

  it('convierte users.role a varchar(40) y le pone la FK RESTRICT en las dos direcciones (AC2)', () => {
    expect(SQL_0178).toMatch(/ALTER TABLE users ALTER COLUMN role TYPE varchar\(40\) USING role::text/);
    expect(SQL_0178).toMatch(/ADD CONSTRAINT users_role_fkey[\s\S]*?REFERENCES permisos_roles\(codigo\)[\s\S]*?ON UPDATE RESTRICT ON DELETE RESTRICT/);
    expect(SQL_0178).toMatch(/DROP CONSTRAINT IF EXISTS users_cliente_compania_chk/);
  });

  it('los dos triggers, y solo el de organismos es DEFERRED (AC4)', () => {
    expect(SQL_0178).toMatch(/CREATE CONSTRAINT TRIGGER users_ambito_trg[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/);
    expect(SQL_0178).toMatch(/CREATE CONSTRAINT TRIGGER users_ambito_organismos_trg[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    // Cada trigger vigila su rol Y la columna donde vive el ámbito que exige. El diferido nació
    // mirando solo `role` y eso dejaba un hueco real: `UPDATE users SET transito_codigo = NULL`
    // sobre un `transito` válido no disparaba nada (medido). La garantía es de la BASE o no es.
    expect(SQL_0178).toMatch(/AFTER INSERT OR UPDATE OF role, transito_codigo ON users/);
    // El predicado de organismos acepta las DOS formas. Si alguien poda la primera mitad, el alta de
    // TODO usuario `transito` se cae: por eso se vigila el texto y no solo el comportamiento.
    expect(SQL_0178).toMatch(/NEW\.transito_codigo IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM flito_gestor_organismos/);
    // El trigger inmediato se dispara por COLUMNAS y no por UPDATE a secas: `toggle` no debe fallar.
    expect(SQL_0178).toMatch(/AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_soat_id ON users/);
  });

  it('el backfill son los doce de USER_ROLES con su ROLE_LABELS y sin `operaciones` (AC3)', () => {
    const filas = backfillDelArchivo(SQL_0178);
    expect(filas).toHaveLength(12);
    expect(filas.map((f) => f.codigo).sort()).toEqual([...USER_ROLES].sort());
    expect(filas.map((f) => f.codigo)).not.toContain('operaciones');
    for (const f of filas) {
      // Si el nombre diverge de ROLE_LABELS, la pantalla muestra dos etiquetas para el mismo rol
      // según de dónde las lea. Por eso se compara contra la constante y no contra una copia.
      expect(f.nombre).toBe(ROLE_LABELS[f.codigo as keyof typeof ROLE_LABELS]);
      expect(f.tipoEnlace).toBe(TIPO_ENLACE_ESPERADO[f.codigo]);
      expect(f.tipoPrincipal).toBe(EXTERNOS.includes(f.codigo) ? 'externo' : 'interno');
      expect(f.esSistema).toBe(CON_CANDADO.includes(f.codigo));
    }
  });

  it('`es_sistema` es el candado y va en DOS filas exactas: admin y cliente (AC3 corregido)', () => {
    const conCandado = backfillDelArchivo(SQL_0178).filter((f) => f.esSistema).map((f) => f.codigo);
    expect(conCandado.sort()).toEqual([...CON_CANDADO].sort());
  });

  it('el backfill no mueve filas en la segunda pasada: DO NOTHING y nunca DO UPDATE (AC1)', () => {
    expect(SQL_0178).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(/ON CONFLICT[\s\S]*?DO UPDATE/i.test(SIN_COMENTARIOS)).toBe(false);
  });

  it('schema.ts declara la MISMA tabla que el SQL: columnas, tipos y los dos CHECK (AC1)', () => {
    const t = getTableConfig(permisosRoles);
    expect(t.name).toBe('permisos_roles');
    const cols = Object.fromEntries(t.columns.map((c) => [c.name, c]));
    expect(Object.keys(cols).sort()).toEqual([
      'activo', 'codigo', 'created_at', 'descripcion', 'es_sistema', 'nombre', 'tipo_enlace',
      'tipo_principal', 'updated_at',
    ]);
    expect(cols.codigo.primary).toBe(true);
    expect(cols.codigo.getSQLType()).toBe('varchar(40)');
    expect(cols.nombre.getSQLType()).toBe('varchar(80)');
    expect(cols.nombre.notNull).toBe(true);
    expect(cols.descripcion.notNull).toBe(false);
    expect(cols.tipo_enlace.getSQLType()).toBe('varchar(24)');
    expect(cols.tipo_enlace.default).toBe('ninguno');
    expect(cols.tipo_principal.getSQLType()).toBe('varchar(10)');
    expect(cols.tipo_principal.default).toBe('interno');
    expect(cols.es_sistema.default).toBe(false);
    expect(cols.activo.default).toBe(true);
    expect(t.checks.map((c) => c.name).sort())
      .toEqual(['permisos_roles_tipo_enlace_chk', 'permisos_roles_tipo_principal_chk']);
  });

  it('schema.ts declara users.role como varchar(40) con la FK RESTRICT/RESTRICT (AC2)', () => {
    const t = getTableConfig(users);
    const role = t.columns.find((c) => c.name === 'role')!;
    expect(role.getSQLType()).toBe('varchar(40)');
    expect(role.notNull).toBe(true);
    const fk = t.foreignKeys.map((f) => f.reference()).find((r) => r.columns.some((c) => c.name === 'role'));
    expect(fk).toBeDefined();
    expect(fk!.foreignTable).toBe(permisosRoles);
    expect(fk!.foreignColumns.map((c) => c.name)).toEqual(['codigo']);
    const cfg = t.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'role'))!;
    expect(cfg.onDelete).toBe('restrict');
    expect(cfg.onUpdate).toBe('restrict');
    expect(t.indexes.map((i) => i.config.name)).toContain('idx_users_role');
  });
});

// ── Contra PostgreSQL de verdad ──────────────────────────────────────────────────────────────────

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

describe.skipIf(!URL_BASE)('0178 — contra la base real (FK, triggers e idempotencia)', () => {
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

  /** Un usuario mínimo. Devuelve el error de Postgres (o null si entró). */
  async function altaUsuario(
    tx: postgres.TransactionSql, role: string, extra: Record<string, unknown> = {},
  ): Promise<{ code?: string; message: string; constraint_name?: string } | null> {
    const suf = Math.random().toString(36).slice(2, 10);
    const fila = {
      username: `t_${suf}`, name: 'Test 0178', password_hash: 'x', role, ...extra,
    };
    try {
      // SAVEPOINT y no un `try` pelado: en PostgreSQL un error ABORTA la transacción entera y toda
      // sentencia posterior sale con 25P02. Sin el savepoint, el primer caso que falla —que es lo
      // que estos tests buscan— deja inservible la transacción y el rollback del final.
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO users ${sp(fila as never)}`;
        // Los CONSTRAINT TRIGGER diferidos NO se evalúan hasta el COMMIT; forzarlos aquí es lo que
        // permite ver su error dentro de la transacción de prueba en vez de en el rollback.
        await sp`SET CONSTRAINTS ALL IMMEDIATE`;
      });
      // Y se deshace: `SET CONSTRAINTS` vale para el RESTO de la transacción, no para la sentencia.
      // Sin esto, el primer alta de un caso convierte en inmediato el trigger DIFERIDO para los
      // siguientes, y el alta del gestor —que escribe sus organismos DESPUÉS— fallaría por el
      // montaje del test y no por el código. Costó un rojo: queda escrito. (Cuando el savepoint se
      // deshace por un error, el `SET CONSTRAINTS` se deshace con él y no hay nada que restaurar.)
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      return null;
    } catch (e) {
      const err = e as { code?: string; message: string; constraint_name?: string };
      return { code: err.code, message: err.message, constraint_name: err.constraint_name };
    }
  }

  it('AC2 — la FK existe y es RESTRICT en borrado Y en actualización', async () => {
    // Este aserto es el que caza la mutación 1. El de comportamiento de abajo NO basta por sí solo:
    // sin FK, el trigger sigue rechazando el rol inexistente y el mutante sobreviviría.
    const [fk] = await sql`
      SELECT conname, confdeltype, confupdtype, confrelid::regclass::text AS destino
        FROM pg_constraint
       WHERE conrelid = 'users'::regclass AND contype = 'f' AND conname = 'users_role_fkey'`;
    expect(fk).toBeDefined();
    expect(fk.confdeltype).toBe('r');
    expect(fk.confupdtype).toBe('r');
    expect(fk.destino).toBe('permisos_roles');
    const [col] = await sql`
      SELECT format_type(atttypid, atttypmod) AS tipo, attnotnull
        FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'role'`;
    expect(col.tipo).toBe('character varying(40)');
    expect(col.attnotnull).toBe(true);
  });

  it('AC2 — el CHECK literal de la 0168 ya no está y el tipo user_role sigue vivo y marcado obsoleto', async () => {
    const chk = await sql`
      SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass
        AND conname = 'users_cliente_compania_chk'`;
    expect(chk).toHaveLength(0);
    const [t] = await sql`
      SELECT obj_description('user_role'::regtype, 'pg_type') AS nota,
             (SELECT count(*)::int FROM pg_enum WHERE enumtypid = 'user_role'::regtype) AS etiquetas`;
    expect(t.nota).toMatch(/OBSOLETO/);
    expect(t.etiquetas).toBe(13); // sigue `operaciones` dentro; el tipo no se borra (reversibilidad)
    const usos = await sql`
      SELECT a.attrelid::regclass::text AS tabla, a.attname
        FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
       WHERE ty.typname = 'user_role' AND a.attnum > 0 AND NOT a.attisdropped`;
    expect(usos).toEqual([]); // ninguna columna lo usa
  });

  it('AC3 — los doce están en la base con su etiqueta, su ámbito, su candado y su principal', async () => {
    const filas = await sql<{ codigo: string; nombre: string; tipo_enlace: string;
      tipo_principal: string; es_sistema: boolean; activo: boolean }[]>`
      SELECT codigo, nombre, tipo_enlace, tipo_principal, es_sistema, activo
        FROM permisos_roles ORDER BY codigo`;
    expect(filas).toHaveLength(12);
    expect(filas.map((f) => f.codigo)).not.toContain('operaciones');
    for (const f of filas) {
      expect(f.nombre).toBe(ROLE_LABELS[f.codigo as keyof typeof ROLE_LABELS]);
      expect(f.tipo_enlace).toBe(TIPO_ENLACE_ESPERADO[f.codigo]);
      // Mutación 3: `tipo_principal='interno'` en `cliente` deja este aserto en rojo.
      expect(f.tipo_principal).toBe(EXTERNOS.includes(f.codigo) ? 'externo' : 'interno');
      expect(f.es_sistema).toBe(CON_CANDADO_HOY.includes(f.codigo));
      expect(f.activo).toBe(true);
    }
  });

  it('AC2 — un rol inexistente no entra, y quien lo rechaza es la FK', async () => {
    const err = await enTx((tx) => altaUsuario(tx, 'rol_inventado'));
    expect(err).not.toBeNull();
    expect(err!.code).toBe('23503');
    // El `constraint_name` NO es adorno: el trigger `users_ambito_trg` también levanta un 23503 para
    // un rol que no está en el catálogo, así que sin este aserto la mutación «quitar la FK» dejaría
    // este caso EN VERDE con el rechazo llegando de otro sitio. Medido: los AFTER ROW se disparan en
    // orden de nombre y el trigger interno de la FK (`RI_ConstraintTrigger_…`) va antes que
    // `users_ambito_trg`, así que el error que sale es el de la FK, con su nombre.
    expect(err!.constraint_name).toBe('users_role_fkey');
  });

  it('AC4 — un rol con tipo_enlace=compania exige compañía, y sin ella falla en base (RN-A2)', async () => {
    // Mutación 2: con `cliente` en `tipo_enlace='ninguno'`, este INSERT pasaría y esto se pone rojo.
    const err = await enTx((tx) => altaUsuario(tx, 'cliente'));
    expect(err).not.toBeNull();
    expect(err!.code).toBe('23514');
    expect(err!.message).toMatch(/exige compañía/);
  });

  it('AC4 — con compañía, el mismo alta pasa', async () => {
    const r = await enTx(async (tx) => {
      const [c] = await tx`SELECT id FROM clients LIMIT 1`;
      if (!c) return 'sin-compañías';
      return altaUsuario(tx, 'cliente', { compania_id: c.id });
    });
    expect(r).toBeNull();
  });

  it('AC4 — la razón de ser del trigger: cubre un rol NUEVO que el CHECK literal jamás habría visto', async () => {
    const err = await enTx(async (tx) => {
      await tx`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace, tipo_principal)
               VALUES ('consulta_cliente', 'Consulta cliente', 'compania', 'externo')`;
      return altaUsuario(tx, 'consulta_cliente');
    });
    expect(err).not.toBeNull();
    expect(err!.code).toBe('23514');
  });

  it('AC4 — proveedor_soat exige su proveedor', async () => {
    const err = await enTx((tx) => altaUsuario(tx, 'proveedor'));
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/exige proveedor SOAT/);
  });

  it('AC4 — organismos_transito acepta las DOS formas: transito por columna, gestor por la puente', async () => {
    const r = await enTx(async (tx) => {
      const [org] = await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`;
      if (!org) return { salta: true } as const;
      // `transito` guarda su organismo en la COLUMNA. Un predicado que mirase solo la tabla puente
      // rechazaría este alta legítima — es el hallazgo que partió el trigger en dos.
      const transito = await altaUsuario(tx, 'transito', { transito_codigo: org.codigo });
      // `gestor_impuestos` lo guarda en la PUENTE, y la escribe DESPUÉS: es el orden real de
      // `users.service.ts`. Con el trigger en IMMEDIATE esto fallaría siempre.
      const suf = Math.random().toString(36).slice(2, 10);
      const [u] = await tx`
        INSERT INTO users (username, name, password_hash, role)
        VALUES (${`g_${suf}`}, 'Gestor 0178', 'x', 'gestor_impuestos') RETURNING id`;
      await tx`INSERT INTO flito_gestor_organismos (user_id, organismo_codigo)
               VALUES (${u.id}, ${org.codigo})`;
      let gestor: string | null = null;
      try { await tx`SET CONSTRAINTS ALL IMMEDIATE`; } catch (e) { gestor = (e as Error).message; }
      return { salta: false, transito, gestor } as const;
    });
    if (r.salta) return;
    expect(r.transito).toBeNull();
    expect(r.gestor).toBeNull();
  });

  it('AC4 — un gestor SIN ningún organismo no llega a confirmarse', async () => {
    const err = await enTx((tx) => altaUsuario(tx, 'gestor_impuestos'));
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/exige al menos un organismo/);
  });

  it('AC4 — cada trigger vigila su rol Y las columnas del ámbito que exige (catálogo)', async () => {
    // Aserto de catálogo, deterministo, sobre `tgattr`: es la red que no depende de que el caso de
    // comportamiento acierte a reproducirse. Cae de inmediato si alguien poda una columna de la
    // lista `UPDATE OF`, que es justo la mutación que este bloque persigue.
    const filas = await sql<{ tgname: string; columnas: string }[]>`
      SELECT t.tgname,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                FROM unnest(t.tgattr) col
                JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = col) AS columnas
        FROM pg_trigger t
       WHERE t.tgrelid = 'users'::regclass AND NOT t.tgisinternal
       ORDER BY t.tgname`;
    const porNombre = Object.fromEntries(filas.map((f) => [f.tgname, f.columnas]));
    expect(porNombre.users_ambito_trg).toBe('compania_id,flito_proveedor_soat_id,role');
    expect(porNombre.users_ambito_organismos_trg).toBe('role,transito_codigo');
    // Y `active` NO está en ninguna de las dos listas: `toggle` no puede romperse por esto.
    expect(Object.values(porNombre).join(',')).not.toMatch(/\bactive\b/);
  });

  it('AC4 — quitarle el organismo a un `transito` válido falla en base, sin tocar su rol', async () => {
    // El hueco que encontró QA. No es alcanzable desde la API de hoy —el `superRefine` de
    // `users.routes.ts` lo rechaza antes—, y por eso mismo tiene que estar en la base: un psql de
    // soporte o un PATCH futuro producen el usuario imposible sin que Zod se entere. Que hoy no se
    // pueda llegar es un accidente del código de rutas, no una propiedad de la base.
    const r = await enTx(async (tx) => {
      const [org] = await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`;
      if (!org) return { salta: true } as const;
      const suf = Math.random().toString(36).slice(2, 10);
      const [u] = await tx`
        INSERT INTO users (username, name, password_hash, role, transito_codigo)
        VALUES (${`tr_${suf}`}, 'Transito 0178', 'x', 'transito', ${org.codigo}) RETURNING id`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      let error: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`UPDATE users SET transito_codigo = NULL WHERE id = ${u.id}`;
          await sp`SET CONSTRAINTS ALL IMMEDIATE`;
        });
      } catch (e) { error = (e as Error).message; }
      return { salta: false, error } as const;
    });
    if (r.salta) return;
    expect(r.error).toMatch(/exige al menos un organismo/);
  });

  it('AC4 — simetría del trigger inmediato: quitarle la compañía a un `cliente` falla igual', async () => {
    // Sondeado contra la base antes de escribirlo, no deducido de leer el `UPDATE OF`.
    const r = await enTx(async (tx) => {
      const [c] = await tx`SELECT id FROM clients LIMIT 1`;
      if (!c) return { salta: true } as const;
      const suf = Math.random().toString(36).slice(2, 10);
      const [u] = await tx`
        INSERT INTO users (username, name, password_hash, role, compania_id)
        VALUES (${`cl_${suf}`}, 'Cliente 0178', 'x', 'cliente', ${c.id}) RETURNING id`;
      let error: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`UPDATE users SET compania_id = NULL WHERE id = ${u.id}`;
        });
      } catch (e) { error = (e as Error).message; }
      return { salta: false, error } as const;
    });
    if (r.salta) return;
    expect(r.error).toMatch(/exige compañía/);
  });

  it('AC4 — el trigger no se dispara al activar/desactivar: `toggle` no puede romperse por esto', async () => {
    const r = await enTx(async (tx) => {
      const [u] = await tx`SELECT id FROM users LIMIT 1`;
      try {
        await tx`UPDATE users SET active = NOT active WHERE id = ${u.id}`;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
        return null;
      } catch (e) { return (e as Error).message; }
    });
    expect(r).toBeNull();
  });

  it('CF-05/RN-A8 — un rol CON usuarios no se borra; uno sin usuarios, sí', async () => {
    const conUsuarios = await enTx(async (tx) => {
      try { await tx`DELETE FROM permisos_roles WHERE codigo = 'admin'`; return null; }
      catch (e) { const x = e as { code?: string; constraint_name?: string }; return x; }
    });
    expect(conUsuarios).not.toBeNull();
    expect(conUsuarios!.code).toBe('23503');
    // Es la FK quien lo impide, con nombre y apellido: sin ella (mutación 1) el DELETE pasaría.
    expect(conUsuarios!.constraint_name).toBe('users_role_fkey');

    const sinUsuarios = await enTx(async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE role = 'conductor'`;
      if (n > 0) return 'tiene-usuarios';
      await tx`DELETE FROM permisos_roles WHERE codigo = 'conductor'`;
      return null;
    });
    expect(sinUsuarios).toBeNull();
  });

  it('AC1 — la migración es idempotente en sentido fuerte: la segunda pasada no cambia ni una fila', async () => {
    const huella = async (tx: postgres.TransactionSql) => {
      const [r] = await tx<{ h: string; n: number; u: string }[]>`
        SELECT md5(string_agg(codigo || nombre || tipo_enlace || tipo_principal || es_sistema::text
                              || activo::text || created_at::text || updated_at::text, '|'
                              ORDER BY codigo)) AS h,
               count(*)::int AS n,
               (SELECT md5(string_agg(id::text || role, '|' ORDER BY id)) FROM users) AS u
          FROM permisos_roles`;
      return r;
    };
    const r = await enTx(async (tx) => {
      const antes = await huella(tx);
      await tx.unsafe(SQL_0178); // la MISMA migración, otra vez, sobre la base ya migrada
      const despues = await huella(tx);
      return { antes, despues };
    });
    expect(r.despues.h).toBe(r.antes.h);       // ni `updated_at` se mueve
    expect(r.despues.n).toBe(r.antes.n);
    expect(r.despues.u).toBe(r.antes.u);       // ningún usuario cambia de rol (AC3)
  });
});
