// HU #12171 — La 0185: la tabla `permisos_auditoria` (ADR-0014), su inmutabilidad por REVOKE, la
// retención declarada (AC5) y la siembra de `usuarios.auditoria.*` + `pagina.users` para `auditor`.
//
// Dos mitades, igual que la 0180:
//   · **Estática** (siempre corre, también en CI): lo que el `.sql` dice y lo que el modelo Drizzle
//     (`db/schema/permisos.ts`) dice tienen que ser la misma afirmación en dos idiomas — columnas,
//     nombres de índice y de CHECK, y la CLÁUSULA de las dos FK (mutación 4: `SET NULL` en vez de
//     `RESTRICT` cae aquí, no en «existe la columna»); y las reglas del archivo (sin BEGIN, sin ALTER
//     TYPE, sin ADD COLUMN, sin CREATE TRIGGER, dollar-quoting etiquetado, cabecera).
//   · **Contra PostgreSQL de verdad** (solo si hay base): FK RESTRICT reales, los CHECK que rechazan
//     PII y el `password` con valor, la ACL sin UPDATE/DELETE/TRUNCATE, la política de retención, la
//     siembra y la idempotencia fuerte. Se activa con la URL de una base con la cadena al día:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0185.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CAMPOS_AUDITABLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { permisosAuditoria, users } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0185_permisos_auditoria.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0185 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0185.replace(/--[^\n]*/g, '');

const CHECKS = [
  'permisos_auditoria_entidad_chk', 'permisos_auditoria_accion_chk', 'permisos_auditoria_origen_chk',
  'permisos_auditoria_sujeto_chk', 'permisos_auditoria_titular_rol_chk', 'permisos_auditoria_actor_chk',
  'permisos_auditoria_campo_chk', 'permisos_auditoria_campo_lista_chk', 'permisos_auditoria_password_sin_valor_chk',
];
const INDICES = [
  'idx_permisos_auditoria_titular', 'idx_permisos_auditoria_rol', 'idx_permisos_auditoria_entidad', 'idx_permisos_auditoria_created',
];

describe('0185 — el archivo dice lo mismo que schema/permisos.ts (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y los DO llevan dollar-quoting etiquetado, sin nombrar la etiqueta en comentarios', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0185)).toEqual([]);
    expect(SQL_0185).toMatch(/DO \$revoke0185\$ BEGIN/);
    expect(SQL_0185).toMatch(/END \$revoke0185\$;/);
    expect(SQL_0185).toMatch(/DO \$resumen0185\$/);
    expect(SQL_0185).toMatch(/END \$resumen0185\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const comentarios = SQL_0185.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(comentarios).not.toMatch(/\$revoke0185\$|\$resumen0185\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0185.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12171/);
    expect(cabecera).toMatch(/ADR-0014/);
  });

  it('el número es 0185 y no colisiona con ningún otro archivo', () => {
    const con0185 = readdirSync(path.dirname(RUTA)).filter((f) => f.startsWith('0185_'));
    expect(con0185).toEqual([ARCHIVO]);
  });

  it('nada de ALTER TYPE, ADD COLUMN ni CREATE TRIGGER: crea una tabla nueva, inmutable por REVOKE y no por disparador', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/ALTER\s+TYPE/i);
    expect(SIN_COMENTARIOS).not.toMatch(/ADD\s+COLUMN/i);
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i);
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS permisos_auditoria/);
    for (const idx of INDICES) expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}\\n\\s+ON permisos_auditoria \\([^)]*created_at DESC\\)`));
    expect(SIN_COMENTARIOS).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON permisos_auditoria FROM PUBLIC;/);
    expect(SIN_COMENTARIOS).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON permisos_auditoria FROM operaciones_app;/);
    expect(SIN_COMENTARIOS).toMatch(/GRANT SELECT, INSERT ON permisos_auditoria TO operaciones_app;/);
    // `audit_logs` y `RECURSOS_FLITO` no se tocan (AC2): ni ALTER, ni INSERT, ni UPDATE, ni DELETE sobre ella.
    expect(SIN_COMENTARIOS).not.toMatch(/(ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+audit_logs/i);
  });

  it('las dos FK hacia users son RESTRICT en borrado Y en actualización (ADR-0005; mutación 4) y son las únicas', () => {
    expect(SIN_COMENTARIOS).toMatch(/usuario_afectado_id\s+integer\s+REFERENCES users\(id\) ON UPDATE RESTRICT ON DELETE RESTRICT,/);
    expect(SIN_COMENTARIOS).toMatch(/actor_user_id\s+integer\s+REFERENCES users\(id\) ON UPDATE RESTRICT ON DELETE RESTRICT,/);
    expect(SIN_COMENTARIOS.match(/REFERENCES/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).not.toMatch(/ON (DELETE|UPDATE) (SET NULL|CASCADE|NO ACTION)/i);
    // `rol_afectado_codigo` SIN FK a propósito (CF-05).
    expect(SIN_COMENTARIOS).toMatch(/rol_afectado_codigo\s+varchar\(40\),/);
    // Y lo mismo en el modelo, por la CLÁUSULA:
    const cfg = getTableConfig(permisosAuditoria);
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) {
      expect(fk.reference().foreignTable).toBe(users);
      expect(fk.onDelete).toBe('restrict');
      expect(fk.onUpdate).toBe('restrict');
    }
    expect(cfg.foreignKeys.map((fk) => fk.reference().columns[0]!.name).sort()).toEqual(['actor_user_id', 'usuario_afectado_id']);
  });

  it('las columnas del SQL son las del modelo Drizzle, una a una; índices y CHECK con el MISMO nombre', () => {
    const cfg = getTableConfig(permisosAuditoria);
    expect(cfg.name).toBe('permisos_auditoria');
    const columnas = cfg.columns.map((c) => c.name);
    expect(columnas).toEqual([
      'id', 'lote_id', 'entidad', 'accion', 'campo', 'valor_antes', 'valor_despues',
      'usuario_afectado_id', 'usuario_afectado_rol', 'rol_afectado_codigo',
      'actor_user_id', 'actor_email', 'actor_rol', 'ip_address', 'user_agent',
      'origen', 'motivo', 'created_at',
    ]);
    for (const c of columnas) expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+${c}\\s+`));
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([...INDICES].sort());
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([...CHECKS].sort());
    for (const chk of CHECKS) expect(SIN_COMENTARIOS).toMatch(new RegExp(`CONSTRAINT ${chk}\\s+CHECK`));
    // Los dos índices parciales llevan su WHERE en los dos idiomas.
    expect(SIN_COMENTARIOS).toMatch(/idx_permisos_auditoria_titular\n\s+ON permisos_auditoria \(usuario_afectado_id, created_at DESC\)\n\s+WHERE usuario_afectado_id IS NOT NULL;/);
    expect(SIN_COMENTARIOS).toMatch(/idx_permisos_auditoria_rol\n\s+ON permisos_auditoria \(rol_afectado_codigo, created_at DESC\)\n\s+WHERE rol_afectado_codigo IS NOT NULL;/);
    const titular = cfg.indexes.find((i) => i.config.name === 'idx_permisos_auditoria_titular')!;
    expect(new PgDialect().sqlToQuery(titular.config.where!).sql.toLowerCase()).toContain('"usuario_afectado_id" is not null');
  });

  it('la lista blanca de `campo` es la MISMA en shared-types, en el CHECK del modelo y en el CHECK del SQL (RN-A10)', () => {
    const esperados = [...new Set(Object.values(CAMPOS_AUDITABLES).flat())];
    // SQL: el bloque del CHECK contiene exactamente esos literales y ninguno más.
    const bloque = SIN_COMENTARIOS.split('permisos_auditoria_campo_lista_chk')[1]!.split('),\n')[0]!;
    const enSql = [...bloque.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(enSql.sort()).toEqual([...esperados].sort());
    // Modelo: el CHECK renderizado nombra los mismos literales.
    const cfg = getTableConfig(permisosAuditoria);
    const chk = cfg.checks.find((c) => c.name === 'permisos_auditoria_campo_lista_chk')!;
    const sqlChk = new PgDialect().sqlToQuery(chk.value).sql;
    for (const campo of esperados) expect(sqlChk).toContain(`'${campo}'`);
    for (const pii of ['email', 'name', 'username', 'password_hash', 'documento', 'telefono']) {
      expect(enSql).not.toContain(pii);
      expect(sqlChk).not.toContain(`'${pii}'`);
    }
    // El hecho `password` va sin valor, en los dos idiomas.
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(campo <> 'password' OR \(valor_antes IS NULL AND valor_despues IS NULL\)\)/);
    const pwd = cfg.checks.find((c) => c.name === 'permisos_auditoria_password_sin_valor_chk')!;
    expect(new PgDialect().sqlToQuery(pwd.value).sql.toLowerCase()).toMatch(/<> 'password' or \(.*is null and .*is null\)/);
  });

  it('la retención queda declarada (AC5): 6 años, archivar_offline, condicionada a que exista un admin, ON CONFLICT DO NOTHING; repetida en el COMMENT y con la HU #12215 nombrada', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO pesv_retencion_politicas/);
    expect(SIN_COMENTARIOS).toMatch(/'permisos_auditoria', 6, 'Ley 1581\/2012 art\. 11 \+ ISO 27001 A\.12\.4',\s+'archivar_offline'::pesv_retencion_accion/);
    expect(SIN_COMENTARIOS).toMatch(/\(SELECT min\(id\) FROM users WHERE role = 'admin'\)\s+WHERE EXISTS \(SELECT 1 FROM users WHERE role = 'admin'\)\s+ON CONFLICT \(tipo_documento\) DO NOTHING/);
    expect(SIN_COMENTARIOS).not.toMatch(/users\.id = 1|id = 1\b/);
    expect(SIN_COMENTARIOS).toMatch(/COMMENT ON TABLE permisos_auditoria IS[\s\S]*Retencion declarada: 6 anios, archivar_offline[\s\S]*HU #12215/);
    expect(SIN_COMENTARIOS).toMatch(/Mecanismo: HU #12215/);
  });

  it('siembra las dos funciones y su reparto (admin y auditor) y `pagina.users` para auditor, todo ON CONFLICT DO NOTHING y sin DO UPDATE', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_funciones \(codigo, modulo, nombre_negocio, descripcion, tipo\) VALUES/);
    expect(SIN_COMENTARIOS).toMatch(/\('usuarios\.auditoria\.ver', 'usuarios', 'Ver el historial de cambios de usuarios y permisos', '[^']+', 'operacion'\)/);
    expect(SIN_COMENTARIOS).toMatch(/\('usuarios\.auditoria\.filtrar', 'usuarios', 'Listar los usuarios para filtrar el historial', '[^']+', 'operacion'\)/);
    const tuplas = SQL_0185.split('\n').map((l) => l.trim()).filter((l) => l.startsWith("('")).map((l) => l.replace(/,$/, ''));
    expect(tuplas.filter((t) => t.split(',').length === 2).sort()).toEqual([
      "('admin', 'usuarios.auditoria.filtrar')",
      "('admin', 'usuarios.auditoria.ver')",
      "('auditor', 'pagina.users')",
      "('auditor', 'usuarios.auditoria.filtrar')",
      "('auditor', 'usuarios.auditoria.ver')",
    ]);
    // NO se le dan al auditor listar ni ver_resumen (AC4: censo entero).
    expect(SIN_COMENTARIOS).not.toMatch(/'auditor', 'usuarios\.usuario\./);
    expect(/ON\s+CONFLICT[\s\S]{0,80}DO\s+UPDATE/i.test(SIN_COMENTARIOS)).toBe(false);
    expect((SIN_COMENTARIOS.match(/DO NOTHING/g) ?? []).length).toBe(3);
    // Ninguna línea que empiece por «('» es otra cosa que una tupla de siembra (lector de la 0179).
    expect(tuplas).toHaveLength(7);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

describe.skipIf(!URL_BASE)('0185 — contra la base real (constraints, ACL, retención, siembra e idempotencia)', () => {
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

  /** Un INSERT mínimo válido: titular = el primer admin, actor = el mismo. Devuelve el error, si lo hay. */
  async function insertar(tx: postgres.TransactionSql, extra: Record<string, unknown>): Promise<{ code?: string } | null> {
    const [admin] = await tx`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`;
    const fila = {
      lote_id: '00000000-0000-4000-8000-000000000185', entidad: 'usuario', accion: 'editar', campo: 'role',
      valor_antes: 'a', valor_despues: 'b', usuario_afectado_id: admin!.id, usuario_afectado_rol: 'admin',
      rol_afectado_codigo: null, actor_user_id: admin!.id, actor_email: 'prueba@0185', actor_rol: 'admin', origen: 'usuario',
      ...extra,
    };
    // En un SAVEPOINT: un INSERT rechazado no aborta la transacción entera y el siguiente caso sigue.
    try {
      await tx.savepoint(async (sp) => { await sp`INSERT INTO permisos_auditoria ${sp(fila)}`; });
      return null;
    } catch (e) { return e as { code?: string }; }
  }

  it('(a) la tabla existe con las columnas del modelo, en orden', async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'permisos_auditoria' ORDER BY ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(getTableConfig(permisosAuditoria).columns.map((c) => c.name));
  });

  it('(a) las dos FK hacia users son RESTRICT en borrado y en actualización (mutación 4)', async () => {
    const fks = await sql`
      SELECT conname, confdeltype, confupdtype FROM pg_constraint
       WHERE conrelid = 'permisos_auditoria'::regclass AND contype = 'f' ORDER BY conname`;
    expect(fks.map((f) => f.conname)).toEqual(['permisos_auditoria_actor_user_id_fkey', 'permisos_auditoria_usuario_afectado_id_fkey']);
    for (const f of fks) { expect(f.confdeltype).toBe('r'); expect(f.confupdtype).toBe('r'); }
  });

  it('(a) los nueve CHECK existen con su nombre', async () => {
    const chks = await sql`SELECT conname FROM pg_constraint WHERE conrelid = 'permisos_auditoria'::regclass AND contype = 'c' ORDER BY conname`;
    expect(chks.map((c) => c.conname)).toEqual([...CHECKS].sort());
  });

  it('(a) un INSERT válido entra; `campo = email` (PII), `password` con valor, sujeto doble y actor incoherente se rechazan con 23514', async () => {
    const r = await enTx(async (tx) => ({
      valido: await insertar(tx, {}),
      email: await insertar(tx, { campo: 'email' }),
      passwordConValor: await insertar(tx, { campo: 'password', valor_antes: null, valor_despues: '$argon2id$x' }),
      passwordSinValor: await insertar(tx, { campo: 'password', valor_antes: null, valor_despues: null }),
      dosSujetos: await insertar(tx, { rol_afectado_codigo: 'admin' }),
      sinCampo: await insertar(tx, { campo: null }),
      borrarSinCampo: await insertar(tx, { entidad: 'rol', accion: 'borrar', campo: null, usuario_afectado_id: null, usuario_afectado_rol: null, rol_afectado_codigo: 'x' }),
      sistemaConActor: await insertar(tx, { origen: 'sistema' }),
      titularSinRol: await insertar(tx, { usuario_afectado_rol: null }),
    }));
    expect(r.valido).toBeNull();
    expect(r.passwordSinValor).toBeNull();
    expect(r.borrarSinCampo).toBeNull();
    for (const k of ['email', 'passwordConValor', 'dosSujetos', 'sinCampo', 'sistemaConActor', 'titularSinRol'] as const) {
      expect(r[k]?.code, k).toBe('23514');
    }
  });

  it('(a) la ACL de operaciones_app no tiene UPDATE, DELETE ni TRUNCATE; sí SELECT e INSERT (inmutable por REVOKE, no por disparador)', async () => {
    // Se lee la ACL y no `has_table_privilege`: en local `operaciones_app` puede ser superusuario y
    // entonces el DML no se le niega, pero la ACL sí dice lo que la migración dejó.
    const [t] = await sql`SELECT relacl::text AS acl FROM pg_class WHERE relname = 'permisos_auditoria'`;
    const entrada = (t!.acl as string).split(',').map((s) => s.replace(/[{}]/g, '')).find((s) => s.startsWith('operaciones_app='));
    expect(entrada).toBeDefined();
    const privs = entrada!.split('=')[1]!.split('/')[0]!;
    expect(privs).toContain('a'); // INSERT
    expect(privs).toContain('r'); // SELECT
    expect(privs).not.toMatch(/[wdD]/); // UPDATE, DELETE, TRUNCATE
    const trg = await sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'permisos_auditoria'::regclass AND NOT tgisinternal`;
    expect(trg).toHaveLength(0);
  });

  it('(a) la política de retención quedó declarada: 6 años, archivar_offline', async () => {
    const [p] = await sql`SELECT retencion_anios, accion, habilitado FROM pesv_retencion_politicas WHERE tipo_documento = 'permisos_auditoria'`;
    expect(p).toMatchObject({ retencion_anios: 6, accion: 'archivar_offline', habilitado: true });
  });

  it('(b) la siembra: las dos funciones existen y el reparto es admin + auditor; el auditor tiene pagina.users y NO listar/ver_resumen', async () => {
    const funciones = await sql`SELECT codigo FROM permisos_funciones WHERE codigo LIKE 'usuarios.auditoria.%' ORDER BY codigo`;
    expect(funciones.map((f) => f.codigo)).toEqual(['usuarios.auditoria.filtrar', 'usuarios.auditoria.ver']);
    const reparto = await sql`
      SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion
       WHERE funcion_codigo LIKE 'usuarios.auditoria.%' OR (rol_codigo = 'auditor' AND funcion_codigo = 'pagina.users')
       ORDER BY rol_codigo, funcion_codigo`;
    expect(reparto.map((r) => `${r.rol_codigo}|${r.funcion_codigo}`)).toEqual([
      'admin|usuarios.auditoria.filtrar', 'admin|usuarios.auditoria.ver',
      'auditor|pagina.users', 'auditor|usuarios.auditoria.filtrar', 'auditor|usuarios.auditoria.ver',
    ]);
    const censo = await sql`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE rol_codigo = 'auditor' AND funcion_codigo IN ('usuarios.usuario.listar', 'usuarios.usuario.ver_resumen')`;
    expect(censo[0]!.n).toBe(0);
  });

  it('(c) idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila', async () => {
    const { antes, despues } = await enTx(async (tx) => {
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(codigo||nombre_negocio||descripcion||tipo, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
          (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS r,
          (SELECT md5(string_agg(tipo_documento||retencion_anios::text||accion::text||coalesce(created_by::text,'-'), ',' ORDER BY tipo_documento)) FROM pesv_retencion_politicas) AS p,
          (SELECT md5(string_agg(id::text||role||coalesce(session_invalidated_at::text,'-'), ',' ORDER BY id)) FROM users) AS u,
          (SELECT count(*)::int FROM permisos_auditoria) AS n
      `)[0];
      const a = await huella();
      await tx.unsafe(SQL_0185);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
