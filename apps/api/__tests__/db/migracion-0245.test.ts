// HU #13803 (Feature #13695) — La 0245: `flito_drflit_autorizaciones`, solo inserción (AC6) e idempotente (AC8).
//
//   · Estática (siempre corre): sin control de transacción propio, dollar-quoting etiquetado, triggers.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL, en tx con ROLLBACK): el archivo dos veces; INSERT
//     sí; UPDATE, DELETE y TRUNCATE → P0001; la misma versión dos veces → 23505; finalidad fuera → 23514.
//   · `repoAutorizaciones` con la consulta Drizzle REAL (AC2/AC4/AC5): el test HTTP usa un almacén en
//     memoria; aquí se prueba que el `where` filtra por usuario, finalidad Y versión (retrabajo QA B, M1).
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as sqlDrizzle } from 'drizzle-orm';
import { AUTORIZACIONES_DRFLIT } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { repoAutorizaciones, type ConexionAutorizaciones } from '../../src/modules/flito-dr-flit/dr-flit.service.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const ARCHIVO = '0245_flito_drflit_autorizaciones.sql';
const SQL_0245 = leerMigracion(ARCHIVO);
const SHA = 'a'.repeat(64);

describe('0245 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio y con dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0245)).toEqual([]);
    expect(SQL_0245.replace(/--[^\n]*/g, '')).not.toMatch(/\$\$/);
  });

  it('idempotente por construcción y con los dos triggers de solo inserción', () => {
    expect(SQL_0245).toMatch(/CREATE TABLE IF NOT EXISTS flito_drflit_autorizaciones/);
    expect(SQL_0245).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_drflit_aut_usuario_finalidad_version/);
    expect(SQL_0245).toMatch(/DROP TRIGGER IF EXISTS tr_flito_drflit_aut_solo_insercion/);
    expect(SQL_0245).toMatch(/BEFORE UPDATE OR DELETE ON flito_drflit_autorizaciones/);
    expect(SQL_0245).toMatch(/BEFORE TRUNCATE ON flito_drflit_autorizaciones/);
  });
});

describe.skipIf(!URL_BASE)('0245 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC8 dos veces sin error · AC6 UPDATE/DELETE/TRUNCATE rechazados · UNIQUE y CHECK', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0245);
        await tx.unsafe(SQL_0245);
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!u) return; // base sin usuarios: lo demás no tiene con quién probarse
        const [fila] = await tx`
          INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256, ip, user_agent)
          VALUES (${u.id}, 'soporte', 'v-test-0245', ${SHA}, '127.0.0.1', 'vitest') RETURNING id`;
        expect(fila!.id).toBeGreaterThan(0);

        const codigo = async (q: () => Promise<unknown>) => {
          try { await tx.savepoint(async () => { await q(); }); return 'ok'; } catch (e) { return (e as { code?: string }).code; }
        };
        expect(await codigo(() => tx`UPDATE flito_drflit_autorizaciones SET version = 'otra' WHERE id = ${fila!.id}`)).toBe('P0001');
        expect(await codigo(() => tx`DELETE FROM flito_drflit_autorizaciones WHERE id = ${fila!.id}`)).toBe('P0001');
        expect(await codigo(() => tx`TRUNCATE flito_drflit_autorizaciones`)).toBe('P0001');
        expect(await codigo(() => tx`
          INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256)
          VALUES (${u.id}, 'soporte', 'v-test-0245', ${SHA})`)).toBe('23505');
        expect(await codigo(() => tx`
          INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256)
          VALUES (${u.id}, 'otra', 'v-test-0245', ${SHA})`)).toBe('23514');
        // AC5 a nivel de base: la otra finalidad con la misma versión es otra fila.
        expect(await codigo(() => tx`
          INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256)
          VALUES (${u.id}, 'ia', 'v-test-0245', ${SHA})`)).toBe('ok');
      });
    } finally {
      await sql.end();
    }
  });

  it('repoAutorizaciones (Drizzle real): versión anterior no cuenta, la vigente sí, «ia» independiente', async () => {
    const VIGENTE = AUTORIZACIONES_DRFLIT.soporte.version;
    const ROLLBACK = new Error('rollback');
    const sql = abrirBase();
    try {
      await drizzle(sql).transaction(async (tx) => {
        await tx.execute(sqlDrizzle.raw(SQL_0245));
        const conexion = tx as unknown as ConexionAutorizaciones;
        const filasUsuario = await tx.execute<{ id: number }>(sqlDrizzle`SELECT id FROM users ORDER BY id LIMIT 1`);
        const usuarioId = (filasUsuario as unknown as Array<{ id: number }>)[0]?.id;
        expect(usuarioId, 'la base de prueba necesita al menos un usuario').toBeDefined();
        const nueva = (version: string, finalidad: 'soporte' | 'ia' = 'soporte') => ({
          usuarioId: usuarioId!, finalidad, version, textoSha256: SHA, ip: '127.0.0.1', userAgent: 'vitest',
        });

        // AC4: solo una aceptación de una versión ANTERIOR → la vigente no está.
        expect(await repoAutorizaciones.insertar(nueva('2025-01-anterior-0245'), conexion)).not.toBeNull();
        expect(await repoAutorizaciones.buscar(usuarioId!, 'soporte', VIGENTE, conexion)).toBeNull();

        // AC2: insertada la vigente, `buscar` la devuelve; insertarla otra vez → null (ON CONFLICT DO NOTHING).
        const insertada = await repoAutorizaciones.insertar(nueva(VIGENTE), conexion);
        expect(insertada).toMatchObject({ version: VIGENTE });
        const hallada = await repoAutorizaciones.buscar(usuarioId!, 'soporte', VIGENTE, conexion);
        expect(hallada).toMatchObject({ id: insertada!.id, version: VIGENTE });
        expect(hallada!.aceptadaEn).toBeInstanceOf(Date);
        expect(await repoAutorizaciones.insertar(nueva(VIGENTE), conexion)).toBeNull();

        // AC5: «ia» sigue sin aceptar aunque «soporte» lo esté.
        expect(await repoAutorizaciones.buscar(usuarioId!, 'ia', AUTORIZACIONES_DRFLIT.ia.version, conexion)).toBeNull();
        throw ROLLBACK;
      }).catch((e) => { if (e !== ROLLBACK) throw e; });
    } finally {
      await sql.end();
    }
  });
});
