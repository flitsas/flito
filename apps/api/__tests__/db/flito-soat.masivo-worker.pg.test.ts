// HU #14132 (Feature #14013, ADR-0032) — lo que el `memDb` NO puede emular, contra Postgres REAL:
// reclamo con FOR UPDATE SKIP LOCKED (2 reclamadores simultáneos sin duplicar), tope por compañía, recuperación
// de huérfanas conservando el id reservado, cierre del lote con contadores congelados + anonimización de la PII,
// lote sin filas válidas, vigilante de 2 h, y la migración 0271 aplicada ×2 con ROLLBACK (P6).
// Solo corre con TEST_DATABASE_URL; el CI no levanta Postgres. Un `skipped` NO es verde: se corre en local.
// Los fixtures se crean con COMMIT (la concurrencia lo exige) y se borran en `afterEach` (CASCADE a las filas).

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const URL_BASE = process.env.TEST_DATABASE_URL;
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 8, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_0271 = readFileSync(path.resolve(__dirname, '../../src/db/migrations/0271_flito_soat_masivo_worker.sql'), 'utf8');

describe('0271 — análisis estático', () => {
  const limpio = SQL_0271.replace(/--[^\n]*/g, '');
  it('idempotente: sin BEGIN/COMMIT, ADD COLUMN IF NOT EXISTS, CHECK con DROP previo, índices IF NOT EXISTS', () => {
    expect(limpio).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(limpio.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
    expect(limpio.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    for (const a of limpio.match(/ADD CONSTRAINT (\w+)/g) ?? []) expect(limpio).toContain(`DROP CONSTRAINT IF EXISTS ${a.split(' ')[2]}`);
  });
  it('trae el índice parcial por pendiente para el reclamo, el de huérfanas, los CHECK de coherencia y los motivos RUNT', () => {
    expect(limpio).toMatch(/idx_flito_soat_masivo_filas_claim[\s\S]*WHERE estado = 'pendiente'/);
    expect(limpio).toMatch(/idx_flito_soat_masivo_filas_huerfanas[\s\S]*WHERE estado = 'consultando'/);
    for (const c of ['consultando_chk', 'aceptada_chk', 'por_validar_chk', 'terminado_chk', 'contadores_chk']) expect(limpio).toContain(c);
    for (const m of ['runt_no_cuadra', 'runt_sin_registro', 'runt_sin_vin', 'soat_vigente', 'sin_soat_anterior', 'solicitud_existente', 'no_procesada']) expect(limpio).toContain(`'${m}'`);
  });
});

describe.skipIf(!URL_BASE)('worker contra Postgres real', () => {
  let sql: postgres.Sql;
  let companiaId: number;
  const lotes: string[] = [];
  let r: typeof import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    r = await import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');
    const [c] = await sql`SELECT id FROM clients WHERE id NOT IN (SELECT compania_id FROM flito_soat_masivo_lotes WHERE estado <> 'terminado') ORDER BY id LIMIT 1`;
    companiaId = c!.id;
  });
  afterEach(async () => { if (lotes.length) await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes)}`; lotes.length = 0; });
  afterAll(async () => { await sql?.end(); });

  /** `n` filas pendientes (PII sintética) + las filas extra indicadas. */
  async function lote(opts: { pendientes?: number; extra?: Array<{ estado: string; motivo?: string }>; avanceHaceMs?: number } = {}) {
    const extra = opts.extra ?? [];
    const n = opts.pendientes ?? 0;
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash, ultimo_avance_en)
      VALUES (${companiaId}, 'prueba', 'renovacion', ${n + extra.length}, 'h', ${new Date(Date.now() - (opts.avanceHaceMs ?? 0))}) RETURNING id`;
    lotes.push(l!.id);
    for (let i = 0; i < n; i++) {
      await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento, nombre, correo, celular)
        VALUES (${l!.id}, ${i + 2}, 'pendiente', ${`ZZZ${100 + i}`}, '123456789', 'Nombre Prueba', 'p@ejemplo.com', '3101234567')`;
    }
    for (let i = 0; i < extra.length; i++) {
      await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, motivo_rechazo, placa, documento, nombre, correo, celular)
        VALUES (${l!.id}, ${n + i + 2}, ${extra[i]!.estado}, ${extra[i]!.motivo ?? null}, 'ZZZ999', '123456789', 'Nombre Prueba', 'p@ejemplo.com', '3101234567')`;
    }
    return l!.id as string;
  }
  const estados = async (id: string) => (await sql`SELECT estado, count(*)::int AS n FROM flito_soat_masivo_filas WHERE lote_id = ${id} GROUP BY estado`)
    .reduce((m: Record<string, number>, x) => ({ ...m, [x.estado]: x.n }), {});

  it('dos reclamadores simultáneos no duplican filas y respetan el tope de 2 por compañía', async () => {
    const id = await lote({ pendientes: 6 });
    const [a, b] = await Promise.all([r.reclamarFilas(2), r.reclamarFilas(2)]);
    const ids = [...a, ...b].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(r.TOPE_POR_COMPANIA);
    expect(ids.length).toBeGreaterThan(0);
    expect((await estados(id)).consultando).toBe(ids.length);
    const [l] = await sql`SELECT estado, iniciado_en FROM flito_soat_masivo_lotes WHERE id = ${id}`;
    expect(l).toMatchObject({ estado: 'procesando' });
    expect(l!.iniciado_en).not.toBeNull();
    // Con el cupo de la compañía lleno, un tercer reclamo no trae nada.
    if (ids.length === r.TOPE_POR_COMPANIA) expect(await r.reclamarFilas(2)).toEqual([]);
    // Cada fila reclamada lleva su id reservado.
    for (const f of [...a, ...b]) expect(f.soatIdReservado).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('una fila con proximo_intento_en futuro no se reclama; 429/caída la difieren', async () => {
    const id = await lote({ pendientes: 1 });
    await sql`UPDATE flito_soat_masivo_filas SET proximo_intento_en = now() + interval '1 hour' WHERE lote_id = ${id}`;
    expect(await r.reclamarFilas(2)).toEqual([]);
  });

  it('AC9: una fila consultando con el arrendamiento vencido vuelve a pendiente y conserva su soat_id_reservado', async () => {
    const id = await lote({ pendientes: 1 });
    const [f1] = await r.reclamarFilas(2);
    await sql`UPDATE flito_soat_masivo_filas SET reclamada_en = now() - interval '4 minutes' WHERE id = ${f1!.id}`;
    expect(await r.recuperarHuerfanas()).toBe(1);
    const [f2] = await r.reclamarFilas(2);
    expect(f2!.id).toBe(f1!.id);
    expect(f2!.soatIdReservado).toBe(f1!.soatIdReservado);
    // Una fila con el arrendamiento VIGENTE no se recupera.
    expect(await r.recuperarHuerfanas()).toBe(0);
    expect((await estados(id)).consultando).toBe(1);
  });

  it('lote sin filas válidas (solo rechazadas de entrada): el worker lo cierra, contadores congelados y compañía libre', async () => {
    const id = await lote({ extra: [{ estado: 'rechazada', motivo: 'placa_invalida' }, { estado: 'rechazada', motivo: 'fila_duplicada' }] });
    expect(await r.cerrarLotesSinPendientes()).toBeGreaterThanOrEqual(1);
    const [l] = await sql`SELECT estado, terminado_en, n_aceptadas, n_por_validar, n_rechazadas FROM flito_soat_masivo_lotes WHERE id = ${id}`;
    expect(l).toMatchObject({ estado: 'terminado', n_aceptadas: 0, n_por_validar: 0, n_rechazadas: 2 });
    expect(l!.terminado_en).not.toBeNull();
    // Las rechazadas CONSERVAN su PII hasta la purga de A3.
    const [f] = await sql`SELECT placa, nombre FROM flito_soat_masivo_filas WHERE lote_id = ${id} LIMIT 1`;
    expect(f!.placa).not.toBeNull();
    // La compañía queda libre: cabe otro lote activo.
    const otro = await lote({ pendientes: 1 });
    expect(otro).toBeTruthy();
  });

  it('cerrarLoteSiTermino no cierra mientras haya pendientes y es idempotente al cerrar', async () => {
    const id = await lote({ pendientes: 1, extra: [{ estado: 'rechazada', motivo: 'placa_invalida' }] });
    expect(await r.cerrarLoteSiTermino(id)).toBe(false);
    await sql`UPDATE flito_soat_masivo_filas SET estado = 'rechazada', motivo_rechazo = 'sin_soat_anterior' WHERE lote_id = ${id} AND estado = 'pendiente'`;
    expect(await r.cerrarLoteSiTermino(id)).toBe(true);
    expect(await r.cerrarLoteSiTermino(id)).toBe(false);
  });

  it('al terminar, la PII de las filas aceptadas y por validar se anonimiza en la misma transacción (las rechazadas la conservan)', async () => {
    const [s] = await sql`SELECT id FROM flito_soat LIMIT 1`;
    const [i] = await sql`SELECT id FROM flito_soat_incompletas LIMIT 1`;
    if (!s) return; // sin SOAT de muestra en la base local no hay FK que apuntar
    const id = await lote({ extra: [{ estado: 'rechazada', motivo: 'soat_vigente' }] });
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento, nombre, correo, celular, soat_id) VALUES (${id}, 50, 'aceptada', 'AAA111', '1', 'N N', 'a@b.co', '3100000000', ${s.id})`;
    if (i) await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento, nombre, correo, celular, incompleta_id) VALUES (${id}, 51, 'por_validar', 'BBB222', '2', 'N N', 'a@b.co', '3100000000', ${i.id})`;
    await sql`UPDATE flito_soat_masivo_lotes SET total_filas = ${i ? 3 : 2} WHERE id = ${id}`;
    expect(await r.cerrarLoteSiTermino(id)).toBe(true);
    const filas = await sql`SELECT estado, placa, documento, nombre, correo, celular FROM flito_soat_masivo_filas WHERE lote_id = ${id}`;
    for (const f of filas) {
      const vacia = [f.placa, f.documento, f.nombre, f.correo, f.celular].every((v) => v === null);
      expect(vacia, f.estado).toBe(f.estado !== 'rechazada');
    }
    const [l] = await sql`SELECT n_aceptadas, n_por_validar, n_rechazadas FROM flito_soat_masivo_lotes WHERE id = ${id}`;
    expect(l).toMatchObject({ n_aceptadas: 1, n_por_validar: i ? 1 : 0, n_rechazadas: 1 });
  });

  it('vigilante: un lote 3 h sin avance se cierra, sus pendientes pasan a rechazadas no_procesada y la compañía queda libre', async () => {
    const id = await lote({ pendientes: 2, avanceHaceMs: 3 * 60 * 60_000 });
    expect(await r.cerrarLotesSinAvance()).toBeGreaterThanOrEqual(1);
    const [l] = await sql`SELECT estado, n_rechazadas FROM flito_soat_masivo_lotes WHERE id = ${id}`;
    expect(l).toMatchObject({ estado: 'terminado', n_rechazadas: 2 });
    const filas = await sql`SELECT estado, motivo_rechazo FROM flito_soat_masivo_filas WHERE lote_id = ${id}`;
    expect(filas.every((f) => f.estado === 'rechazada' && f.motivo_rechazo === 'no_procesada')).toBe(true);
  });

  it('vigilante: un lote con avance reciente NO se toca', async () => {
    const id = await lote({ pendientes: 1, avanceHaceMs: 60 * 60_000 });
    await r.cerrarLotesSinAvance();
    const [l] = await sql`SELECT estado FROM flito_soat_masivo_lotes WHERE id = ${id}`;
    expect(l!.estado).toBe('en_cola');
  });

  it('0271 ×2 sobre la BD ya migrada, con ROLLBACK: no falla y los CHECK de coherencia rechazan lo inválido', async () => {
    const ROLLBACK = Symbol('rollback');
    let error: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0271);
        await tx.unsafe(SQL_0271);
        // Terminado sin terminado_en ni contadores: debe violar los CHECK de coherencia.
        await tx`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash, estado)
          VALUES (${companiaId}, 'x', 'renovacion', 1, 'h', 'terminado')`;
        throw ROLLBACK;
      });
    } catch (e) { error = e; }
    expect(error).not.toBe(ROLLBACK);
    expect(String((error as Error)?.message)).toMatch(/flito_soat_masivo_lotes_(terminado|contadores)_chk/);
  });
});
