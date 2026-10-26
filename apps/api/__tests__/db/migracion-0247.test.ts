// HU #13854 (Feature #13696, IA-2) — La 0247: `flito_drflit_cupo_ia` (cupo diario de mensajes a la IA).
//
//   · Estática (siempre corre): sin control de transacción propio, idempotente, solo las 4 columnas (AC8).
//   · Contra PostgreSQL (solo con TEST_DATABASE_URL):
//       - en tx con ROLLBACK: 0247 dos veces; columnas exactas; CHECK, PK y FK CASCADE; las consultas REALES
//         de `dr-flit-ia.cupo.ts` (AC1, AC2, AC4, AC5, tope 0 de AC9) y `ejecutarPurgaCupoIaDrFlit` (AC8).
//       - AC3 (concurrencia): necesita DOS conexiones que vean la misma tabla, así que no cabe en una tx.
//         Se crea la 0247 en un esquema desechable (`search_path` = esquema, public) y se borra al final.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as sqlDrizzle } from 'drizzle-orm';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  consultarCupoIa, devolverCupoIa, reservarCupoIa, type ConexionCupo,
} from '../../src/modules/flito-dr-flit/dr-flit-ia.cupo.js';
import { ejecutarPurgaCupoIaDrFlit } from '../../src/modules/flito-dr-flit/dr-flit-purga.service.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const ARCHIVO = '0247_flito_drflit_cupo_ia.sql';
const SQL_0247 = leerMigracion(ARCHIVO);
const COLUMNAS = ['actualizado_en', 'dia', 'usados', 'usuario_id'];
// 2026-10-22 23:59 y 2026-10-23 00:00 en America/Bogota (UTC−5).
const D_2359 = new Date('2026-10-23T04:59:00Z');
const D1_0000 = new Date('2026-10-23T05:00:00Z');

describe('0247 — reglas del archivo (análisis estático)', () => {
  it('sin control de transacción propio, idempotente, PK, CHECK, FK CASCADE e índice por día', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0247)).toEqual([]);
    expect(SQL_0247).toMatch(/CREATE TABLE IF NOT EXISTS flito_drflit_cupo_ia/);
    expect(SQL_0247).toMatch(/CONSTRAINT pk_flito_drflit_cupo_ia PRIMARY KEY \(usuario_id, dia\)/);
    expect(SQL_0247).toMatch(/CONSTRAINT ck_flito_drflit_cupo_ia_usados CHECK \(usados >= 0\)/);
    expect(SQL_0247).toMatch(/REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(SQL_0247).toMatch(/CREATE INDEX IF NOT EXISTS ix_flito_drflit_cupo_ia_dia ON flito_drflit_cupo_ia \(dia\)/);
  });

  it('AC8: sin texto, IP ni intent', () => {
    const ddl = SQL_0247.replace(/--[^\n]*/g, '').replace(/COMMENT ON[\s\S]*$/, '');
    for (const prohibida of ['texto', 'mensaje', 'ip', 'intent', 'user_agent', 'reply', 'contenido']) {
      expect(ddl).not.toMatch(new RegExp(`\\b${prohibida}\\b`));
    }
  });
});

describe.skipIf(!URL_BASE)('0247 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('dos veces sin error · columnas exactas · CHECK usados >= 0, PK y FK', async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        await tx.unsafe(SQL_0247);
        await tx.unsafe(SQL_0247);
        const cols = await tx`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'flito_drflit_cupo_ia' AND table_schema = current_schema() ORDER BY column_name`;
        expect(cols.map((c) => c.column_name)).toEqual(COLUMNAS);
        const [fk] = await tx`SELECT confdeltype FROM pg_constraint
          WHERE conrelid = 'flito_drflit_cupo_ia'::regclass AND contype = 'f'`;
        expect(fk!.confdeltype).toBe('c');
        const [u] = await tx`SELECT id FROM users ORDER BY id LIMIT 1`;
        if (!u) return;
        const codigo = async (q: () => Promise<unknown>) => {
          try { await tx.savepoint(async () => { await q(); }); return 'ok'; } catch (e) { return (e as { code?: string }).code; }
        };
        expect(await codigo(() => tx`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia, usados) VALUES (${u.id}, '2026-01-01', 0)`)).toBe('ok');
        expect(await codigo(() => tx`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia, usados) VALUES (${u.id}, '2026-01-01', 0)`)).toBe('23505');
        expect(await codigo(() => tx`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia, usados) VALUES (${u.id}, '2026-01-02', -1)`)).toBe('23514');
        expect(await codigo(() => tx`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia) VALUES (-1, '2026-01-03')`)).toBe('23503');
      });
    } finally {
      await sql.end();
    }
  });

  it('consultas reales: AC1, AC2, AC4, AC5, tope 0 (AC9) y purga a 90 días (AC8)', async () => {
    const ROLLBACK = new Error('rollback');
    const sql = abrirBase();
    try {
      await drizzle(sql).transaction(async (tx) => {
        await tx.execute(sqlDrizzle.raw(SQL_0247));
        const [u] = await tx.execute(sqlDrizzle`SELECT id FROM users ORDER BY id LIMIT 1`);
        if (!u) throw ROLLBACK;
        const uid = Number(u.id);
        const c = tx as unknown as ConexionCupo;
        await tx.execute(sqlDrizzle`DELETE FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid}`);

        // AC9: con tope 0 nunca concede y ni siquiera crea la fila.
        const cero = await reservarCupoIa(uid, { conexion: c, tope: 0, ahora: D_2359 });
        expect(cero).toMatchObject({ concedida: false, motivo: 'tope-alcanzado', usados: 0, tope: 0, restantes: 0 });

        // AC1: 29 usados + 1 → 30, restantes 0.
        await tx.execute(sqlDrizzle`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia, usados) VALUES (${uid}, '2026-10-22', 29)`);
        const r = await reservarCupoIa(uid, { conexion: c, tope: 30, ahora: D_2359 });
        expect(r).toEqual({ concedida: true, dia: '2026-10-22', usados: 30, tope: 30, restantes: 0 });

        // AC2: con 30 no reserva y el contador no cambia.
        const [antes] = await tx.execute(sqlDrizzle`SELECT actualizado_en FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid} AND dia = '2026-10-22'`);
        const r2 = await reservarCupoIa(uid, { conexion: c, tope: 30, ahora: D_2359 });
        expect(r2).toMatchObject({ concedida: false, motivo: 'tope-alcanzado', usados: 30, restantes: 0 });
        const [despues] = await tx.execute(sqlDrizzle`SELECT usados, actualizado_en FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid} AND dia = '2026-10-22'`);
        expect(Number(despues!.usados)).toBe(30);
        expect(String(despues!.actualizado_en)).toBe(String(antes!.actualizado_en));

        // AC5: a las 00:00 de D+1 en Bogotá se concede y el contador de D+1 vale 1.
        const r3 = await reservarCupoIa(uid, { conexion: c, tope: 30, ahora: D1_0000 });
        expect(r3).toEqual({ concedida: true, dia: '2026-10-23', usados: 1, tope: 30, restantes: 29 });

        // AC4: devolver el día D (reservado antes de medianoche) baja D, no D+1; nunca bajo 0.
        expect(await devolverCupoIa(uid, r.dia, { conexion: c })).toBe(true);
        expect(await consultarCupoIa(uid, { conexion: c, tope: 30, ahora: D_2359 })).toEqual({ usados: 29, tope: 30, restantes: 1 });
        expect(await consultarCupoIa(uid, { conexion: c, tope: 30, ahora: D1_0000 })).toEqual({ usados: 1, tope: 30, restantes: 29 });
        expect(await devolverCupoIa(uid, '2026-10-23', { conexion: c })).toBe(true);
        expect(await devolverCupoIa(uid, '2026-10-23', { conexion: c })).toBe(false);
        expect(await consultarCupoIa(uid, { conexion: c, tope: 30, ahora: D1_0000 })).toMatchObject({ usados: 0 });
        expect(await devolverCupoIa(uid, '2020-01-01', { conexion: c })).toBe(false);   // sin fila: no crea nada

        // AC8: purga a 90 días por `dia` (hoy Bogotá 2026-10-22 → corte 2026-07-24).
        await tx.execute(sqlDrizzle`INSERT INTO flito_drflit_cupo_ia (usuario_id, dia, usados)
          VALUES (${uid}, '2026-07-23', 3), (${uid}, '2026-07-24', 4)`);
        const p = await ejecutarPurgaCupoIaDrFlit({ ahora: D_2359, conexion: tx as never });
        expect(p.corte).toBe('2026-07-24');
        const dias = await tx.execute(sqlDrizzle`SELECT dia::text AS dia FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid} ORDER BY dia`);
        expect(dias.map((f) => f.dia)).toEqual(['2026-07-24', '2026-10-22', '2026-10-23']);
        expect(p.borrados).toBeGreaterThanOrEqual(1);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await sql.end();
    }
  });
});

describe.skipIf(!URL_BASE)('0247 — AC3 concurrencia (dos conexiones, esquema desechable)', () => {
  it('tope 1, dos reservas simultáneas → una sola se concede y el contador queda en 1', async () => {
    const esquema = `t0247_${process.pid}_${Date.now()}`;
    const admin = postgres(URL_BASE!, { max: 1, onnotice: () => {} });
    const abrir = () => postgres(URL_BASE!, { max: 1, onnotice: () => {}, connection: { search_path: `${esquema}, public` } });
    const a = abrir();
    const b = abrir();
    try {
      await admin.unsafe(`CREATE SCHEMA ${esquema}`);
      await a.unsafe(SQL_0247);
      const [u] = await a`SELECT id FROM users ORDER BY id LIMIT 1`;
      if (!u) return;
      const uid = Number(u.id);
      const ca = drizzle(a) as unknown as ConexionCupo;
      const cb = drizzle(b) as unknown as ConexionCupo;

      // 1) Simultáneas de verdad: las dos salen a la vez.
      const rs = await Promise.all([
        reservarCupoIa(uid, { conexion: ca, tope: 1, ahora: D_2359 }),
        reservarCupoIa(uid, { conexion: cb, tope: 1, ahora: D_2359 }),
      ]);
      expect(rs.filter((r) => r.concedida)).toHaveLength(1);
      const [f1] = await a`SELECT usados FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid} AND dia = '2026-10-22'`;
      expect(Number(f1!.usados)).toBe(1);

      // 2) Intercalado determinista: A reserva dentro de una tx abierta; B choca con la fila sin confirmar,
      //    espera el bloqueo y, al confirmar A, re-evalúa el WHERE y NO concede.
      let pb: Promise<Awaited<ReturnType<typeof reservarCupoIa>>> | undefined;
      await drizzle(a).transaction(async (tx) => {
        const ra = await reservarCupoIa(uid, { conexion: tx as unknown as ConexionCupo, tope: 1, ahora: D1_0000 });
        expect(ra.concedida).toBe(true);
        pb = reservarCupoIa(uid, { conexion: cb, tope: 1, ahora: D1_0000 });
        await new Promise((r) => setTimeout(r, 250));
      });
      const rb = await pb!;
      expect(rb).toMatchObject({ concedida: false, usados: 1, restantes: 0 });
      const [f2] = await a`SELECT usados FROM flito_drflit_cupo_ia WHERE usuario_id = ${uid} AND dia = '2026-10-23'`;
      expect(Number(f2!.usados)).toBe(1);
    } finally {
      await a.end();
      await b.end();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`);
      await admin.end();
    }
  });
});
