// Feature #14323, HU #14328, #14329 y #14330 — migración 0289 y comprobación previa (ADR-0039 §5).
//
// La parte estática corre siempre. La parte con BD necesita TEST_DATABASE_URL (el CI no levanta Postgres, y sin la
// variable se salta) y lo hace TODO dentro de una transacción que termina en ROLLBACK: la base local queda intacta.
// Exige una base local sin repetidos entre los proveedores que ya tenga, porque aplica el archivo real sobre ella.
//
// Las paradas se ejercen con `tx.savepoint` + `unsafe(archivo)`: es el mismo mecanismo del runner
// (`sql.begin` + `tx.unsafe(content)`), de modo que un error deshace el archivo entero.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { SERVICIOS_PROVEEDOR, SERVICIO_DE_MODULO } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import * as schema from '../../src/db/schema.js';
import { URL_BASE, enTx } from '../helpers/base-en-tx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const ARCHIVO = '0289_flito_proveedores_padre.sql';
const MIGRACION = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const PREFLIGHT = readFileSync(path.resolve(__dirname, '../../src/db/manual/flito-proveedores-preflight.sql'), 'utf8');
const SEED = readFileSync(path.resolve(__dirname, '../../src/scripts/flito-seed.ts'), 'utf8');
const SIN_COMENTARIOS = MIGRACION.replace(/--[^\n]*/g, '');

const entre = (texto: string, abre: string, cierra: string): string => {
  const a = texto.indexOf(abre);
  const b = texto.indexOf(cierra);
  expect(a, abre).toBeGreaterThanOrEqual(0);
  expect(b, cierra).toBeGreaterThan(a);
  return texto.slice(a, b);
};

const COMPROBACION_FINAL = entre(MIGRACION, '-- >>> COMPROBACION FINAL', '-- <<< COMPROBACION FINAL');

describe('0289 — análisis estático', () => {
  it('número siguiente y sin control de transacción propio: el runner envuelve el archivo', () => {
    expect(scanForTxControl(ARCHIVO, MIGRACION)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0289_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0288_/);
  });

  it('#14328 AC2: la parada va antes de cualquier tabla, columna, índice, función o trigger', () => {
    const parada = SIN_COMENTARIOS.indexOf('DO $parada$');
    expect(parada).toBeGreaterThan(0);
    for (const ddl of ['CREATE TABLE', 'CREATE UNIQUE INDEX', 'ALTER TABLE', 'CREATE OR REPLACE', 'CREATE TRIGGER', 'INSERT INTO', 'UPDATE users']) {
      expect(SIN_COMENTARIOS.indexOf(ddl), ddl).toBeGreaterThan(parada);
    }
    expect(SIN_COMENTARIOS.slice(0, parada).trim()).toMatch(/^LOCK TABLE [^;]+;$/);
  });

  it('#14328 AC6: las consultas de las paradas son idénticas en la migración y en la comprobación previa', () => {
    const paradas = entre(MIGRACION, '-- >>> PARADAS', '-- <<< PARADAS');
    expect(entre(PREFLIGHT, '-- >>> PARADAS', '-- <<< PARADAS')).toBe(paradas);
    expect(paradas).toContain('NOMBRE REPETIDO');
    expect(paradas).toContain('NIT REPETIDO');
    expect(paradas).toContain('IDENTIFICADOR REPETIDO');
  });

  it('#14328 AC3: las paradas no seleccionan el NIT para mostrarlo', () => {
    const paradas = entre(MIGRACION, '-- >>> PARADAS', '-- <<< PARADAS').replace(/--[^\n]*/g, '');
    expect(paradas).not.toMatch(/format\([^)]*\.nit\b/);
    expect(paradas).not.toMatch(/string_agg\([^)]*\.nit\b/);
    expect(paradas).not.toMatch(/\bl\.nit\s+AS\b/);
  });

  it('#14328 AC6: la comprobación previa fija la transacción en solo lectura y no crea ni escribe nada', () => {
    const sin = PREFLIGHT.replace(/--[^\n]*/g, '');
    expect(sin).toContain("set_config('transaction_read_only', 'on', true)");
    expect(sin).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT)\b/);
  });

  it('#14328: el mensaje de la parada dirige a la comprobación previa', () => {
    expect(SIN_COMENTARIOS).toContain('Ejecute apps/api/src/db/manual/flito-proveedores-preflight.sql, corrija los datos');
  });

  it('#14329 AC7: sin RENAME, DROP de columna o tabla, ni NOT NULL sobre tablas existentes', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\bRENAME\b/);
    expect(SIN_COMENTARIOS).not.toMatch(/DROP\s+(COLUMN|TABLE|CONSTRAINT|VIEW|INDEX|FUNCTION)/i);
    expect(SIN_COMENTARIOS).not.toMatch(/SET\s+NOT\s+NULL/i);
    expect(SIN_COMENTARIOS.match(/DROP\s+\w+/gi)!.every((d) => /^DROP\s+TRIGGER$/i.test(d))).toBe(true);
    for (const a of SIN_COMENTARIOS.match(/ADD COLUMN[^;]+;/g)!) expect(a).not.toMatch(/NOT NULL/);
  });

  it('#14329 AC2: SERVICIOS_PROVEEDOR es la lista y coincide con los literales de la vista; sin tabla de catálogo', () => {
    expect(SERVICIOS_PROVEEDOR).toEqual(['soat', 'logistica']);
    expect(SERVICIO_DE_MODULO).toEqual({ soat: 'soat', logistica: 'logistica' });
    const vista = /CREATE OR REPLACE VIEW flito_proveedor_servicios_v AS[\s\S]*?;/.exec(SIN_COMENTARIOS)![0];
    expect([...vista.matchAll(/'(\w+)'::text/g)].map((m) => m[1])).toEqual([...SERVICIOS_PROVEEDOR]);
    expect([...SIN_COMENTARIOS.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]))
      .toEqual(['flito_proveedores', 'flito_proveedores_auditoria']);
  });

  it('#14329 AC8: el seed no depende de ON CONFLICT en el perfil, que no alcanza al padre', () => {
    expect(SEED).not.toMatch(/insert\(flitoProveedoresLogistica\)[\s\S]{0,200}onConflictDoNothing/);
  });

  it('Drizzle declara el padre, la auditoría y las columnas nuevas, todas opcionales sobre lo existente', () => {
    const padre = getTableColumns(schema.flitoProveedores);
    expect(padre.nit.notNull).toBe(false);
    expect(padre.deletedAt.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresAuditoria).proveedorId.notNull).toBe(true);
    expect(getTableColumns(schema.users).flitoProveedorId.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresLogistica).deletedAt.notNull).toBe(false);
    expect(getTableColumns(schema.flitoProveedoresLogistica).deletedBy.notNull).toBe(false);
  });
});

const conBd = URL_BASE ? describe : describe.skip;

conBd('0289 — contra PostgreSQL, en transacción revertida', () => {
  const avisos: string[] = [];
  let sql: postgres.Sql;
  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: (n) => { avisos.push(String(n.message)); } }); });
  afterAll(async () => { await sql.end(); });

  type Tx = postgres.TransactionSql;
  const DESHACER = Symbol('deshacer');

  /** Corre `fn` en un savepoint y lo deshace siempre; así la transacción sigue utilizable. */
  async function yDeshacer(tx: Tx, fn: (sp: Tx) => Promise<void>): Promise<void> {
    try { await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); throw DESHACER; }); } catch (e) { if (e !== DESHACER) throw e; }
  }
  const aplicar = (tx: Tx) => tx.unsafe(MIGRACION);

  /** Aplica el archivo esperando la parada; devuelve el mensaje. El savepoint deshace como el runner. */
  async function parada(tx: Tx): Promise<string> {
    let mensaje = '';
    try { await tx.savepoint(async (sp) => { await sp.unsafe(MIGRACION); }); } catch (e) { mensaje = (e as Error).message; }
    expect(mensaje, 'la migración debía detenerse').not.toBe('');
    return mensaje;
  }

  /** Corre la comprobación previa y devuelve sus avisos, unidos. */
  async function preflight(tx: Tx): Promise<string> {
    avisos.length = 0;
    await yDeshacer(tx, async (sp) => { await sp.unsafe(PREFLIGHT); });
    return avisos.join('\n');
  }

  const soat = async (tx: Tx, nombre: string, extra: { activo?: boolean; borrado?: boolean } = {}) =>
    (await tx`INSERT INTO flito_proveedores_soat (nombre, activo, deleted_at)
      VALUES (${nombre}, ${extra.activo ?? true}, ${extra.borrado ? tx`now()` : null}) RETURNING id`)[0]!.id as string;
  const logistica = async (tx: Tx, nombre: string, nit: string | null = null) =>
    (await tx`INSERT INTO flito_proveedores_logistica (nombre, nit) VALUES (${nombre}, ${nit}) RETURNING id`)[0]!.id as string;
  const padre = async (tx: Tx, id: string) => (await tx`SELECT * FROM flito_proveedores WHERE id = ${id}`)[0];
  const nuevoUsuario = async (tx: Tx, n: string, proveedorId: string) =>
    (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id)
      VALUES (${`hu14330-${n}`}, ${`HU14330 ${n}`}, 'x', 'proveedor', ${proveedorId}) RETURNING id`)[0]!.id as number;
  const columnasUsuario = async (tx: Tx, id: number) =>
    (await tx`SELECT flito_proveedor_id AS nueva, flito_proveedor_soat_id AS vieja FROM users WHERE id = ${id}`)[0]!;
  const codigoDe = async (tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<string> => {
    let codigo = '';
    try { await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); }); } catch (e) { codigo = (e as { code: string }).code; }
    return codigo;
  };
  const conteos = async (tx: Tx) => (await tx`SELECT
    (SELECT count(*) FROM flito_proveedores)::int AS padres,
    (SELECT count(*) FROM flito_proveedores_soat)::int AS soat,
    (SELECT count(*) FROM flito_proveedores_logistica)::int AS logistica,
    (SELECT count(*) FROM users WHERE flito_proveedor_id IS NOT NULL)::int AS usuarios`)[0]!;

  describe('#14328 — paradas y comprobación previa', () => {
    it('AC1: sin repetidos, la comprobación previa no lista casos y la migración sigue', async () => {
      await enTx(sql, async (tx) => {
        expect(await preflight(tx)).toContain('sin casos');
        await aplicar(tx);
        expect((await tx`SELECT to_regclass('flito_proveedores') IS NOT NULL AS hay`)[0]!.hay).toBe(true);
      });
    });

    it('AC2: nombre repetido entre SOAT y Logística detiene, lista nombre e ids, y no deja nada', async () => {
      await enTx(sql, async (tx) => {
        const a = await soat(tx, 'HU14328 Cruzado');
        const b = await logistica(tx, '  hu14328   CRUZADO ');
        const m = await parada(tx);
        expect(m).toContain('NOMBRE REPETIDO');
        expect(m).toContain(a);
        expect(m).toContain(b);
        expect((await tx`SELECT to_regclass('flito_proveedores') IS NULL AS sin_padre,
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'flito_proveedor_id') AS con_columna`)[0])
          .toEqual({ sin_padre: true, con_columna: false });
        expect((await tx`SELECT nombre FROM flito_proveedores_logistica WHERE id = ${b}`)[0]!.nombre).toBe('  hu14328   CRUZADO ');
      });
    });

    it('un fallo DESPUÉS de los pasos con DDL tampoco deja nada: la transacción abarca el archivo', async () => {
      await enTx(sql, async (tx) => {
        await expect(tx.savepoint(async (sp) => { await sp.unsafe(`${MIGRACION}\nSELECT 1/0;`); })).rejects.toThrow(/division by zero/);
        const [f] = await tx`SELECT to_regclass('flito_proveedores') AS padre, to_regclass('flito_proveedor_servicios_v') AS vista,
          (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'users_proveedor_sync') AS trg,
          (SELECT prosrc LIKE '%flito_proveedor_soat_id IS NULL%' FROM pg_proc WHERE proname = 'users_ambito_requerido') AS funcion_anterior`;
        expect(f).toEqual({ padre: null, vista: null, trg: 0, funcion_anterior: true });
      });
    });

    it('AC3: NIT repetido con y sin dígito de verificación se reporta sin el valor', async () => {
      await enTx(sql, async (tx) => {
        const a = await logistica(tx, 'HU14328 Nit A', '900123456');
        const b = await logistica(tx, 'HU14328 Nit B', '900123456-7');
        for (const salida of [await parada(tx), await preflight(tx)]) {
          expect(salida).toContain('NIT REPETIDO');
          expect(salida).toContain('HU14328 Nit A');
          expect(salida).toContain(a);
          expect(salida).toContain(b);
          expect(salida).not.toContain('900123456');
        }
      });
    });

    it('AC4: un solo error lista los tres casos', async () => {
      await enTx(sql, async (tx) => {
        await soat(tx, 'HU14328 Doble');
        await logistica(tx, 'hu14328 doble');
        await logistica(tx, 'HU14328 N1', '900111222');
        await logistica(tx, 'HU14328 N2', '900111222-3');
        const id = await logistica(tx, 'HU14328 Mismo id');
        await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${id}, 'HU14328 Mismo id S')`;
        const m = await parada(tx);
        expect(m).toContain('3 caso(s)');
        for (const caso of ['NOMBRE REPETIDO', 'NIT REPETIDO', 'IDENTIFICADOR REPETIDO']) expect(m).toContain(caso);
        expect(m).toContain(id);
      });
    });

    it('AC5: SOAT eliminado y NIT vacío no detienen; el NIT vacío queda sin valor', async () => {
      await enTx(sql, async (tx) => {
        await soat(tx, 'HU14328 Liberado', { borrado: true });
        const l = await logistica(tx, 'HU14328 Liberado', '   ');
        await aplicar(tx);
        expect((await padre(tx, l))!.nit).toBeNull();
      });
    });

    it('AC5: un SOAT inactivo con nombre repetido sí detiene', async () => {
      await enTx(sql, async (tx) => {
        await soat(tx, 'HU14328 Inactivo', { activo: false });
        await logistica(tx, 'HU14328 Inactivo');
        expect(await parada(tx)).toContain('NOMBRE REPETIDO');
      });
    });

    it('AC6: la comprobación previa lista los mismos casos, no cambia nada y cuenta la estrategia', async () => {
      await enTx(sql, async (tx) => {
        await soat(tx, 'HU14328 Par');
        await logistica(tx, 'hu14328 par');
        await logistica(tx, 'HU14328 PN1', '901222333');
        await logistica(tx, 'HU14328 PN2', '901222333-1');
        const id = await logistica(tx, 'HU14328 Par id');
        await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${id}, 'HU14328 Par id S')`;
        const antes = (await tx`SELECT
          (SELECT count(*)::int FROM pg_class) AS objetos,
          (SELECT count(*)::int FROM flito_proveedores_logistica) AS filas,
          (SELECT count(*)::int FROM flito_proveedores_logistica WHERE estrategia <> 'pwa_propia') AS otras`)[0]!;
        const salida = await preflight(tx);
        const error = await parada(tx);
        const lineas = (t: string) => t.split('\n').filter((x) => x.startsWith('- ')).sort();
        expect(lineas(salida)).toHaveLength(3);
        expect(lineas(salida)).toEqual(lineas(error));
        expect(salida).toContain(`Informativo: ${antes.otras} proveedor(es)`);
        expect((await tx`SELECT
          (SELECT count(*)::int FROM pg_class) AS objetos,
          (SELECT count(*)::int FROM flito_proveedores_logistica) AS filas,
          (SELECT count(*)::int FROM flito_proveedores_logistica WHERE estrategia <> 'pwa_propia') AS otras`)[0]).toEqual(antes);
      });
    });

    it('AC6: Postgres rechaza una escritura después de la comprobación previa', async () => {
      await enTx(sql, async (tx) => {
        await yDeshacer(tx, async (sp) => {
          await sp.unsafe(PREFLIGHT);
          expect(await codigoDe(sp, (s) => s`UPDATE flito_proveedores_logistica SET activo = activo`)).toBe('25006');
        });
      });
    });

    it('AC7: un proveedor con ambos perfiles y padre no se reporta', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const id = await logistica(tx, 'HU14328 Ambos');
        await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${id}, 'HU14328 Ambos')`;
        expect(await preflight(tx)).toContain('sin casos');
        await aplicar(tx);
      });
    });

    it('AC8: renombrar corrige el nombre repetido; quedan dos proveedores separados', async () => {
      await enTx(sql, async (tx) => {
        const a = await soat(tx, 'HU14328 Renombrar');
        const b = await logistica(tx, 'hu14328 renombrar');
        await parada(tx);
        await tx`UPDATE flito_proveedores_logistica SET nombre = 'HU14328 Renombrado' WHERE id = ${b}`;
        await aplicar(tx);
        expect((await padre(tx, a))!.nombre).toBe('HU14328 Renombrar');
        expect((await padre(tx, b))!.nombre).toBe('HU14328 Renombrado');
      });
    });

    it('AC8: con NIT repetido, renombrar no basta; corregir el NIT sí', async () => {
      await enTx(sql, async (tx) => {
        await logistica(tx, 'HU14328 Sigue A', '902333444');
        const b = await logistica(tx, 'HU14328 Sigue B', '902333444-5');
        await parada(tx);
        await tx`UPDATE flito_proveedores_logistica SET nombre = 'HU14328 Otro nombre' WHERE id = ${b}`;
        expect(await parada(tx)).toContain('NIT REPETIDO');
        await tx`UPDATE flito_proveedores_logistica SET nit = '902333445' WHERE id = ${b}`;
        await aplicar(tx);
      });
    });
  });

  describe('#14329 — modelo y copia', () => {
    it('AC1: activos, inactivos y eliminados conservan id, nombre, estado y baja; los vigentes salen en la vista', async () => {
      await enTx(sql, async (tx) => {
        const activo = await soat(tx, 'HU14329 Activo');
        const inactivo = await soat(tx, 'HU14329 Inactivo', { activo: false });
        const borrado = await soat(tx, 'HU14329 Borrado', { borrado: true });
        const log = await logistica(tx, 'HU14329 Log', '903444555');
        const bajaOriginal = (await tx`SELECT deleted_at FROM flito_proveedores_soat WHERE id = ${borrado}`)[0]!.deleted_at;
        await aplicar(tx);
        expect(await padre(tx, activo)).toMatchObject({ nombre: 'HU14329 Activo', activo: true, deleted_at: null });
        expect(await padre(tx, inactivo)).toMatchObject({ activo: false, deleted_at: null });
        expect((await padre(tx, borrado))!.deleted_at).toEqual(bajaOriginal);
        expect(await padre(tx, log)).toMatchObject({ nombre: 'HU14329 Log', nit: '903444555' });
        const vista = await tx`SELECT proveedor_id, servicio FROM flito_proveedor_servicios_v WHERE proveedor_id IN ${tx([activo, inactivo, borrado, log])} ORDER BY servicio`;
        const de = (id: string) => vista.filter((f) => f.proveedor_id === id).map((f) => f.servicio);
        expect(de(activo)).toEqual(['soat']);
        expect(de(inactivo)).toEqual(['soat']);
        expect(de(borrado)).toEqual([]);
        expect(de(log)).toEqual(['logistica']);
      });
    });

    it('AC2: cada proveedor vigente tiene al menos un servicio de la lista', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const sinServicio = await tx`SELECT p.id FROM flito_proveedores p WHERE p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM flito_proveedor_servicios_v v WHERE v.proveedor_id = p.id)`;
        expect(sinServicio).toHaveLength(0);
        const fuera = await tx`SELECT DISTINCT servicio FROM flito_proveedor_servicios_v WHERE servicio <> ALL(${[...SERVICIOS_PROVEEDOR]})`;
        expect(fuera).toHaveLength(0);
      });
    });

    it('AC3: la comprobación final detiene si un perfil queda sin padre', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        await tx.unsafe(COMPROBACION_FINAL);
        await tx.unsafe(`
          ALTER TABLE flito_proveedores_logistica DROP CONSTRAINT flito_proveedores_logistica_id_padre_fk;
          ALTER TABLE flito_proveedores_logistica DISABLE TRIGGER perfil_crea_padre;
          INSERT INTO flito_proveedores_logistica (nombre) VALUES ('HU14329 Huerfano');`);
        await expect(tx.savepoint(async (sp) => { await sp.unsafe(COMPROBACION_FINAL); })).rejects.toThrow(/1 perfil\(es\) sin registro padre/);
      });
    });

    it('AC4: NIT único con y sin dígito, sin NIT conviven, y el de un eliminado queda libre', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const insertar = (s: Tx, nombre: string, nit: string | null) => s`INSERT INTO flito_proveedores (nombre, nit) VALUES (${nombre}, ${nit})`;
        await insertar(tx, 'HU14329 NA', '904555666');
        expect(await codigoDe(tx, (s) => insertar(s, 'HU14329 NB', '904555666'))).toBe('23505');
        expect(await codigoDe(tx, (s) => insertar(s, 'HU14329 NC', '904555666-7'))).toBe('23505');
        await insertar(tx, 'HU14329 SinNit1', null);
        await insertar(tx, 'HU14329 SinNit2', null);
        await tx`UPDATE flito_proveedores SET deleted_at = now() WHERE nombre = 'HU14329 NA'`;
        expect(await codigoDe(tx, (s) => insertar(s, 'HU14329 ND', '904555666'))).toBe('');
      });
    });

    it('AC5: nombre único ante mayúsculas y espacios; el de un eliminado queda libre', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const insertar = (s: Tx, nombre: string) => s`INSERT INTO flito_proveedores (nombre) VALUES (${nombre})`;
        await insertar(tx, 'HU14329 Mensajería Uno');
        expect(await codigoDe(tx, (s) => insertar(s, '  hu14329  MENSAJERÍA   uno '))).toBe('23505');
        await tx`UPDATE flito_proveedores SET deleted_at = now() WHERE nombre = 'HU14329 Mensajería Uno'`;
        expect(await codigoDe(tx, (s) => insertar(s, 'hu14329 mensajería uno'))).toBe('');
      });
    });

    it('AC6 y #14330 AC10: dos aplicaciones dan los mismos conteos y valores, con cada trigger una sola vez', async () => {
      await enTx(sql, async (tx) => {
        const s = await soat(tx, 'HU14329 Dos veces');
        const u = (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id)
          VALUES ('hu14330-dos', 'HU14330 dos', 'x', 'proveedor', ${s}) RETURNING id`)[0]!.id as number;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`; // Como una fila ya confirmada: sin eventos diferidos antes del DDL.
        await aplicar(tx);
        const antes = await conteos(tx);
        const valores = await columnasUsuario(tx, u);
        await aplicar(tx);
        expect(await conteos(tx)).toEqual(antes);
        expect(await columnasUsuario(tx, u)).toEqual(valores);
        const triggers = await tx`SELECT tgname, c.relname, count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname IN ('perfil_crea_padre', 'perfil_a_padre', 'padre_a_perfil', 'perfil_borrado', 'users_proveedor_sync', 'users_ambito_trg')
          GROUP BY 1, 2 ORDER BY 1, 2`;
        expect(triggers.map((t) => `${t.tgname}@${t.relname}:${t.n}`)).toEqual([
          'padre_a_perfil@flito_proveedores:1',
          'perfil_a_padre@flito_proveedores_logistica:1',
          'perfil_a_padre@flito_proveedores_soat:1',
          'perfil_borrado@flito_proveedores_logistica:1',
          'perfil_crea_padre@flito_proveedores_logistica:1',
          'perfil_crea_padre@flito_proveedores_soat:1',
          'users_ambito_trg@users:1',
          'users_proveedor_sync@users:1',
        ]);
      });
    });

    it('AC7: las cinco FK de compañías, SOAT, reglas y actas siguen apuntando a sus perfiles; las columnas viejas se conservan', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const fks = await tx`SELECT c.conrelid::regclass::text AS tabla, a.attname AS columna, c.confrelid::regclass::text AS destino
          FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f' AND c.confrelid IN ('flito_proveedores_soat'::regclass, 'flito_proveedores_logistica'::regclass)
          ORDER BY 1, 2`;
        const lista = fks.map((f) => `${f.tabla}.${f.columna}→${f.destino}`);
        for (const fk of [
          'clients.flito_proveedor_soat_sin_tramite_id→flito_proveedores_soat',
          'clients.flito_proveedor_logistica_id→flito_proveedores_logistica',
          'flito_soat.proveedor_soat_id→flito_proveedores_soat',
          'flito_reglas_proveedor_soat.proveedor_soat_id→flito_proveedores_soat',
          'flito_logistica_actas.proveedor_logistica_id→flito_proveedores_logistica',
        ]) expect(lista).toContain(fk);
        const columnas = await tx`SELECT column_name FROM information_schema.columns WHERE table_name = 'flito_proveedores_logistica'`;
        expect(columnas.map((c) => c.column_name)).toEqual(expect.arrayContaining(['nombre', 'activo', 'nit', 'contacto', 'telefono', 'estrategia', 'deleted_at', 'deleted_by']));
      });
    });

    it('AC8: las altas del seed, con la migración aplicada, tienen padre con el mismo id y su servicio', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const s = await soat(tx, 'HU14329 Seed SOAT');
        const l = await logistica(tx, 'HU14329 Seed Log');
        expect((await padre(tx, s))!.nombre).toBe('HU14329 Seed SOAT');
        expect((await padre(tx, l))!.nombre).toBe('HU14329 Seed Log');
        expect((await tx`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${s}`)[0]!.servicio).toBe('soat');
        expect((await tx`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${l}`)[0]!.servicio).toBe('logistica');
      });
    });
  });

  describe('#14330 — sincronización con la imagen anterior', () => {
    it('AC1: un alta en cualquiera de los perfiles crea el padre con el mismo id', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const s = await soat(tx, 'HU14330 Alta S');
        const l = await logistica(tx, 'HU14330 Alta L', '905666777-1');
        expect(await padre(tx, s)).toMatchObject({ nombre: 'HU14330 Alta S', activo: true });
        expect(await padre(tx, l)).toMatchObject({ nombre: 'HU14330 Alta L', nit: '905666777-1' });
      });
    });

    it('AC2: editar el perfil sube al padre, sin recursión, y aumenta la versión una sola vez', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const l = await logistica(tx, 'HU14330 Edit L');
        await tx`UPDATE flito_proveedores_logistica SET nombre = 'HU14330 Edit L2', activo = false, nit = '906777888', contacto = 'Ana', telefono = '3001112233' WHERE id = ${l}`;
        expect(await padre(tx, l)).toMatchObject({ nombre: 'HU14330 Edit L2', activo: false, nit: '906777888', contacto: 'Ana', telefono: '3001112233', version: 2 });
        const s = await soat(tx, 'HU14330 Edit S');
        await tx`UPDATE flito_proveedores_soat SET nombre = 'HU14330 Edit S2', activo = false WHERE id = ${s}`;
        expect(await padre(tx, s)).toMatchObject({ nombre: 'HU14330 Edit S2', activo: false, version: 2 });
      });
    });

    it('AC2: editar el SOAT de un proveedor con ambos perfiles no borra el NIT ni el contacto del padre', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const id = await logistica(tx, 'HU14330 Mixto', '907888999');
        await tx`UPDATE flito_proveedores_logistica SET contacto = 'Luz' WHERE id = ${id}`;
        await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${id}, 'HU14330 Mixto')`;
        await tx`UPDATE flito_proveedores_soat SET nombre = 'HU14330 Mixto 2' WHERE id = ${id}`;
        expect(await padre(tx, id)).toMatchObject({ nombre: 'HU14330 Mixto 2', nit: '907888999', contacto: 'Luz' });
        expect((await tx`SELECT nombre FROM flito_proveedores_logistica WHERE id = ${id}`)[0]!.nombre).toBe('HU14330 Mixto 2');
      });
    });

    it('AC3: un cambio en el padre baja a las columnas viejas de cada perfil, sin recursión', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const l = await logistica(tx, 'HU14330 Baja L');
        const s = await soat(tx, 'HU14330 Baja S');
        await tx`UPDATE flito_proveedores SET nombre = 'HU14330 Baja L2', activo = false, nit = '908999000', contacto = 'Eva', telefono = '3002223344' WHERE id = ${l}`;
        await tx`UPDATE flito_proveedores SET nombre = 'HU14330 Baja S2', activo = false WHERE id = ${s}`;
        expect((await tx`SELECT nombre, activo, nit, contacto, telefono FROM flito_proveedores_logistica WHERE id = ${l}`)[0])
          .toEqual({ nombre: 'HU14330 Baja L2', activo: false, nit: '908999000', contacto: 'Eva', telefono: '3002223344' });
        expect((await tx`SELECT nombre, activo FROM flito_proveedores_soat WHERE id = ${s}`)[0]).toEqual({ nombre: 'HU14330 Baja S2', activo: false });
      });
    });

    it('AC4: el borrado físico deja al padre con baja lógica, salvo que conserve otro perfil vigente', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const solo = await logistica(tx, 'HU14330 Solo');
        await tx`DELETE FROM flito_proveedores_logistica WHERE id = ${solo}`;
        expect((await padre(tx, solo))!.deleted_at).not.toBeNull();
        const mixto = await logistica(tx, 'HU14330 Con otro');
        await tx`INSERT INTO flito_proveedores_soat (id, nombre) VALUES (${mixto}, 'HU14330 Con otro')`;
        await tx`DELETE FROM flito_proveedores_logistica WHERE id = ${mixto}`;
        expect((await padre(tx, mixto))!.deleted_at).toBeNull();
      });
    });

    it('la baja lógica de SOAT de la imagen anterior libera el nombre: se puede volver a crear', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const a = await soat(tx, 'HU14330 Reusar');
        await tx`UPDATE flito_proveedores_soat SET activo = false, deleted_at = now() WHERE id = ${a}`;
        expect((await padre(tx, a))!.deleted_at).not.toBeNull();
        const b = await soat(tx, 'HU14330 Reusar');
        expect(b).not.toBe(a);
      });
    });

    it('un choque de unicidad desde el perfil usa la restricción que conocen las rutas y no trae el NIT', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        await soat(tx, 'HU14330 Choque');
        await logistica(tx, 'HU14330 Con nit', '909000111');
        const error = async (fn: (s: Tx) => Promise<unknown>) => {
          try { await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); }); return null; } catch (e) { return e as postgres.PostgresError; }
        };
        const nombre = await error((s) => s`INSERT INTO flito_proveedores_logistica (nombre) VALUES ('hu14330 choque')`);
        expect(nombre).toMatchObject({ code: '23505', constraint_name: 'flito_proveedores_logistica_nombre_unique' });
        const nit = await error((s) => s`INSERT INTO flito_proveedores_logistica (nombre, nit) VALUES ('HU14330 Otro', '909000111-2')`);
        expect(nit).toMatchObject({ code: '23505', constraint_name: 'uq_flito_proveedores_logistica_nit' });
        expect(`${nit!.message} ${nit!.detail ?? ''}`).not.toContain('909000111');
        const soatChoque = await error((s) => s`INSERT INTO flito_proveedores_soat (nombre) VALUES ('hu14330  con NIT')`);
        expect(soatChoque).toMatchObject({ code: '23505', constraint_name: 'uq_flito_proveedores_soat_nombre_vivo' });
      });
    });

    it('AC5: los usuarios existentes conservan su proveedor; uno distinto hace fallar la comprobación final', async () => {
      await enTx(sql, async (tx) => {
        const s = await soat(tx, 'HU14330 Usuarios');
        const u = (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id)
          VALUES ('hu14330-ac5', 'HU14330 ac5', 'x', 'proveedor', ${s}) RETURNING id`)[0]!.id as number;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`; // Como una fila ya confirmada: sin eventos diferidos antes del DDL.
        await aplicar(tx);
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: s, vieja: s });
        const otro = await soat(tx, 'HU14330 Usuarios Otro');
        await tx.unsafe('ALTER TABLE users DISABLE TRIGGER users_proveedor_sync');
        await tx`UPDATE users SET flito_proveedor_id = ${otro} WHERE id = ${u}`;
        await expect(tx.savepoint(async (sp) => { await sp.unsafe(COMPROBACION_FINAL); })).rejects.toThrow(/1 usuario\(s\) con proveedor distinto/);
      });
    });

    it('AC6: crear, cambiar y quitar el proveedor con la columna vieja deja el mismo resultado en la nueva', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const a = await soat(tx, 'HU14330 U A');
        const b = await soat(tx, 'HU14330 U B');
        const u = (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id)
          VALUES ('hu14330-ac6', 'HU14330 ac6', 'x', 'proveedor', ${a}) RETURNING id`)[0]!.id as number;
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: a, vieja: a });
        await tx`UPDATE users SET flito_proveedor_soat_id = ${b} WHERE id = ${u}`;
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: b, vieja: b });
        await tx`UPDATE users SET role = 'admin', flito_proveedor_soat_id = NULL WHERE id = ${u}`;
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: null, vieja: null });
      });
    });

    it('AC7: un rol de enlace proveedor sin proveedor se rechaza con 23514, al crear y al quitarlo', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const s = await soat(tx, 'HU14330 Ambito');
        expect(await codigoDe(tx, (sp) => sp`INSERT INTO users (username, name, password_hash, role)
          VALUES ('hu14330-ac7a', 'HU14330 ac7', 'x', 'proveedor')`)).toBe('23514');
        const u = (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id)
          VALUES ('hu14330-ac7b', 'HU14330 ac7', 'x', 'proveedor', ${s}) RETURNING id`)[0]!.id as number;
        expect(await codigoDe(tx, (sp) => sp`UPDATE users SET flito_proveedor_id = NULL WHERE id = ${u}`)).toBe('23514');
        expect(await codigoDe(tx, (sp) => sp`UPDATE users SET flito_proveedor_soat_id = NULL WHERE id = ${u}`)).toBe('23514');
      });
    });

    it('AC8: un proveedor sin perfil de SOAT deja vacía la columna vieja, también al cambiar desde uno con SOAT', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const s = await soat(tx, 'HU14330 Con SOAT');
        const l = await logistica(tx, 'HU14330 Sin SOAT');
        const nuevo = await nuevoUsuario(tx, 'ac8a', l);
        expect(await columnasUsuario(tx, nuevo)).toEqual({ nueva: l, vieja: null });
        const u = await nuevoUsuario(tx, 'ac8b', s);
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: s, vieja: s });
        await tx`UPDATE users SET flito_proveedor_id = ${l} WHERE id = ${u}`;
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: l, vieja: null });
        // La imagen anterior reescribe la columna vieja con el mismo NULL al editar: no le quita el proveedor nuevo.
        await tx`UPDATE users SET flito_proveedor_soat_id = NULL WHERE id = ${u}`;
        expect(await columnasUsuario(tx, u)).toEqual({ nueva: l, vieja: null });
      });
    });

    it('AC9 (esquema): las columnas que lee la imagen anterior quedan al día tras escribir por el modelo nuevo', async () => {
      await enTx(sql, async (tx) => {
        await aplicar(tx);
        const s = await soat(tx, 'HU14330 Revertir');
        const u = await nuevoUsuario(tx, 'ac9', s);
        await tx`UPDATE flito_proveedores SET nombre = 'HU14330 Revertido', activo = false WHERE id = ${s}`;
        expect((await tx`SELECT nombre, activo FROM flito_proveedores_soat WHERE id = ${s} AND deleted_at IS NULL`)[0]).toEqual({ nombre: 'HU14330 Revertido', activo: false });
        expect((await tx`SELECT flito_proveedor_soat_id AS id FROM users WHERE id = ${u}`)[0]!.id).toBe(s);
        await tx`UPDATE flito_proveedores_soat SET activo = true WHERE id = ${s}`;
        expect((await padre(tx, s))!.activo).toBe(true);
      });
    });
  });

});
