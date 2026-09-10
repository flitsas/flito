// HU #12082 — La 0180: la bitácora de intentos denegados (ADR-0016) y la retirada del candado de
// `cliente` (AC8). Task de QA: #12268.
//
// Dos mitades, igual que la 0179:
//   · **Estática** (siempre corre, también en CI): lo que el `.sql` dice y lo que `schema.ts` dice
//     tienen que ser la misma afirmación en dos idiomas; y las reglas del archivo (sin BEGIN, sin
//     ALTER TYPE, sin ADD COLUMN, UPDATE condicionado, dollar-quoting etiquetado).
//   · **Contra PostgreSQL de verdad** (solo si hay base): la FK RESTRICT, la UNIQUE, el contador con
//     `ON CONFLICT`, `cliente.es_sistema = false`, la política de retención y la idempotencia fuerte.
//     Se activa con la URL de una base con la cadena al día:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0180.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { permisosIntentosDenegados, users } from '../../src/db/schema.js';
import { VENTANA_DEDUP_MS } from '../../src/shared/historial/permisos-intentos-denegados.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0180_permisos_motor.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0180 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0180.replace(/--[^\n]*/g, '');

describe('0180 — el archivo dice lo mismo que schema.ts (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0180)).toEqual([]);
    expect(SQL_0180).toMatch(/DO \$resumen0180\$/);
    expect(SQL_0180).toMatch(/END \$resumen0180\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0180.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12082/);
    expect(cabecera).toMatch(/ADR-0016/);
  });

  it('el número es 0180 y no colisiona con ningún otro archivo', () => {
    const con0180 = readdirSync(path.dirname(RUTA)).filter((f) => f.startsWith('0180_'));
    expect(con0180).toEqual([ARCHIVO]);
  });

  it('nada de ALTER TYPE ni de ADD COLUMN: lo que crea es una tabla nueva', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/ALTER\s+TYPE/i);
    expect(SIN_COMENTARIOS).not.toMatch(/ADD\s+COLUMN/i);
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS permisos_intentos_denegados/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE INDEX IF NOT EXISTS idx_permisos_intentos_funcion/);
  });

  it('la tabla: FK a users RESTRICT explícito (ADR-0005), sin FK en rol_codigo ni funcion_codigo, UNIQUE (user_id, funcion_codigo, ventana_inicio), CHECKs y ninguna columna de texto libre', () => {
    expect(SIN_COMENTARIOS).toMatch(/user_id\s+integer\s+NOT NULL REFERENCES users\(id\)\s+ON UPDATE RESTRICT ON DELETE RESTRICT/);
    expect(SIN_COMENTARIOS).toMatch(/rol_codigo\s+varchar\(40\)\s+NOT NULL,/);
    expect(SIN_COMENTARIOS).toMatch(/funcion_codigo\s+varchar\(80\)\s+NOT NULL,/);
    expect((SIN_COMENTARIOS.match(/REFERENCES/g) ?? [])).toHaveLength(1);
    expect(SIN_COMENTARIOS).toMatch(/permisos_intentos_denegados_ventana_uq UNIQUE \(user_id, funcion_codigo, ventana_inicio\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(motivo IN \('sin_funcion','sin_modulo','no_reconocida','no_resuelto'\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(veces >= 1\)/);
    const cuerpo = SIN_COMENTARIOS.split('CREATE TABLE IF NOT EXISTS permisos_intentos_denegados')[1]!.split(');')[0]!;
    expect(cuerpo).not.toMatch(/\btext\b/i);
    for (const pii of ['email', 'username', 'name', 'ip_address', 'user_agent', 'mensaje', 'detail', 'body']) {
      expect(cuerpo).not.toMatch(new RegExp(`\\b${pii}\\b`, 'i'));
    }
    // Sin REVOKE ni disparador WORM: el contador necesita UPDATE y la retención DELETE (ADR-0016 §6).
    expect(SIN_COMENTARIOS).not.toMatch(/REVOKE|CREATE TRIGGER/i);
  });

  it('las columnas del SQL son las del modelo Drizzle, una a una, y la UNIQUE lleva el MISMO nombre', () => {
    const cfg = getTableConfig(permisosIntentosDenegados);
    expect(cfg.name).toBe('permisos_intentos_denegados');
    const columnas = cfg.columns.map((c) => c.name);
    expect(columnas).toEqual([
      'id', 'user_id', 'rol_codigo', 'funcion_codigo', 'motivo', 'metodo', 'ruta',
      'ventana_inicio', 'primera_vez', 'ultima_vez', 'veces',
    ]);
    for (const c of columnas) expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+${c}\\s+`));
    const nombres = cfg.indexes.map((i) => i.config.name);
    expect(nombres).toContain('permisos_intentos_denegados_ventana_uq');
    expect(nombres).toContain('idx_permisos_intentos_funcion');
    const [fk] = cfg.foreignKeys;
    expect(fk!.reference().foreignTable).toBe(users);
    expect(fk!.onDelete).toBe('restrict');
    expect(fk!.onUpdate).toBe('restrict');
    expect(cfg.foreignKeys).toHaveLength(1);
  });

  it('el candado de cliente se retira con un UPDATE CONDICIONADO (segunda pasada: 0 filas) y admin no se toca', () => {
    expect(SIN_COMENTARIOS).toMatch(/UPDATE permisos_roles SET es_sistema = false, updated_at = now\(\)\s+WHERE codigo = 'cliente' AND es_sistema = true;/);
    expect((SIN_COMENTARIOS.match(/UPDATE\s+permisos_roles/g) ?? [])).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/UPDATE\s+users/i);
  });

  it('la retención queda declarada: 2 años, purgar, condicionada a que exista un admin y ON CONFLICT DO NOTHING; y repetida en el COMMENT de la tabla', () => {
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO pesv_retencion_politicas/);
    expect(SIN_COMENTARIOS).toMatch(/'permisos_intentos_denegados', 2, 'ISO 27001 A\.12\.4 \/ Ley 1581 art\. 11',\s+'purgar'::pesv_retencion_accion/);
    expect(SIN_COMENTARIOS).toMatch(/WHERE EXISTS \(SELECT 1 FROM users WHERE role = 'admin'\)\s+ON CONFLICT \(tipo_documento\) DO NOTHING/);
    expect(SIN_COMENTARIOS).toMatch(/COMMENT ON TABLE permisos_intentos_denegados IS[\s\S]*Retencion declarada: 2 anios, purgar/);
    // La ventana del contador es de una hora y se declara en el código, no en SQL (vi.useFakeTimers).
    expect(VENTANA_DEDUP_MS).toBe(60 * 60 * 1000);
    expect(SIN_COMENTARIOS).not.toMatch(/date_trunc/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

describe.skipIf(!URL_BASE)('0180 — contra la base real (bitácora, candado, retención e idempotencia)', () => {
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

  it('(a) la tabla existe con las columnas del ADR y ninguna de texto libre ni de PII', async () => {
    const cols = await sql`
      SELECT column_name, data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'permisos_intentos_denegados'
       ORDER BY ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'id', 'user_id', 'rol_codigo', 'funcion_codigo', 'motivo', 'metodo', 'ruta',
      'ventana_inicio', 'primera_vez', 'ultima_vez', 'veces',
    ]);
    expect(cols.every((c) => c.is_nullable === 'NO')).toBe(true);
    expect(cols.find((c) => c.column_name === 'ruta')?.character_maximum_length).toBe(300);
    expect(cols.some((c) => c.data_type === 'text')).toBe(false);
  });

  it('(a) la FK hacia users es RESTRICT en borrado y en actualización, y es la única', async () => {
    const fks = await sql`
      SELECT conname, confdeltype, confupdtype FROM pg_constraint
       WHERE conrelid = 'permisos_intentos_denegados'::regclass AND contype = 'f'`;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.confdeltype).toBe('r');
    expect(fks[0]!.confupdtype).toBe('r');
  });

  it('(a) el contador: dos intentos del mismo (usuario, función, ventana) son UNA fila con veces = 2; otra ventana es otra fila', async () => {
    const filas = await enTx(async (tx) => {
      const [admin] = await tx`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`;
      const ventana = new Date(Math.floor(Date.now() / VENTANA_DEDUP_MS) * VENTANA_DEDUP_MS);
      const otra = new Date(ventana.getTime() + VENTANA_DEDUP_MS);
      const upsert = (v: Date, ruta: string) => tx`
        INSERT INTO permisos_intentos_denegados (user_id, rol_codigo, funcion_codigo, motivo, metodo, ruta, ventana_inicio)
        VALUES (${admin!.id}, 'admin', 'prueba.0180.contar', 'sin_funcion', 'POST', ${ruta}, ${v})
        ON CONFLICT (user_id, funcion_codigo, ventana_inicio)
        DO UPDATE SET veces = permisos_intentos_denegados.veces + 1, ultima_vez = now(), ruta = EXCLUDED.ruta`;
      await upsert(ventana, '/a');
      await upsert(ventana, '/b');
      await upsert(otra, '/c');
      return tx`SELECT veces, ruta, ventana_inicio FROM permisos_intentos_denegados
                 WHERE funcion_codigo = 'prueba.0180.contar' ORDER BY ventana_inicio`;
    });
    expect(filas).toHaveLength(2);
    expect(filas[0]!.veces).toBe(2);
    expect(filas[0]!.ruta).toBe('/b'); // lo ÚLTIMO que pasó
    expect(filas[1]!.veces).toBe(1);
  });

  it('(a) el CHECK de motivo rechaza un valor fuera de los cuatro (23514)', async () => {
    const error = await enTx(async (tx) => {
      const [admin] = await tx`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`;
      try {
        await tx`INSERT INTO permisos_intentos_denegados (user_id, rol_codigo, funcion_codigo, motivo, metodo, ruta, ventana_inicio)
                 VALUES (${admin!.id}, 'admin', 'x.y.z', 'inventado', 'GET', '/', now())`;
        return null;
      } catch (e) { return e as { code?: string }; }
    });
    expect(error?.code).toBe('23514');
  });

  it('(b) cliente.es_sistema = false y admin.es_sistema = true; cliente sigue siendo externo', async () => {
    const roles = await sql`SELECT codigo, es_sistema, tipo_principal FROM permisos_roles WHERE codigo IN ('admin','cliente') ORDER BY codigo`;
    expect(roles).toEqual([
      { codigo: 'admin', es_sistema: true, tipo_principal: 'interno' },
      { codigo: 'cliente', es_sistema: false, tipo_principal: 'externo' },
    ]);
  });

  it('(a) la política de retención quedó declarada: 2 años, purgar', async () => {
    const [p] = await sql`SELECT retencion_anios, accion, habilitado FROM pesv_retencion_politicas WHERE tipo_documento = 'permisos_intentos_denegados'`;
    expect(p).toMatchObject({ retencion_anios: 2, accion: 'purgar', habilitado: true });
  });

  it('(c) idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila', async () => {
    const { antes, despues } = await enTx(async (tx) => {
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(codigo||es_sistema::text||tipo_principal||updated_at::text, ',' ORDER BY codigo)) FROM permisos_roles) AS r,
          (SELECT md5(string_agg(tipo_documento||retencion_anios::text||accion::text||coalesce(created_by::text,'-'), ',' ORDER BY tipo_documento)) FROM pesv_retencion_politicas) AS p,
          (SELECT md5(string_agg(id::text||role||coalesce(session_invalidated_at::text,'-'), ',' ORDER BY id)) FROM users) AS u,
          (SELECT count(*)::int FROM permisos_intentos_denegados) AS n
      `)[0];
      const a = await huella();
      await tx.unsafe(SQL_0180);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
