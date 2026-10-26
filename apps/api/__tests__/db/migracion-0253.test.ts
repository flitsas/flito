// HU #13944 (Feature #13939) — La 0253: `permisos_funciones.exclusiva_admin`.
//
//   · Estática (siempre corre): sin control de transacción propio, idempotente (ADD COLUMN IF NOT EXISTS, ON CONFLICT
//     DO NOTHING), no marca ni inserta funciones (opción c: las exclusivas nacen con sus rutas en #13945/#13954), y la
//     columna de `schema.ts` dice lo mismo que el SQL.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL), en tx con ROLLBACK: dos veces sin error; la columna
//     `boolean NOT NULL DEFAULT false`; ninguna función queda marcada; y con una función marcada a mano, la 0253 deja
//     el invariante cierto (fuera de los roles ≠ admin y de las excepciones por usuario; dentro de `admin`) y una
//     tercera pasada no cambia nada.
import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { permisosFunciones } from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const ARCHIVO = '0253_permisos_funciones_exclusiva_admin.sql';
const SQL_0253 = leerMigracion(ARCHIVO);
const SIN_COMENTARIOS = SQL_0253.replace(/--[^\n]*/g, '');

describe('0253 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio; ADD COLUMN IF NOT EXISTS boolean NOT NULL DEFAULT false; INSERT con ON CONFLICT', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0253)).toEqual([]);
    expect(SIN_COMENTARIOS).toMatch(/ADD COLUMN IF NOT EXISTS exclusiva_admin boolean NOT NULL DEFAULT false/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]*ON CONFLICT DO NOTHING/);
  });

  it('opción c: no inserta funciones en el catálogo ni marca ninguna (las exclusivas nacen con sus rutas)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_funciones/);
    expect(SIN_COMENTARIOS).not.toMatch(/SET exclusiva_admin/);
    expect(SIN_COMENTARIOS).not.toMatch(/clients\.clientes\./);
  });

  it('schema.ts declara la misma columna: boolean NOT NULL DEFAULT false', () => {
    const col = getTableConfig(permisosFunciones).columns.find((c) => c.name === 'exclusiva_admin');
    expect(col).toBeDefined();
    expect(col!.getSQLType()).toBe('boolean');
    expect(col!.notNull).toBe(true);
    expect(col!.default).toBe(false);
  });
});

describe.skipIf(!URL_BASE)('0253 — contra PostgreSQL (tx con ROLLBACK)', () => {
  // HU #13945: la 0255 (posterior) sí marca una función, así que sobre una base que ya la aplicó la 0253 no deja «cero
  // marcadas»: lo que se mide es que la 0253 no marca NINGUNA más de las que ya había (sin columna previa: cero).
  it('dos veces sin error; la columna existe con su tipo y default; la 0253 no marca ninguna función', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        const [conColumna] = await tx`SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'permisos_funciones' AND column_name = 'exclusiva_admin' AND table_schema = current_schema()`;
        const previas = conColumna!.n === 0 ? 0
          : (await tx`SELECT count(*)::int AS n FROM permisos_funciones WHERE exclusiva_admin`)[0]!.n;
        await tx.unsafe(SQL_0253);
        await tx.unsafe(SQL_0253);
        const [col] = await tx`SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'permisos_funciones' AND column_name = 'exclusiva_admin' AND table_schema = current_schema()`;
        expect(col).toMatchObject({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
        const [n] = await tx`SELECT count(*)::int AS n FROM permisos_funciones WHERE exclusiva_admin`;
        expect(n!.n).toBe(previas);
      });
    } finally {
      await sql.end();
    }
  });

  it('con una función marcada: fuera de los roles ≠ admin y de las excepciones por usuario, dentro de admin; re-ejecutable', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0253);
        const [f] = await tx`SELECT codigo FROM permisos_funciones ORDER BY codigo LIMIT 1`;
        const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE codigo <> 'admin' ORDER BY codigo LIMIT 1`;
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!f || !rol || !u) return;
        await tx`UPDATE permisos_funciones SET exclusiva_admin = true WHERE codigo = ${f.codigo}`;
        await tx`DELETE FROM permisos_rol_funcion WHERE rol_codigo = 'admin' AND funcion_codigo = ${f.codigo}`;
        await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES (${rol.codigo}, ${f.codigo}) ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM permisos_usuario_funcion WHERE user_id = ${u.id} AND funcion_codigo = ${f.codigo}`;
        await tx`INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto) VALUES (${u.id}, ${f.codigo}, 'conceder')`;

        const estado = async () => {
          const [r] = await tx`SELECT
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo = ${f.codigo} AND rol_codigo <> 'admin') AS otros,
            (SELECT count(*)::int FROM permisos_rol_funcion WHERE funcion_codigo = ${f.codigo} AND rol_codigo = 'admin') AS admin,
            (SELECT count(*)::int FROM permisos_usuario_funcion WHERE funcion_codigo = ${f.codigo}) AS usuarios`;
          return r;
        };
        await tx.unsafe(SQL_0253);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
        await tx.unsafe(SQL_0253);
        expect(await estado()).toEqual({ otros: 0, admin: 1, usuarios: 0 });
      });
    } finally {
      await sql.end();
    }
  });
});
