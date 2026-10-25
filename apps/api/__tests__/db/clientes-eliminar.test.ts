// HU #13954 (Feature #13943, Épica #13671) — Eliminar un cliente inactivo sin procesos abiertos ni saldo de bolsa.
//
// Contra PostgreSQL de verdad, dentro de una transacción con ROLLBACK (`base-en-tx.ts`); se SALTA sin
// TEST_DATABASE_URL. Mismo truco que `clientes-eliminados-excluidos.test.ts`: `db` es un Drizzle sobre la transacción
// del test y `db.transaction(fn)` ejecuta `fn` sobre él. El seguro anti-bloqueo y la bitácora de permisos corren de
// verdad (mecanismo de la HU #12089).
//
// Cubre AC1 (baja lógica del cliente y de sus usuarios), AC2/AC3/AC4 (el primer motivo y nada cambia), AC5 (impacto),
// AC6 (los usuarios quedan con lo que el login y la reactivación ya rechazan: `deleted_at` y `active = false`), AC9
// (un movimiento confirmado ANTES del bloqueo cuenta) y AC10 (inexistente / ya eliminado). La ruta (403, mapeo HTTP,
// auditoría enmascarada, carrera AC8) vive en `services/clients-eliminar.routes.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(actual.db);
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const { eliminarCliente, impactoCliente, ClienteNoEliminableError, ClienteNoEncontradoError } =
  await import('../../src/modules/clients/clients.service.js');

type Tx = postgres.TransactionSql;

interface Semilla { activo?: boolean; saldo?: number | null; soatSolicitado?: boolean; liquidacionLiquidada?: boolean }

async function sembrar(tx: Tx, s: Semilla = {}) {
  const [c] = await tx`INSERT INTO clients (name, active) VALUES ('Transportes HU13954', ${s.activo ?? false}) RETURNING id`;
  const [otro] = await tx`INSERT INTO clients (name) VALUES ('Otro HU13954') RETURNING id`;
  const id = c!.id as number;
  const vehiculo = async () => (await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
  if (s.soatSolicitado) {
    await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado)
      VALUES (${id}, ${await vehiculo()}, 'VINHU13954S1', 'solicitado'::flito_soat_estado)`;
  }
  if (s.liquidacionLiquidada) {
    const [t] = await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, estado)
      VALUES ('HU13954-1', now(), ${await vehiculo()}, ${id}, 'entregado'::flito_tramite_estado) RETURNING id`;
    await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, total, base_gmf, valor_gmf) VALUES (${t!.id}, 'liquidado', 0, 0, 0)`;
  }
  if (s.saldo !== null) await tx`INSERT INTO flito_bolsas (compania_id, saldo) VALUES (${id}, ${s.saldo ?? 0})`;
  // Un rol distinto de `admin`: los usuarios del cliente no son la población administradora.
  const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE codigo <> 'admin' ORDER BY codigo LIMIT 1`;
  const usuario = async (n: string, compania: number, baja = false) =>
    (await tx`INSERT INTO users (username, name, password_hash, role, compania_id, active, deleted_at)
      VALUES (${'hu13954_' + n}, 'X', 'h', ${rol!.codigo}, ${compania}, true, CASE WHEN ${baja} THEN now() END)
      RETURNING id`)[0]!.id as number;
  const u1 = await usuario('a', id);
  const u2 = await usuario('b', id);
  const uBaja = await usuario('c', id, true);
  const uOtro = await usuario('d', otro!.id as number);
  const [admin] = await tx`SELECT id, username, role FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY id LIMIT 1`;
  const actor = { userId: (admin?.id as number | undefined) ?? null, email: null, rol: 'admin' };
  return { id, u1, u2, uBaja, uOtro, actor };
}

async function conBase(s: Semilla, fn: (tx: Tx, f: Awaited<ReturnType<typeof sembrar>>) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx, await sembrar(tx, s));
    });
  } finally {
    actual.db = null;
    await sql.end();
  }
}

/** Lo que no debe cambiar cuando la eliminación se rechaza. */
const fotografia = async (tx: Tx, f: { id: number; u1: number; u2: number }) => ({
  cliente: await tx`SELECT active, deleted_at, deleted_by FROM clients WHERE id = ${f.id}`,
  usuarios: await tx`SELECT id, active, deleted_at, session_invalidated_at FROM users WHERE id IN (${f.u1}, ${f.u2}) ORDER BY id`,
});

async function rechazo(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('se esperaba un rechazo');
}

describe.skipIf(!URL_BASE)('eliminarCliente — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1/AC6: inactivo, sin procesos, bolsa en $0 y 2 usuarios → baja lógica del cliente y de sus 2 usuarios', async () => {
    await conBase({}, async (tx, f) => {
      const r = await eliminarCliente(f.id, f.actor);
      expect(r.id).toBe(f.id);
      expect(r.name).toBe('Transportes HU13954');
      expect([...r.usuariosDadosDeBaja].sort()).toEqual([f.u1, f.u2].sort());

      const [c] = await tx`SELECT deleted_at IS NOT NULL AS eliminado, deleted_by FROM clients WHERE id = ${f.id}`;
      expect(c).toEqual({ eliminado: true, deleted_by: f.actor.userId });
      expect(await tx`SELECT count(*)::int AS n FROM clients WHERE id = ${f.id}`).toEqual([{ n: 1 }]); // nunca DELETE

      const usuarios = await tx`SELECT id, active, deleted_at IS NOT NULL AS baja, deleted_by,
          session_invalidated_at IS NOT NULL AS invalidada FROM users WHERE id IN (${f.u1}, ${f.u2}, ${f.uOtro}) ORDER BY id`;
      const esperado = [
        { id: f.u1, active: false, baja: true, deleted_by: f.actor.userId, invalidada: true },
        { id: f.u2, active: false, baja: true, deleted_by: f.actor.userId, invalidada: true },
        { id: f.uOtro, active: true, baja: false, deleted_by: null, invalidada: false },
      ].sort((a, b) => a.id - b.id);
      expect(usuarios).toEqual(esperado);
      // Mismo rastro que la baja individual (HU #12089): una fila por usuario dado de baja.
      const [bit] = await tx`SELECT count(*)::int AS n FROM permisos_auditoria
        WHERE accion = 'baja' AND usuario_afectado_id IN (${f.u1}, ${f.u2})`;
      expect(bit!.n).toBe(2);
      // RN-CLI-9: ya eliminado → el impacto lo trata como inexistente.
      expect(await impactoCliente(actual.db!, f.id)).toBeNull();
    });
  });

  it('AC2/AC5: activo (y con saldo) → «Primero debe desactivarlo.»; el impacto dice lo mismo; nada cambia', async () => {
    await conBase({ activo: true, saldo: 50000 }, async (tx, f) => {
      expect(await impactoCliente(actual.db!, f.id)).toMatchObject({
        puedeEliminar: false, motivoNoEliminable: 'Primero debe desactivarlo.',
      });
      const antes = await fotografia(tx, f);
      const e = await rechazo(eliminarCliente(f.id, f.actor));
      expect(e).toBeInstanceOf(ClienteNoEliminableError);
      expect(e.message).toBe('Primero debe desactivarlo.');
      expect(await fotografia(tx, f)).toEqual(antes);
    });
  });

  it('AC3: inactivo con 1 SOAT solicitado y 1 liquidación liquidada → «Tiene 2 procesos abiertos (…)»', async () => {
    await conBase({ soatSolicitado: true, liquidacionLiquidada: true }, async (tx, f) => {
      const antes = await fotografia(tx, f);
      const e = await rechazo(eliminarCliente(f.id, f.actor));
      expect(e).toBeInstanceOf(ClienteNoEliminableError);
      expect(e.message).toBe('Tiene 2 procesos abiertos (SOAT: 1, impuestos: 0, trámites: 0, liquidaciones: 1).');
      expect(await fotografia(tx, f)).toEqual(antes);
    });
  });

  it('AC4: inactivo, sin procesos y bolsa en -$20.000 → mensaje de saldo; nada cambia', async () => {
    await conBase({ saldo: -20000 }, async (tx, f) => {
      expect(await impactoCliente(actual.db!, f.id)).toMatchObject({
        puedeEliminar: false, motivoNoEliminable: 'Su bolsa tiene saldo de -$20.000; debe quedar en cero.',
      });
      const antes = await fotografia(tx, f);
      const e = await rechazo(eliminarCliente(f.id, f.actor));
      expect(e).toBeInstanceOf(ClienteNoEliminableError);
      expect(e.message).toBe('Su bolsa tiene saldo de -$20.000; debe quedar en cero.');
      expect(await fotografia(tx, f)).toEqual(antes);
    });
  });

  it('AC9: un movimiento que deja el saldo ≠ 0 y confirma antes del bloqueo → rechazo por saldo', async () => {
    await conBase({}, async (tx, f) => {
      expect(await impactoCliente(actual.db!, f.id)).toMatchObject({ puedeEliminar: true, motivoNoEliminable: null });
      await tx`UPDATE flito_bolsas SET saldo = saldo + 15000 WHERE compania_id = ${f.id}`;
      const e = await rechazo(eliminarCliente(f.id, f.actor));
      expect(e).toBeInstanceOf(ClienteNoEliminableError);
      expect(e.message).toBe('Su bolsa tiene saldo de $15.000; debe quedar en cero.');
    });
  });

  it('sin bolsa cuenta como saldo 0 y se puede eliminar', async () => {
    await conBase({ saldo: null }, async (_tx, f) => {
      expect(await impactoCliente(actual.db!, f.id)).toMatchObject({ saldoBolsa: 0, puedeEliminar: true });
      await expect(eliminarCliente(f.id, f.actor)).resolves.toMatchObject({ id: f.id });
    });
  });

  it('AC10: inexistente → ClienteNoEncontradoError; ya eliminado → ClienteNoEncontradoError', async () => {
    await conBase({}, async (_tx, f) => {
      await expect(eliminarCliente(2_000_000_000, f.actor)).rejects.toBeInstanceOf(ClienteNoEncontradoError);
      await eliminarCliente(f.id, f.actor);
      await expect(eliminarCliente(f.id, f.actor)).rejects.toBeInstanceOf(ClienteNoEncontradoError);
    });
  });
});
