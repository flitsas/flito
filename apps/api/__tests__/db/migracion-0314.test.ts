// HU #14355 (Feature F5 #14327, ADR-0039 §5.2, E2) — la 0314 retira la sincronización y las columnas duplicadas de los
// perfiles de proveedor (AC3, AC4, AC5, AC6, AC8).
//
// Estática (siempre) + contra PostgreSQL solo con TEST_DATABASE_URL, todo en una transacción con ROLLBACK: la base local
// la comparten otras sesiones. Cada test aplica la 0314 dentro de su transacción, así que vale igual sobre una base que
// todavía no la tiene que sobre una ya contraída (la segunda aplicación no hace nada, AC8).
//
// AC3 reproduce el runner (`src/scripts/db-apply.ts`): el archivo y el INSERT al ledger en la misma transacción, aquí un
// SAVEPOINT. Sobre una base ya contraída la columna vieja se restaura dentro de la transacción para poder desalinearla.
//
// Mutantes que mata: quitar la guarda o una de sus comparaciones, de SOAT o de Logística, o la normalización del NIT
// (`NULLIF(btrim(...), '')`) (AC3 no fallaría o contaría espacios/vacío como diferencia); dejar un trigger o una función de
// transición (AC4); dejar una columna vieja o retirar la configuración de SOAT (AC5); no recrear `users_ambito_trg`
// (AC6: el rol de proveedor sin proveedor entraría); poner un valor en el mensaje de la guarda (AC3, PII).
process.env.TZ = 'UTC';

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0314_flito_proveedores_contraccion.sql';
const SQL = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

const TRIGGERS_RETIRADOS = [
  'perfil_crea_padre', 'perfil_a_padre', 'padre_a_perfil', 'perfil_borrado', 'perfil_espejo_baja', 'users_proveedor_sync',
] as const;
const FUNCIONES_RETIRADAS = [
  'flito_proveedor_perfil_crea_padre', 'flito_proveedor_perfil_a_padre', 'flito_proveedor_padre_a_perfil',
  'flito_proveedor_perfil_borrado', 'flito_proveedor_perfil_espejo_baja', 'flito_proveedor_restriccion_del_perfil',
  'users_proveedor_sincroniza',
] as const;
const TABLAS = ['flito_proveedores', 'flito_proveedores_soat', 'flito_proveedores_logistica', 'users'] as const;

describe('0314 — reglas del archivo (estática)', () => {
  it('sin control de transacción propio, con lock_timeout y bloqueo exclusivo de las cuatro tablas', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/SET LOCAL lock_timeout = '30s';/);
    expect(SIN_COMENTARIOS).toMatch(
      /LOCK TABLE flito_proveedores, flito_proveedores_soat, flito_proveedores_logistica, users IN ACCESS EXCLUSIVE MODE;/,
    );
  });

  it('AC3: la guarda va antes de cualquier DROP y su mensaje solo interpola ids y nombres de campo', () => {
    const guarda = SIN_COMENTARIOS.indexOf('RAISE EXCEPTION');
    expect(guarda).toBeGreaterThan(0);
    expect(guarda).toBeLessThan(SIN_COMENTARIOS.search(/\bDROP\b/));
    // Los `format` de los casos solo reciben origen, id, lista de campos o el id del usuario: ninguna columna de datos.
    const formatos = [...SIN_COMENTARIOS.matchAll(/casos := casos \|\| format\([^;]*\);/g)].map((m) => m[0]);
    expect(formatos).toHaveLength(2);
    for (const f of formatos) expect(f).not.toMatch(/\.(nombre|nit|contacto|telefono)\b|->>/);
  });

  it('AC4/AC5: todo DROP es IF EXISTS y ninguno lleva CASCADE', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\bCASCADE\b/i);
    const drops = [...SIN_COMENTARIOS.matchAll(/\bDROP (TRIGGER|FUNCTION|INDEX|COLUMN)\b(?! IF EXISTS)/g)];
    expect(drops).toEqual([]);
  });

  it('AC5: SOAT conserva estrategia, umbral_ocr y sla_horas; la auditoría de permisos no se toca', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/flito_proveedores_soat DROP COLUMN IF EXISTS (estrategia|umbral_ocr|sla_horas)/);
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_auditoria/);
  });

  it('AC6: users_ambito_trg se recrea sin la columna vieja y con la misma función', () => {
    expect(SIN_COMENTARIOS).toMatch(new RegExp(
      'DROP TRIGGER IF EXISTS users_ambito_trg ON users;\\s*CREATE CONSTRAINT TRIGGER users_ambito_trg\\s*'
      + 'AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_id ON users\\s*DEFERRABLE INITIALLY IMMEDIATE\\s*'
      + 'FOR EACH ROW EXECUTE FUNCTION users_ambito_requerido\\(\\);',
    ));
  });
});

type Tx = postgres.TransactionSql;
const sufijo = () => randomUUID().slice(0, 8);

/** Lo que la 0314 cambia, para comparar dos aplicaciones (AC8). */
async function catalogo(tx: Tx) {
  return tx`
    SELECT 'col' AS k, table_name || '.' || column_name AS v FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY(${TABLAS as unknown as string[]})
    UNION ALL
    SELECT 'trg', t.tgrelid::regclass::text || ' ' || pg_get_triggerdef(t.oid) FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgrelid::regclass::text = ANY(${TABLAS as unknown as string[]})
    UNION ALL
    SELECT 'idx', indexrelid::regclass::text FROM pg_index WHERE indrelid::regclass::text = ANY(${TABLAS as unknown as string[]})
    UNION ALL
    SELECT 'fn', p.proname || ':' || md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(${[...FUNCIONES_RETIRADAS, 'users_ambito_requerido']})
    ORDER BY 1, 2`;
}

const columnas = async (tx: Tx, tabla: string) =>
  (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tabla}
             ORDER BY column_name`).map((f) => f.column_name as string);

async function crearProveedorSoat(tx: Tx) {
  const nombre = `Prov 0314 ${sufijo()}`;
  const [p] = await tx`INSERT INTO flito_proveedores (nombre) VALUES (${nombre}) RETURNING id`;
  const id = p!.id as string;
  // Antes de la 0314 `perfil_crea_padre` copia el espejo del padre; después el perfil solo lleva su id.
  await tx`INSERT INTO flito_proveedores_soat (id, estrategia) VALUES (${id}, 'portal')`;
  return { id, nombre };
}

async function crearProveedorLogistica(tx: Tx) {
  const nombre = `ProvLog 0314 ${sufijo()}`;
  const nit = `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;
  const [p] = await tx`INSERT INTO flito_proveedores (nombre, nit, contacto, telefono)
    VALUES (${nombre}, ${nit}, ${'Contacto 0314'}, ${'3001234567'}) RETURNING id`;
  const id = p!.id as string;
  await tx`INSERT INTO flito_proveedores_logistica (id) VALUES (${id})`;
  return { id, nombre, nit };
}

/**
 * Estado previo a la 0314 en Logística: las columnas viejas existen (tipos de la 0102/0278; `nombre` admite NULL porque
 * la tabla ya tiene filas y la guarda solo la lee vía `to_jsonb`) y el espejo coincide con el padre en todas las filas.
 */
async function restaurarEspejoLogistica(tx: Tx) {
  await tx.unsafe('ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS nombre varchar(150)');
  await tx.unsafe('ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true');
  await tx.unsafe('ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS nit varchar(20)');
  await tx.unsafe('ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS contacto varchar(150)');
  await tx.unsafe('ALTER TABLE flito_proveedores_logistica ADD COLUMN IF NOT EXISTS telefono varchar(30)');
  for (const t of ['flito_proveedores', 'flito_proveedores_logistica']) await tx.unsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  await tx`UPDATE flito_proveedores_logistica l SET nombre = p.nombre, activo = p.activo, nit = p.nit, contacto = p.contacto,
             telefono = p.telefono FROM flito_proveedores p WHERE p.id = l.id`;
}

/** El runner: archivo + INSERT al ledger en la misma transacción (aquí, un SAVEPOINT). Devuelve el error. */
async function aplicarComoElRunner(tx: Tx, marca: string): Promise<Error> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(SQL);
      await sp`INSERT INTO _kyverum_applied_migrations (filename, sha256) VALUES (${ARCHIVO}, ${marca})
               ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`;
    });
  } catch (e) { return e as Error; }
  throw new Error('la 0314 debía detenerse');
}

describe.skipIf(!URL_BASE)('0314 — contra PostgreSQL (tx con ROLLBACK)', () => {
  const conLa0314 = async (fn: (tx: Tx) => Promise<void>) => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => { await tx.unsafe(SQL); await fn(tx); });
    } finally { await sql.end(); }
  };

  it('AC3: un perfil que difiere de su padre detiene la migración antes de eliminar nada y no la registra', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const a = await crearProveedorSoat(tx);
        const b = await crearProveedorSoat(tx);
        // Estado previo a la 0314: la columna vieja existe y el espejo coincide con el padre en todo lo demás.
        await tx.unsafe('ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS nombre varchar(150)');
        await tx.unsafe('ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS activo boolean');
        await tx.unsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS flito_proveedor_soat_id uuid');
        for (const t of ['flito_proveedores_soat', 'users']) await tx.unsafe(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        await tx`UPDATE flito_proveedores_soat s SET nombre = p.nombre, activo = p.activo FROM flito_proveedores p WHERE p.id = s.id`;
        await tx`UPDATE users SET flito_proveedor_soat_id = flito_proveedor_id`;
        const marca = `prueba-ac3-${sufijo()}`;
        const valor = `Desalineado ${sufijo()}`;

        // Caso 1: el nombre del perfil difiere del padre.
        await tx`UPDATE flito_proveedores_soat SET nombre = ${valor} WHERE id = ${a.id}`;
        const e1 = await aplicarComoElRunner(tx, marca);
        expect(e1.message).toMatch(/^0314 detenida: \d+ caso\(s\)/);
        expect(e1.message).toContain(`PERFIL DISTINTO: SOAT ${a.id} difiere de su proveedor padre en: nombre.`);
        expect(e1.message).toContain('flito-proveedores-contraccion-preflight.sql');
        expect(e1.message).not.toContain(valor); // solo UUIDs y nombres de campo, nunca valores
        await tx`UPDATE flito_proveedores_soat SET nombre = ${a.nombre} WHERE id = ${a.id}`;

        // Caso 2: un perfil vigente con el padre de baja.
        await tx`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${b.id}`;
        expect((await aplicarComoElRunner(tx, marca)).message)
          .toContain(`PERFIL DISTINTO: SOAT ${b.id} difiere de su proveedor padre en: padre de baja.`);
        await tx`UPDATE flito_proveedores SET deleted_at = NULL WHERE id = ${b.id}`;

        // Caso 3: un usuario con la pertenencia vieja distinta de la nueva.
        const [u] = await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id, flito_proveedor_soat_id)
          VALUES (${`u0314_${sufijo()}`}, 'Usuario 0314', 'h', 'admin', ${a.id}, ${b.id}) RETURNING id`;
        expect((await aplicarComoElRunner(tx, marca)).message)
          .toContain(`USUARIO DISTINTO: el usuario ${u!.id} tiene flito_proveedor_soat_id distinto de flito_proveedor_id.`);

        // Nada se eliminó ni quedó registrado.
        expect(await columnas(tx, 'flito_proveedores_soat')).toContain('nombre');
        expect(await columnas(tx, 'users')).toContain('flito_proveedor_soat_id');
        expect(await tx`SELECT 1 FROM _kyverum_applied_migrations WHERE sha256 = ${marca}`).toHaveLength(0);
      });
    } finally { await sql.end(); }
  });

  it('AC3 (Logística): un NIT, contacto o teléfono distinto detiene la migración; espacios o vacío contra NULL no cuentan', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const a = await crearProveedorLogistica(tx);
        const b = await crearProveedorLogistica(tx);
        await restaurarEspejoLogistica(tx);
        const marca = `prueba-ac3-log-${sufijo()}`;
        const nitAjeno = `8${String(Date.now()).slice(-8)}7`;

        // Caso 1: solo el NIT del perfil difiere del padre.
        await tx`UPDATE flito_proveedores_logistica SET nit = ${nitAjeno} WHERE id = ${a.id}`;
        const e1 = await aplicarComoElRunner(tx, marca);
        expect(e1.message).toMatch(/^0314 detenida: \d+ caso\(s\)/);
        expect(e1.message).toContain(`PERFIL DISTINTO: Logística ${a.id} difiere de su proveedor padre en: nit.`);
        expect(e1.message).not.toContain(nitAjeno); // solo UUIDs y nombres de campo, nunca valores
        expect(e1.message).not.toContain(a.nit);

        // Caso 2: el mismo NIT con espacios alrededor no es diferencia; contacto y teléfono de otro perfil sí.
        await tx`UPDATE flito_proveedores_logistica SET nit = ${`  ${a.nit}  `} WHERE id = ${a.id}`;
        await tx`UPDATE flito_proveedores_logistica SET contacto = 'Otro contacto', telefono = '3109999999' WHERE id = ${b.id}`;
        const e2 = await aplicarComoElRunner(tx, marca);
        expect(e2.message).toMatch(/^0314 detenida: \d+ caso\(s\)/);
        expect(e2.message).toContain(`PERFIL DISTINTO: Logística ${b.id} difiere de su proveedor padre en: contacto, telefono.`);
        expect(e2.message).not.toContain(`Logística ${a.id}`);

        // Caso 3: NIT vacío en el perfil contra NULL en el padre tampoco es diferencia.
        await tx`UPDATE flito_proveedores SET nit = NULL WHERE id = ${a.id}`;
        await tx`UPDATE flito_proveedores_logistica SET nit = '' WHERE id = ${a.id}`;
        const e3 = await aplicarComoElRunner(tx, marca);
        expect(e3.message).toMatch(/^0314 detenida: \d+ caso\(s\)/);
        expect(e3.message).not.toContain(`Logística ${a.id}`);

        expect(await columnas(tx, 'flito_proveedores_logistica')).toContain('nit');
        expect(await tx`SELECT 1 FROM _kyverum_applied_migrations WHERE sha256 = ${marca}`).toHaveLength(0);
      });
    } finally { await sql.end(); }
  });

  it('AC3 (SOAT): un perfil con activo distinto del padre detiene la migración', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const a = await crearProveedorSoat(tx);
        await tx.unsafe('ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS nombre varchar(150)');
        await tx.unsafe('ALTER TABLE flito_proveedores_soat ADD COLUMN IF NOT EXISTS activo boolean');
        await tx.unsafe('ALTER TABLE flito_proveedores_soat DISABLE TRIGGER USER');
        await tx`UPDATE flito_proveedores_soat s SET nombre = p.nombre, activo = p.activo FROM flito_proveedores p WHERE p.id = s.id`;
        await tx`UPDATE flito_proveedores_soat SET activo = NOT activo WHERE id = ${a.id}`;

        const e = await aplicarComoElRunner(tx, `prueba-ac3-activo-${sufijo()}`);
        expect(e.message).toMatch(/^0314 detenida: \d+ caso\(s\)/);
        expect(e.message).toContain(`PERFIL DISTINTO: SOAT ${a.id} difiere de su proveedor padre en: activo.`);
      });
    } finally { await sql.end(); }
  });

  it('AC4: ya no existen los triggers ni las funciones de sincronización', async () => {
    await conLa0314(async (tx) => {
      const triggers = await tx`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
        AND tgname = ANY(${TRIGGERS_RETIRADOS as unknown as string[]})`;
      expect(triggers).toEqual([]);
      const funciones = await tx`SELECT proname FROM pg_proc WHERE proname = ANY(${FUNCIONES_RETIRADAS as unknown as string[]})`;
      expect(funciones).toEqual([]);
    });
  });

  it('AC5: los perfiles y users ya no tienen las columnas viejas; SOAT conserva su configuración', async () => {
    await conLa0314(async (tx) => {
      const soat = await columnas(tx, 'flito_proveedores_soat');
      expect(soat).toEqual(expect.arrayContaining(['estrategia', 'umbral_ocr', 'sla_horas', 'id', 'deleted_at']));
      expect(soat).not.toContain('nombre');
      expect(soat).not.toContain('activo');
      const logistica = await columnas(tx, 'flito_proveedores_logistica');
      for (const c of ['nombre', 'estrategia', 'activo', 'nit', 'contacto', 'telefono']) expect(logistica).not.toContain(c);
      const usuarios = await columnas(tx, 'users');
      expect(usuarios).not.toContain('flito_proveedor_soat_id');
      expect(usuarios).toContain('flito_proveedor_id');
      const indices = await tx`SELECT 1 FROM pg_class WHERE relname IN ('idx_users_flito_proveedor_soat',
        'uq_flito_proveedores_soat_nombre_vivo', 'uq_flito_proveedores_logistica_nombre_vivo', 'uq_flito_proveedores_logistica_nit')`;
      expect(indices).toEqual([]);
    });
  });

  it('AC6: un usuario con rol de enlace proveedor y sin flito_proveedor_id lo sigue rechazando la BD con el mismo error', async () => {
    await conLa0314(async (tx) => {
      const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE tipo_enlace = 'proveedor' ORDER BY codigo LIMIT 1`;
      expect(rol).toBeDefined();
      const [def] = await tx`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'users_ambito_trg'`;
      expect(def!.d).toMatch(/AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_id ON public\.users/);

      const username = `u0314_${sufijo()}`;
      const alta = tx.savepoint((sp) => sp`INSERT INTO users (username, name, password_hash, role)
        VALUES (${username}, 'Sin proveedor', 'h', ${rol!.codigo})`);
      await expect(alta).rejects.toMatchObject({
        code: '23514', message: expect.stringMatching(new RegExp(`^El rol ${rol!.codigo} exige proveedor SOAT y el usuario \\d+ no lo tiene$`)),
      });

      // Quitarle el proveedor a uno que lo tiene: el trigger sigue mirando `flito_proveedor_id` en el UPDATE.
      const p = await crearProveedorSoat(tx);
      const [u] = await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id)
        VALUES (${username}, 'Con proveedor', 'h', ${rol!.codigo}, ${p.id}) RETURNING id`;
      await expect(tx.savepoint((sp) => sp`UPDATE users SET flito_proveedor_id = NULL WHERE id = ${u!.id}`))
        .rejects.toMatchObject({ code: '23514' });
    });
  });

  it('AC8: aplicada dos veces, sin error y sin cambios', async () => {
    await conLa0314(async (tx) => {
      const primera = await catalogo(tx);
      await tx.unsafe(SQL);
      expect(await catalogo(tx)).toEqual(primera);
    });
  });
});
