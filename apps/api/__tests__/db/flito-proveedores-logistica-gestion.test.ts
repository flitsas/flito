// HU #14148 (Feature #14089) — listado unificado, impacto y baja de proveedores de logística, contra PostgreSQL de
// verdad dentro de una transacción con ROLLBACK (se SALTA sin TEST_DATABASE_URL). Las migraciones 0277/0278 se aplican
// DENTRO de la transacción (idempotentes) porque la base local compartida puede no tenerlas.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

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

const { listarProveedoresUnificados, impactoProveedorLogistica, eliminarProveedorLogistica, ProveedorLogisticaEnUsoError } =
  await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica-gestion.service.js');
const { ProveedorLogisticaAsignadoError } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');
const { ProveedorLogisticaNoEncontradoError } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.service.js');

type Tx = postgres.TransactionSql;

async function conBase(fn: (tx: Tx) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      await tx.unsafe(leerMigracion('0277_flito_proveedores_logistica_nit_contacto.sql'));
      await tx.unsafe(leerMigracion('0278_flito_clients_proveedor_logistica.sql'));
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
  it('listado unificado: tipo, campos y conteo; cuenta la compañía con logística apagada que conserva el proveedor; excluye eliminadas', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'ZZ Logistica HU14148');
      const ps = (await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('ZZ Soat HU14148') RETURNING id`)[0]!.id as string;
      const psEliminado = (await tx`INSERT INTO flito_proveedores_soat (nombre, deleted_at) VALUES ('ZZ Soat borrado HU14148', now()) RETURNING id`)[0]!.id as string;
      await cliente(tx, 'A1', { logistica: pl });
      await cliente(tx, 'A2', { logistica: pl, autogestionable: true }); // apagada pero conserva el proveedor: CUENTA
      await cliente(tx, 'A3', { logistica: pl, baja: true });            // eliminada: NO cuenta
      await cliente(tx, 'S1', { soat: ps });
      await cliente(tx, 'S2', { soat: ps, baja: true });                  // eliminada: NO cuenta
      await cliente(tx, 'Z1', { logistica: pl, soat: ps });                // una compañía puede tener ambos tipos

      const lista = await listarProveedoresUnificados();
      const log = lista.find((p) => p.id === pl)!;
      const soat = lista.find((p) => p.id === ps)!;
      expect(log).toMatchObject({ tipo: 'logistica', nombre: 'ZZ Logistica HU14148', activo: true, contacto: 'Ana', telefono: '3001112233', companiasAsignadas: 3 });
      expect(log.nit).toMatch(/^9\d+$/);
      expect(soat).toMatchObject({ tipo: 'soat', nombre: 'ZZ Soat HU14148', nit: null, contacto: null, telefono: null, activo: true, companiasAsignadas: 2 });
      expect(lista.find((p) => p.id === psEliminado)).toBeUndefined();
      // Un proveedor sin compañías cuenta 0 (no undefined) y ambos tipos conviven en la misma lista, ordenada por nombre.
      const sinCias = await provLog(tx, 'ZZ Sin companias HU14148', false);
      const lista2 = await listarProveedoresUnificados();
      expect(lista2.find((p) => p.id === sinCias)).toMatchObject({ companiasAsignadas: 0, activo: false });
      const nombres = lista2.map((p) => p.nombre.toLowerCase());
      expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b)));
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

  it('inactivar sigue bloqueado con compañías asignadas (409) — vía actualizarProveedorLogistica', async () => {
    await conBase(async (tx) => {
      const { actualizarProveedorLogistica } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-logistica.service.js');
      const pl = await provLog(tx, 'Inactivar HU14148');
      await cliente(tx, 'Cia inactivar HU14148', { logistica: pl, autogestionable: true });
      expect(await rechazo(actualizarProveedorLogistica(pl, { activo: false }))).toBeInstanceOf(ProveedorLogisticaAsignadoError);
      expect((await tx`SELECT activo FROM flito_proveedores_logistica WHERE id = ${pl}`)[0]!.activo).toBe(true);
    });
  });

  it('eliminar: con compañías vigentes → 409 y NO borra; sin compañías → borra; inexistente → no encontrado', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'Eliminar HU14148');
      await cliente(tx, 'Cia eliminar HU14148', { logistica: pl, autogestionable: true });
      const e = await rechazo(eliminarProveedorLogistica(pl));
      expect(e).toBeInstanceOf(ProveedorLogisticaAsignadoError);
      expect(e.message).toContain('No se puede eliminar');
      expect(await tx`SELECT 1 FROM flito_proveedores_logistica WHERE id = ${pl}`).toHaveLength(1);

      const libre = await provLog(tx, 'Libre HU14148');
      expect(await eliminarProveedorLogistica(libre)).toEqual({ id: libre, nombre: 'Libre HU14148' });
      expect(await tx`SELECT 1 FROM flito_proveedores_logistica WHERE id = ${libre}`).toHaveLength(0);
      expect(await rechazo(eliminarProveedorLogistica(libre))).toBeInstanceOf(ProveedorLogisticaNoEncontradoError);
    });
  });

  it('eliminar: una compañía ELIMINADA lógicamente que aún lo referencia → 409 en uso (FK), nunca 500', async () => {
    await conBase(async (tx) => {
      const pl = await provLog(tx, 'EnUso HU14148');
      await cliente(tx, 'Baja HU14148', { logistica: pl, baja: true });
      expect(await rechazo(eliminarProveedorLogistica(pl))).toBeInstanceOf(ProveedorLogisticaEnUsoError);
    });
  });
});
