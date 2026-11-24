// HU #13804 (Feature #13695) — La 0246: `flito_drflit_casos_soporte` (AC7: solo metadatos; idempotencia
// y reclamo atómico con las consultas Drizzle REALES; purga a 12 meses).
//
//   · Estática (siempre corre): sin control de transacción propio, idempotente, sin columnas de texto del caso.
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL, en tx con ROLLBACK): 0245 + 0246 dos veces; CHECKs,
//     UNIQUE y FK RESTRICT; `repoCasos` (insertar / buscar / reclamar / marcar*) y `ejecutarPurgaDrFlit`.
//     Los tests HTTP usan almacenes en memoria: aquí se prueba que las consultas reales hacen lo mismo.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as sqlDrizzle } from 'drizzle-orm';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { repoCasos, type ConexionCasos } from '../../src/modules/flito-dr-flit/dr-flit-casos.service.js';
import { ejecutarPurgaDrFlit, type ConexionPurga } from '../../src/modules/flito-dr-flit/dr-flit-purga.service.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const ARCHIVO = '0246_flito_drflit_casos_soporte.sql';
const SQL_0246 = leerMigracion(ARCHIVO);
const SQL_0245 = leerMigracion('0245_flito_drflit_autorizaciones.sql');
const SHA = 'b'.repeat(64);
const CLAVE = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COLUMNAS = [
  'actualizado_en', 'adjuntos_cantidad', 'ambiente', 'autorizacion_id', 'clave_idempotencia', 'creado_en', 'error_codigo',
  'estado', 'id', 'numero_ado', 'radicado_en', 'reintentos', 'usuario_id',
];

describe('0246 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio, idempotente y con sus índices', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0246)).toEqual([]);
    expect(SQL_0246).toMatch(/CREATE TABLE IF NOT EXISTS flito_drflit_casos_soporte/);
    expect(SQL_0246).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_drflit_casos_usuario_clave/);
    expect(SQL_0246).toMatch(/CREATE INDEX IF NOT EXISTS ix_flito_drflit_casos_creado_en/);
    expect(SQL_0246).toMatch(/CREATE INDEX IF NOT EXISTS ix_flito_drflit_casos_autorizacion/);
    expect(SQL_0246).toMatch(/REFERENCES flito_drflit_autorizaciones\(id\) ON DELETE RESTRICT/);
  });

  it('D6: ninguna columna de texto del caso', () => {
    const ddl = SQL_0246.replace(/--[^\n]*/g, '');
    for (const prohibida of ['titulo', 'detalle', 'correo', 'nombre', 'telefono', 'area', 'prioridad', 'resultado']) {
      expect(ddl).not.toMatch(new RegExp(`\\b${prohibida}\\b`));
    }
  });
});

describe.skipIf(!URL_BASE)('0246 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('dos veces sin error · columnas exactas · CHECKs, UNIQUE y FK RESTRICT', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0245);
        await tx.unsafe(SQL_0246);
        await tx.unsafe(SQL_0246);
        const cols = await tx`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'flito_drflit_casos_soporte' ORDER BY column_name`;
        expect(cols.map((c) => c.column_name)).toEqual(COLUMNAS);
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!u) return;
        const [a] = await tx`INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256)
          VALUES (${u.id}, 'soporte', 'v-test-0246', ${SHA}) RETURNING id`;
        const codigo = async (q: () => Promise<unknown>) => {
          try { await tx.savepoint(async () => { await q(); }); return 'ok'; } catch (e) { return (e as { code?: string }).code; }
        };
        const ins = (clave: string, estado = 'pendiente', ambiente = 'QA') => tx`INSERT INTO flito_drflit_casos_soporte
          (usuario_id, autorizacion_id, clave_idempotencia, estado, ambiente) VALUES (${u.id}, ${a!.id}, ${clave}, ${estado}, ${ambiente})`;
        expect(await codigo(() => ins(CLAVE(1)))).toBe('ok');
        expect(await codigo(() => ins(CLAVE(1)))).toBe('23505');
        expect(await codigo(() => ins(CLAVE(2), 'creado'))).toBe('23514');   // creado sin número
        expect(await codigo(() => ins(CLAVE(3), 'borrado'))).toBe('23514');
        expect(await codigo(() => ins(CLAVE(5), 'pendiente', 'PRO'))).toBe('23514');
        expect(await codigo(() => tx`INSERT INTO flito_drflit_casos_soporte (usuario_id, autorizacion_id, clave_idempotencia, ambiente, adjuntos_cantidad)
          VALUES (${u.id}, ${a!.id}, ${CLAVE(6)}, 'QA', 11)`)).toBe('23514');
        expect(await codigo(() => tx`INSERT INTO flito_drflit_casos_soporte (usuario_id, autorizacion_id, clave_idempotencia, ambiente)
          VALUES (${u.id}, -1, ${CLAVE(7)}, 'QA')`)).toBe('23503');
      });
    } finally {
      await sql.end();
    }
  });

  it('repoCasos (Drizzle real): idempotencia, reclamo atómico y marcas; purga a 12 meses por lotes', async () => {
    const ROLLBACK = new Error('rollback');
    const sql = abrirBase();
    try {
      await drizzle(sql).transaction(async (tx) => {
        await tx.execute(sqlDrizzle.raw(SQL_0245));
        await tx.execute(sqlDrizzle.raw(SQL_0246));
        const conexion = tx as unknown as ConexionCasos;
        const usuarios = (await tx.execute(sqlDrizzle`SELECT id FROM users ORDER BY id LIMIT 2`)) as unknown as Array<{ id: number }>;
        const usuarioId = usuarios[0]?.id;
        expect(usuarioId, 'la base de prueba necesita al menos un usuario').toBeDefined();
        const [aut] = (await tx.execute(sqlDrizzle`INSERT INTO flito_drflit_autorizaciones (usuario_id, finalidad, version, texto_sha256)
          VALUES (${usuarioId}, 'soporte', 'v-test-0246-repo', ${SHA}) RETURNING id`)) as unknown as Array<{ id: number }>;
        const autorizacionId = aut!.id;
        const nuevo = (clave: string, u = usuarioId!) => ({
          usuarioId: u, autorizacionId, claveIdempotencia: clave, ambiente: 'QA' as const, adjuntosCantidad: 0,
        });

        // Inserción e idempotencia.
        const i1 = await repoCasos.insertar(nuevo(CLAVE(101)), conexion);
        expect(i1).toMatchObject({ estado: 'pendiente', numeroAdo: null });
        expect(await repoCasos.insertar(nuevo(CLAVE(101)), conexion)).toBeNull();
        expect(await repoCasos.buscar(usuarioId!, CLAVE(101), conexion)).toEqual(i1);
        if (usuarios[1]) {
          expect(await repoCasos.buscar(usuarios[1].id, CLAVE(101), conexion)).toBeNull();
          expect(await repoCasos.insertar(nuevo(CLAVE(101), usuarios[1].id), conexion)).not.toBeNull();
        }

        // Pendiente reciente → no se reclama.
        expect(await repoCasos.reclamar(i1!.id, usuarioId!, autorizacionId, 120, conexion)).toBeNull();
        // Pendiente vencido → se reclama una vez; el segundo reclamo (ya reciente) no.
        await tx.execute(sqlDrizzle`UPDATE flito_drflit_casos_soporte SET actualizado_en = now() - interval '1 hour' WHERE id = ${i1!.id}`);
        expect(await repoCasos.reclamar(i1!.id, usuarioId!, autorizacionId, 120, conexion)).toMatchObject({ id: i1!.id, estado: 'pendiente' });
        expect(await repoCasos.reclamar(i1!.id, usuarioId!, autorizacionId, 120, conexion)).toBeNull();
        // Otro usuario no puede reclamar el intento ajeno.
        await repoCasos.marcarFallido(i1!.id, 'timeout', conexion);
        if (usuarios[1]) expect(await repoCasos.reclamar(i1!.id, usuarios[1].id, autorizacionId, 120, conexion)).toBeNull();
        // Fallido → se reclama (reintentos 2, error limpiado).
        expect(await repoCasos.reclamar(i1!.id, usuarioId!, autorizacionId, 120, conexion)).not.toBeNull();
        let [fila] = (await tx.execute(sqlDrizzle`SELECT estado, reintentos, error_codigo FROM flito_drflit_casos_soporte WHERE id = ${i1!.id}`)) as unknown as Array<Record<string, unknown>>;
        expect(fila).toEqual({ estado: 'pendiente', reintentos: 2, error_codigo: null });

        // Creado (con tag rechazado) → ni se reclama ni lo pisa un fallido tardío.
        await repoCasos.marcarCreado(i1!.id, 13_999, 'tag-rechazado', conexion);
        await repoCasos.marcarFallido(i1!.id, 'red', conexion);
        expect(await repoCasos.buscar(usuarioId!, CLAVE(101), conexion)).toEqual({ id: i1!.id, estado: 'creado', numeroAdo: 13_999 });
        expect(await repoCasos.reclamar(i1!.id, usuarioId!, autorizacionId, 120, conexion)).toBeNull();
        [fila] = (await tx.execute(sqlDrizzle`SELECT error_codigo, radicado_en IS NOT NULL AS radicado FROM flito_drflit_casos_soporte WHERE id = ${i1!.id}`)) as unknown as Array<Record<string, unknown>>;
        expect(fila).toEqual({ error_codigo: 'tag-rechazado', radicado: true });

        // Purga (RN-DRF1): dos viejos (lote de 1 → varias vueltas) se borran, el reciente y la autorización quedan.
        const viejos = [CLAVE(201), CLAVE(202)];
        for (const c of viejos) {
          await tx.execute(sqlDrizzle`INSERT INTO flito_drflit_casos_soporte (usuario_id, autorizacion_id, clave_idempotencia, ambiente, creado_en)
            VALUES (${usuarioId}, ${autorizacionId}, ${c}, 'QA', now() - interval '13 months')`);
        }
        const r = await ejecutarPurgaDrFlit({ ahora: new Date(), lote: 1, conexion: tx as unknown as ConexionPurga });
        expect(r.borrados).toBeGreaterThanOrEqual(2);
        expect(r.lotes).toBeGreaterThanOrEqual(3);
        for (const c of viejos) expect(await repoCasos.buscar(usuarioId!, c, conexion)).toBeNull();
        expect(await repoCasos.buscar(usuarioId!, CLAVE(101), conexion)).not.toBeNull();
        const aun = (await tx.execute(sqlDrizzle`SELECT count(*)::int AS n FROM flito_drflit_autorizaciones WHERE id = ${autorizacionId}`)) as unknown as Array<{ n: number }>;
        expect(aun[0]!.n).toBe(1);
        throw ROLLBACK;
      }).catch((e) => { if (e !== ROLLBACK) throw e; });
    } finally {
      await sql.end();
    }
  });
});
