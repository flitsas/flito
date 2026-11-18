// HU #14148 (Feature #14089) — conteo, impacto y baja de proveedores de logística, contra PostgreSQL de
// verdad dentro de una transacción con ROLLBACK (se SALTA sin TEST_DATABASE_URL). Las migraciones 0278/0279 se aplican
// DENTRO de la transacción (idempotentes) porque la base local compartida puede no tenerlas.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, sembrarAdminActivo, URL_BASE } from '../helpers/base-en-tx.js';

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

const { impactoProveedorLogistica } =
  await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica-gestion.service.js');
const { eliminarProveedor, ProveedorNoEliminableError } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js');
const { ProveedorNoEncontradoError, listarProveedores } = await import('../../src/modules/flito-parametrizacion/flito-proveedores.service.js');
const { cambiarEstadoProveedor } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const ACTOR = { userId: null, email: null, rol: null };
const { ProveedorLogisticaAsignadoError } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');
const { ProveedorLogisticaNoEncontradoError, listarProveedoresLogistica } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.service.js');

type Tx = postgres.TransactionSql;

async function conBase(fn: (tx: Tx) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      await tx.unsafe(leerMigracion('0278_flito_proveedores_logistica_nit_contacto.sql'));
      await tx.unsafe(leerMigracion('0279_flito_clients_proveedor_logistica.sql'));
      await sembrarAdminActivo(tx);
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx);
    });
  } finally { actual.db = null; await sql.end(); }
}

const provLog = async (tx: Tx, nombre: string, activo = true) =>
  (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
    VALUES (${nombre}, ${activo}, ${'9' + Math.floor(Math.random() * 1e9)}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
const cliente = async (tx: Tx, nombre: string, o: { logistica?: string; soat?: string; autogestionable?: boolean; baja?: boolean } = {}) =>
  (await tx`INSERT INTO clients (name, flito_proveedor_logistica_id, flito_proveedor_soat_sin_tramite_id, logistica_autogestionable, deleted_at)
    VALUES (${nombre}, ${o.logistica ?? null}, ${o.soat ?? null}, ${o.autogestionable ?? false}, CASE WHEN ${o.baja ?? false} THEN now() END)
    RETURNING id`)[0]!.id as number;
async function rechazo(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('se esperaba un rechazo');
}

describe.skipIf(!URL_BASE)('proveedores de logística — gestión (PostgreSQL, tx con ROLLBACK)', () => {
  it('la lista cuenta la compañía con logística apagada que conserva el proveedor y excluye las eliminadas (antes RN-PROVU-1)', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'ZZ Logistica HU14148');
      await cliente(tx, 'Cia encendida HU14148', { logistica: pl });
      await cliente(tx, 'Cia apagada HU14148', { logistica: pl, autogestionable: true });
      await cliente(tx, 'Cia baja HU14148', { logistica: pl, baja: true });
      const fila = (await listarProveedores()).find((p: { id: string }) => p.id === pl);
      expect(fila.companiasPorServicio).toEqual({ logistica: 2 });
      expect(fila.servicios).toEqual(['logistica']);
    });
  });

  it('impacto: total real y MÁXIMO 3 nombres alfabéticos; no cuenta eliminadas; cuenta apagadas con proveedor', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'Impacto HU14148');
      for (const n of ['D', 'B', 'A', 'C']) await cliente(tx, `${n} Cia HU14148`, { logistica: pl });
      await cliente(tx, 'E Cia HU14148', { logistica: pl, autogestionable: true });
      await cliente(tx, '0 Eliminada HU14148', { logistica: pl, baja: true });
      expect(await impactoProveedorLogistica(pl)).toEqual({
        companias: 5, nombres: ['A Cia HU14148', 'B Cia HU14148', 'C Cia HU14148'],
      });
      const solo2 = await provLog(tx, 'Dos HU14148');
      await cliente(tx, 'X HU14148', { logistica: solo2 }); await cliente(tx, 'Y HU14148', { logistica: solo2 });
      expect(await impactoProveedorLogistica(solo2)).toEqual({ companias: 2, nombres: ['X HU14148', 'Y HU14148'] });
      expect(await impactoProveedorLogistica(await provLog(tx, 'Vacio HU14148'))).toEqual({ companias: 0, nombres: [] });
      expect(await rechazo(impactoProveedorLogistica('00000000-0000-4000-8000-000000000000'))).toBeInstanceOf(ProveedorLogisticaNoEncontradoError);
    });
  });

  it('inactivar sigue bloqueado con compañías asignadas, también con la logística apagada (409)', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'Inactivar HU14148');
      await cliente(tx, 'Cia inactivar HU14148', { logistica: pl, autogestionable: true });
      const [{ version }] = await tx`SELECT version FROM flito_proveedores WHERE id = ${pl}` as unknown as { version: number }[];
      expect(await rechazo(cambiarEstadoProveedor(pl, { activo: false, versionEsperada: version }, ACTOR))).toBeInstanceOf(ProveedorLogisticaAsignadoError);
      expect((await tx`SELECT activo FROM flito_proveedores_logistica WHERE id = ${pl}`)[0]!.activo).toBe(true);
    });
  });

  // HU #14334 (AC8): ya no hay borrado físico. La regla unificada exige además que esté inactivo.
  it('eliminar: activo → 409; con compañías vigentes → 409 y no cambia; sin ellas → baja lógica y conserva la fila', async () => {
    await conBase(async (tx) => {
      const activo = await provLog(tx, 'Activo HU14148');
      expect((await rechazo(eliminarProveedor(activo, ACTOR))).message).toBe('Primero debe desactivarlo.');

      const pl = await provLog(tx, 'Eliminar HU14148', false);
      await cliente(tx, 'Cia eliminar HU14148', { logistica: pl, autogestionable: true });
      const e = await rechazo(eliminarProveedor(pl, ACTOR));
      expect(e).toBeInstanceOf(ProveedorNoEliminableError);
      expect(e.message).toContain('1 compañía asignada');
      expect((await tx`SELECT deleted_at FROM flito_proveedores_logistica WHERE id = ${pl}`)[0]!.deleted_at).toBeNull();

      const libre = await provLog(tx, 'Libre HU14148', false);
      expect(await eliminarProveedor(libre, ACTOR)).toMatchObject({ id: libre, nombre: 'Libre HU14148' });
      const [fila] = await tx`SELECT deleted_at IS NOT NULL AS baja, nit, contacto, telefono FROM flito_proveedores_logistica WHERE id = ${libre}`;
      expect(fila).toEqual({ baja: true, nit: null, contacto: null, telefono: null });
      expect(await rechazo(eliminarProveedor(libre, ACTOR))).toBeInstanceOf(ProveedorNoEncontradoError);
      expect((await listarProveedoresLogistica()).map((p: { id: string }) => p.id)).not.toContain(libre);
      expect(await rechazo(impactoProveedorLogistica(libre))).toBeInstanceOf(ProveedorLogisticaNoEncontradoError);
    });
  });

  it('eliminar: una compañía ELIMINADA lógicamente que aún lo referencia no bloquea; la fila se conserva con baja lógica', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'EnUso HU14148', false);
      await cliente(tx, 'Baja HU14148', { logistica: pl, baja: true });
      await eliminarProveedor(pl, ACTOR);
      expect((await tx`SELECT deleted_at IS NOT NULL AS baja FROM flito_proveedores_logistica WHERE id = ${pl}`)[0]!.baja).toBe(true);
    });
  });
});
