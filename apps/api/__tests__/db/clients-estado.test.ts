// HU #13945 (Feature #13939) — Impacto y cambio de estado de un cliente contra PostgreSQL de verdad.
//
// Todo dentro de una transacción que termina en ROLLBACK (`base-en-tx.ts`); se activa con TEST_DATABASE_URL y sin ella
// se SALTA (el CI no levanta Postgres; el contrato de la ruta lo mide `services/clients-estado.routes.test.ts`).
// El servicio usa `db` de `db/client.js`: aquí se sustituye por un Drizzle sobre la MISMA transacción, y
// `db.transaction(fn)` ejecuta `fn` sobre ella (sin anidar: el ROLLBACK del final lo deshace todo igual).
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
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

const { impactoCliente, cambiarEstadoCliente, companiaInactiva, EstadoClienteCambiadoError, ClienteNoEncontradoError } =
  await import('../../src/modules/clients/clients.service.js');

/** Un cliente con lo que el AC1 y el AC9 necesitan: lo que cuenta y lo que NO cuenta. */
async function sembrar(tx: postgres.TransactionSql) {
  const [c] = await tx`INSERT INTO clients (name) VALUES ('Transportes HU13945') RETURNING id`;
  const [otro] = await tx`INSERT INTO clients (name) VALUES ('Otro HU13945') RETURNING id`;
  const id = c!.id as number;
  const [org] = await tx`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 1`;
  const vehiculo = async () => (await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
  const soat = async (compania: number, estado: string, n: number) => {
    const v = await vehiculo();
    await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado) VALUES (${compania}, ${v}, ${'VINHU13945' + n}, ${estado}::flito_soat_estado)`;
  };
  // AC1: 3 SOAT solicitados (+1 pagado y 1 de otro cliente, que no cuentan).
  await soat(id, 'solicitado', 1); await soat(id, 'solicitado', 2); await soat(id, 'pendiente', 3);
  await soat(id, 'pagado', 4); await soat(otro!.id, 'solicitado', 5);
  const tramite = async (compania: number, estado: string | null, n: number) => {
    const v = await vehiculo();
    const [t] = await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, estado)
      VALUES (${'HU13945-' + n}, now(), ${v}, ${compania}, ${estado}::flito_tramite_estado) RETURNING id`;
    return t!.id as string;
  };
  // AC1: 2 trámites asignados; AC9: entregado y NULL no cuentan.
  const t1 = await tramite(id, 'asignado', 1);
  await tramite(id, 'asignado', 2);
  const t3 = await tramite(id, 'entregado', 3);
  const t4 = await tramite(id, null, 4);
  // Impuestos: 1 abierto (con_novedad) y 1 pagado.
  if (org) {
    await tx`INSERT INTO flito_impuestos (tramite_id, compania_id, organismo_codigo, modalidad_aplicada, estado)
      VALUES (${t1}, ${id}, ${org.codigo}, 'requiere_gestion', 'con_novedad')`;
    await tx`INSERT INTO flito_impuestos (tramite_id, compania_id, organismo_codigo, modalidad_aplicada, estado)
      VALUES (${t3}, ${id}, ${org.codigo}, 'requiere_gestion', 'pagado')`;
  }
  // Liquidaciones: 1 liquidada (cuenta) y 1 facturada (no).
  await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, total, base_gmf, valor_gmf) VALUES (${t3}, 'liquidado', 0, 0, 0)`;
  await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, total, base_gmf, valor_gmf, facturado_en) VALUES (${t4}, 'facturado', 0, 0, 0, now())`;
  await tx`INSERT INTO flito_bolsas (compania_id, saldo) VALUES (${id}, 250000.75)`;
  // Usuarios: 2 de la compañía (uno inactivo por su cuenta), 1 dado de baja (no cuenta), 1 de otra compañía.
  const [rol] = await tx`SELECT codigo FROM permisos_roles ORDER BY codigo LIMIT 1`;
  const usuario = async (n: string, compania: number, extra: { active?: boolean; baja?: boolean } = {}) =>
    (await tx`INSERT INTO users (username, name, password_hash, role, compania_id, active, deleted_at)
      VALUES (${'hu13945_' + n}, 'X', 'h', ${rol!.codigo}, ${compania}, ${extra.active ?? true}, CASE WHEN ${extra.baja === true} THEN now() END)
      RETURNING id`)[0]!.id as number;
  const u1 = await usuario('a', id);
  const u2 = await usuario('b', id, { active: false });
  await usuario('c', id, { baja: true });
  const u4 = await usuario('d', otro!.id);
  return { id, otro: otro!.id as number, conImpuestos: Boolean(org), u1, u2, u4 };
}

async function conBase(fn: (tx: postgres.TransactionSql, f: Awaited<ReturnType<typeof sembrar>>) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      // La TransactionSql de postgres-js no expone `options`, que Drizzle lee para sus parsers: se le prestan los de
      // la conexión (los mismos con los que se abrió la transacción).
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx, await sembrar(tx));
    });
  } finally {
    actual.db = null;
    await sql.end();
  }
}

describe.skipIf(!URL_BASE)('clients.service — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1/AC9: cuenta solo lo abierto de la compañía en los módulos FLITO, el saldo de su bolsa y sus usuarios sin baja; no modifica nada', async () => {
    await conBase(async (tx, f) => {
      const antes = await tx`SELECT active FROM clients WHERE id = ${f.id}`;
      const r = await impactoCliente(actual.db!, f.id);
      expect(r).toEqual({
        activo: true,
        procesosAbiertos: { soat: 3, impuestos: f.conImpuestos ? 1 : 0, tramites: 2, liquidaciones: 1 },
        saldoBolsa: 250000.75,
        usuariosAfectados: 2, // a y b (la inactiva cuenta: sigue siendo de la compañía); c tiene baja
        puedeEliminar: false,
        motivoNoEliminable: null,
      });
      expect(await tx`SELECT active FROM clients WHERE id = ${f.id}`).toEqual(antes);
    });
  });

  it('AC9: un cliente sin procesos ni bolsa ni usuarios → todo en cero; inexistente → null', async () => {
    await conBase(async (tx) => {
      const [c] = await tx`INSERT INTO clients (name) VALUES ('Vacío HU13945') RETURNING id`;
      expect(await impactoCliente(actual.db!, c!.id)).toEqual({
        activo: true, procesosAbiertos: { soat: 0, impuestos: 0, tramites: 0, liquidaciones: 0 },
        saldoBolsa: 0, usuariosAfectados: 0, puedeEliminar: false, motivoNoEliminable: null,
      });
      expect(await impactoCliente(actual.db!, 2_000_000_000)).toBeNull();
    });
  });

  it('AC2/AC5: desactivar invalida las sesiones de SUS usuarios sin tocar users.active; el login ve la compañía inactiva', async () => {
    await conBase(async (tx, f) => {
      const r = await cambiarEstadoCliente(f.id, { activo: false, activoEsperado: true });
      expect(r.active).toBe(false);
      expect(r.usuariosInvalidados).toEqual(expect.arrayContaining([f.u1, f.u2]));
      expect(r.usuariosInvalidados).not.toContain(f.u4);
      const filas = await tx`SELECT id, active, session_invalidated_at IS NOT NULL AS invalidada FROM users
        WHERE id IN (${f.u1}, ${f.u2}, ${f.u4}) ORDER BY id`;
      expect(filas).toEqual([
        { id: f.u1, active: true, invalidada: true },
        { id: f.u2, active: false, invalidada: true },
        { id: f.u4, active: true, invalidada: false },
      ].sort((a, b) => a.id - b.id));
      expect(await companiaInactiva(f.id)).toBe(true);
      expect(await companiaInactiva(f.otro)).toBe(false);
      expect(await companiaInactiva(null)).toBe(false);
    });
  });

  it('AC4/AC5: activar devuelve el cliente a activo sin reactivar al usuario inactivo por su cuenta', async () => {
    await conBase(async (tx, f) => {
      await cambiarEstadoCliente(f.id, { activo: false, activoEsperado: true });
      const r = await cambiarEstadoCliente(f.id, { activo: true, activoEsperado: false });
      expect(r).toMatchObject({ id: f.id, active: true, usuariosInvalidados: [] });
      expect(await companiaInactiva(f.id)).toBe(false);
      const [u2] = await tx`SELECT active FROM users WHERE id = ${f.u2}`;
      expect(u2!.active).toBe(false);
    });
  });

  it('AC6: con el estado ya cambiado por otro → EstadoClienteCambiadoError y nada cambia; AC10: inexistente → ClienteNoEncontradoError', async () => {
    await conBase(async (tx, f) => {
      await cambiarEstadoCliente(f.id, { activo: false, activoEsperado: true });
      const [antes] = await tx`SELECT session_invalidated_at FROM users WHERE id = ${f.u1}`;
      await expect(cambiarEstadoCliente(f.id, { activo: false, activoEsperado: true })).rejects.toBeInstanceOf(EstadoClienteCambiadoError);
      const [despues] = await tx`SELECT session_invalidated_at FROM users WHERE id = ${f.u1}`;
      expect(despues).toEqual(antes);
      await expect(cambiarEstadoCliente(2_000_000_000, { activo: false, activoEsperado: true })).rejects.toBeInstanceOf(ClienteNoEncontradoError);
    });
  });
});
