// HU #12087 — La 0188: re-sincroniza `permisos_usuario_funcion` con `users.allowed_pages` antes de que
// el resolutor cambie de fuente. La 0179 copió la columna a la tabla una vez; desde entonces el alta y
// la edición siguieron escribiendo la columna. Sin este resync, los usuarios editados después de la
// 0179 perderían o ganarían páginas el día del deploy (AC6).
//
// Dos mitades, igual que la 0187:
//   · **Estática** (siempre corre, también en CI): sin control de tx propio, dollar-quoting etiquetado,
//     numeración («la anterior es 0187», NO «es la última»), solo DML (ni CREATE/ALTER/DROP), el
//     `DELETE` acotado a `efecto = 'conceder' AND funcion_codigo LIKE 'pagina.%'` (las `revocar` y las
//     `operacion.*` no se tocan), el `INSERT … ON CONFLICT DO NOTHING` de la 0179 paso 5, el `COMMENT ON
//     COLUMN users.allowed_pages` y el bloque `DO $resumen0188$` con conteos y comprobación que revienta.
//   · **Contra PostgreSQL de verdad** (solo si hay base): idempotencia fuerte —la segunda pasada no
//     cambia una fila— y, dentro de una tx que se revierte, un usuario con la columna distinta de la
//     tabla queda igualado en las dos direcciones (quitado y añadido), sin tocar sus `revocar`.
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0188.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0188_permisos_usuario_paginas_resync.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0188 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0188.replace(/--[^\n]*/g, '');
const URL_BASE = process.env.TEST_DATABASE_URL;

describe('0188 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el DO lleva dollar-quoting etiquetado, sin nombrar la etiqueta en comentarios', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0188)).toEqual([]);
    expect(SQL_0188).toMatch(/DO \$resumen0188\$/);
    expect(SQL_0188).toMatch(/END \$resumen0188\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    const comentarios = SQL_0188.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(comentarios).not.toMatch(/\$resumen0188\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0188.split('\n').slice(0, 10).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12087/);
  });

  it('el número 0188 no colisiona y la anterior es la 0187 (la de la HU #12085)', () => {
    // «La anterior es 0187» y NO «es la última»: exigir el tip congela la numeración y pone rojo el
    // CI del PR siguiente que añada una migración.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0188_'))).toEqual([ARCHIVO]);
    const pos = sqls.indexOf(ARCHIVO);
    expect(sqls[pos - 1]).toBe('0187_pagina_roles_permisos.sql');
  });

  it('SOLO datos: ni CREATE, ni ALTER, ni DROP, ni TRUNCATE, ni UPDATE', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|UPDATE)\b/i);
  });

  it('el DELETE está acotado a `conceder` + `pagina.%` cuyo slug ya no está en la columna: las `revocar` y las `operacion.*` no se tocan', () => {
    const deletes = SIN_COMENTARIOS.match(/DELETE FROM permisos_usuario_funcion[\s\S]*?;/g) ?? [];
    expect(deletes).toHaveLength(1);
    const d = deletes[0];
    expect(d).toMatch(/uf\.efecto = 'conceder'/);
    expect(d).toMatch(/uf\.funcion_codigo LIKE 'pagina\.%'/);
    expect(d).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM users u\s+WHERE u\.id = uf\.user_id\s+AND substr\(uf\.funcion_codigo, 8\) = ANY \(u\.allowed_pages\)/);
    // Ningún otro DELETE sobre ninguna tabla.
    expect(SIN_COMENTARIOS.match(/\bDELETE\b/g)).toHaveLength(1);
  });

  it('el INSERT es el de la 0179 paso 5: DISTINCT, slug validado contra el catálogo, ON CONFLICT DO NOTHING', () => {
    const inserts = SIN_COMENTARIOS.match(/INSERT INTO permisos_usuario_funcion[\s\S]*?;/g) ?? [];
    expect(inserts).toHaveLength(1);
    const i = inserts[0];
    expect(i).toMatch(/SELECT DISTINCT u\.id, 'pagina\.' \|\| s\.slug, 'conceder'/);
    expect(i).toMatch(/CROSS JOIN LATERAL unnest\(u\.allowed_pages\) AS s\(slug\)/);
    expect(i).toMatch(/WHERE EXISTS \(SELECT 1 FROM permisos_funciones f WHERE f\.codigo = 'pagina\.' \|\| s\.slug\)/);
    expect(i).toMatch(/ON CONFLICT \(user_id, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS.match(/\bINSERT\b/g)).toHaveLength(1);
  });

  it('marca la columna obsoleta en la base (COMMENT ON COLUMN users.allowed_pages) nombrando la HU y la fuente nueva', () => {
    expect(SIN_COMENTARIOS).toMatch(/COMMENT ON COLUMN users\.allowed_pages IS\s*'OBSOLETA \(HU #12087\)[^']*permisos_usuario_funcion'/);
  });

  it('el resumen cuenta borradas, insertadas y total, y REVIENTA si queda un usuario desviado (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/GET DIAGNOSTICS n_borradas = ROW_COUNT/);
    expect(SIN_COMENTARIOS).toMatch(/GET DIAGNOSTICS n_insertadas = ROW_COUNT/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_desviados <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0188: [^']*% borradas, % insertadas, % conceder pagina\.\* en total/);
  });
});

describe.skipIf(!URL_BASE)('0188 — contra la base real (resync e idempotencia)', () => {
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

  const huellaDe = async (tx: postgres.TransactionSql) => (await tx`
    SELECT
      (SELECT md5(coalesce(string_agg(user_id||':'||funcion_codigo||':'||efecto, ',' ORDER BY user_id, funcion_codigo), '')) FROM permisos_usuario_funcion) AS h,
      (SELECT count(*)::int FROM permisos_usuario_funcion) AS n
  `)[0];

  it('(a) idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila', async () => {
    const { antes, despues } = await enTx(async (tx) => {
      await tx.unsafe(SQL_0188);
      const a = await huellaDe(tx);
      await tx.unsafe(SQL_0188);
      const d = await huellaDe(tx);
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);

  it('(b) un usuario con la columna distinta de la tabla queda igualado en las dos direcciones, y sus `revocar` no se tocan', async () => {
    const filas = await enTx(async (tx) => {
      // Un usuario de prueba con dos páginas válidas en la columna: `fleet` (que la tabla NO tiene) y
      // `users` (que la tabla SÍ tiene). La tabla trae además `conceder pagina.rndc` (que la columna
      // ya no tiene) y `revocar pagina.dashboard` (una decisión de la HU, intocable).
      const [u] = await tx`
        INSERT INTO users (username, name, email, password_hash, role, active, allowed_pages)
        VALUES ('t0188', 'T 0188', 't0188@example.invalid', 'x', 'auditor', true, ARRAY['fleet','users','slug_que_no_existe'])
        RETURNING id`;
      await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES
        (${u.id}, 'pagina.users', 'conceder'), (${u.id}, 'pagina.rndc', 'conceder'), (${u.id}, 'pagina.dashboard', 'revocar')`;
      await tx.unsafe(SQL_0188);
      return tx`SELECT funcion_codigo, efecto FROM permisos_usuario_funcion WHERE user_id = ${u.id} ORDER BY funcion_codigo`;
    });
    expect(filas.map((f) => `${f.efecto}:${f.funcion_codigo}`)).toEqual([
      'revocar:pagina.dashboard', 'conceder:pagina.fleet', 'conceder:pagina.users',
    ]);
  }, 60_000);
});
