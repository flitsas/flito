// HU #13958 (Feature #13940) — Impacto y cambio de estado de un proveedor SOAT contra PostgreSQL de verdad.
//
// Todo dentro de una transacción que termina en ROLLBACK (`base-en-tx.ts`); se activa con TEST_DATABASE_URL y sin ella
// se SALTA (el CI no levanta Postgres; el contrato de la ruta lo mide `services/proveedores-soat-estado.routes.test.ts`).
// Mismo arnés que `db/clients-estado.test.ts`: `db` es un Drizzle sobre la MISMA transacción y `db.transaction(fn)`
// ejecuta `fn` sobre ella (el `FOR UPDATE` corre de verdad; el ROLLBACK del final lo deshace todo).
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

const {
  impactoProveedorSoat, cambiarEstadoProveedorSoat, proveedorSoatInactivo,
  EstadoProveedorCambiadoError, ProveedorSoatNoEncontradoError,
} = await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');

const INEXISTENTE = 'f0000000-0000-4000-8000-0000000fffff';

/** Un proveedor con lo que el AC1 necesita: lo que cuenta y lo que NO cuenta. */
async function sembrar(tx: postgres.TransactionSql) {
  const [p] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('Gestora HU13958') RETURNING id`;
  const [otroP] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('Otra HU13958') RETURNING id`;
  const id = p!.id as string;
  const otro = otroP!.id as string;
  const cliente = async (name: string, proveedor: string | null, eliminado = false) =>
    (await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id, deleted_at)
      VALUES (${name}, ${proveedor !== null}, ${proveedor}, CASE WHEN ${eliminado} THEN now() END) RETURNING id`)[0]!.id as number;
  // AC1: Alfa y Beta lo tienen por defecto; Gamma también pero está eliminada (no cuenta); Delta tiene otro.
  const alfa = await cliente('Alfa HU13958', id);
  await cliente('Beta HU13958', id);
  await cliente('Gamma HU13958', id, true);
  await cliente('Delta HU13958', otro);
  const vehiculo = async () => (await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
  const soat = async (proveedor: string, estado: string, n: number) => {
    const v = await vehiculo();
    await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id)
      VALUES (${alfa}, ${v}, ${'VINHU13958' + n}, ${estado}::flito_soat_estado, ${proveedor})`;
  };
  // AC1: 4 en curso (+1 pagado y 1 de otro proveedor, que no cuentan).
  await soat(id, 'solicitado', 1); await soat(id, 'solicitado', 2); await soat(id, 'pendiente', 3); await soat(id, 'pendiente', 4);
  await soat(id, 'pagado', 5); await soat(otro, 'solicitado', 6);
  // Usuarios: G activo, H inactivo por su cuenta, I dado de baja (no cuenta), J de otro proveedor.
  const [rol] = await tx`SELECT codigo FROM permisos_roles ORDER BY (codigo = 'gestor_soat') DESC, codigo LIMIT 1`;
  const usuario = async (n: string, proveedor: string, extra: { active?: boolean; baja?: boolean } = {}) =>
    (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id, active, deleted_at)
      VALUES (${'hu13958_' + n}, 'X', 'h', ${rol!.codigo}, ${proveedor}, ${extra.active ?? true}, CASE WHEN ${extra.baja === true} THEN now() END)
      RETURNING id`)[0]!.id as number;
  const g = await usuario('g', id);
  const h = await usuario('h', id, { active: false });
  await usuario('i', id, { baja: true });
  const j = await usuario('j', otro);
  return { id, otro, g, h, j };
}

async function conBase(fn: (tx: postgres.TransactionSql, f: Awaited<ReturnType<typeof sembrar>>) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx, await sembrar(tx));
    });
  } finally {
    actual.db = null;
    await sql.end();
  }
}

describe.skipIf(!URL_BASE)('flito-proveedores-estado.service — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1: SOAT en curso del proveedor, compañías vigentes con él por defecto y sus usuarios sin baja; no modifica nada', async () => {
    await conBase(async (tx, f) => {
      const antes = await tx`SELECT activo FROM flito_proveedores_soat WHERE id = ${f.id}`;
      expect(await impactoProveedorSoat(actual.db!, f.id)).toEqual({
        activo: true,
        soatEnCurso: 4,
        companiasGestorPorDefecto: { cantidad: 2, nombres: ['Alfa HU13958', 'Beta HU13958'] },
        usuariosAfectados: 2, // g y h (la inactiva sigue siendo del proveedor); i tiene baja
        puedeEliminar: false,
        motivoNoEliminable: null,
      });
      expect(await tx`SELECT activo FROM flito_proveedores_soat WHERE id = ${f.id}`).toEqual(antes);
    });
  });

  it('AC9: inexistente o eliminado → null', async () => {
    await conBase(async (tx, f) => {
      expect(await impactoProveedorSoat(actual.db!, INEXISTENTE)).toBeNull();
      await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${f.otro}`;
      expect(await impactoProveedorSoat(actual.db!, f.otro)).toBeNull();
    });
  });

  it('AC2/AC3: desactivar invalida las sesiones de SUS usuarios sin tocar users.active; el login ve el proveedor inactivo', async () => {
    await conBase(async (tx, f) => {
      const r = await cambiarEstadoProveedorSoat(f.id, { activo: false, activoEsperado: true });
      expect(r).toMatchObject({ id: f.id, nombre: 'Gestora HU13958', activo: false });
      expect(r.usuariosInvalidados).toEqual(expect.arrayContaining([f.g, f.h]));
      expect(r.usuariosInvalidados).not.toContain(f.j);
      const filas = await tx`SELECT id, active, session_invalidated_at IS NOT NULL AS invalidada FROM users
        WHERE id IN (${f.g}, ${f.h}, ${f.j}) ORDER BY id`;
      expect(filas).toEqual([
        { id: f.g, active: true, invalidada: true },
        { id: f.h, active: false, invalidada: true },
        { id: f.j, active: true, invalidada: false },
      ].sort((a, b) => a.id - b.id));
      expect(await proveedorSoatInactivo(f.id)).toBe(true);
      expect(await proveedorSoatInactivo(f.otro)).toBe(false);
      expect(await proveedorSoatInactivo(null)).toBe(false);
    });
  });

  it('AC3: un proveedor eliminado (aunque `activo`) también bloquea el login', async () => {
    await conBase(async (tx, f) => {
      await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${f.otro}`;
      expect(await proveedorSoatInactivo(f.otro)).toBe(true);
    });
  });

  it('AC4: activar devuelve el proveedor a activo sin reactivar al usuario inactivo por su cuenta', async () => {
    await conBase(async (tx, f) => {
      await cambiarEstadoProveedorSoat(f.id, { activo: false, activoEsperado: true });
      const r = await cambiarEstadoProveedorSoat(f.id, { activo: true, activoEsperado: false });
      expect(r).toMatchObject({ id: f.id, activo: true, usuariosInvalidados: [] });
      expect(await proveedorSoatInactivo(f.id)).toBe(false);
      const [h] = await tx`SELECT active FROM users WHERE id = ${f.h}`;
      expect(h!.active).toBe(false);
    });
  });

  it('AC8: con el estado ya cambiado por otro → EstadoProveedorCambiadoError y nada cambia; AC9: inexistente o eliminado → 404', async () => {
    await conBase(async (tx, f) => {
      await cambiarEstadoProveedorSoat(f.id, { activo: false, activoEsperado: true });
      const [antes] = await tx`SELECT session_invalidated_at FROM users WHERE id = ${f.g}`;
      await expect(cambiarEstadoProveedorSoat(f.id, { activo: false, activoEsperado: true }))
        .rejects.toBeInstanceOf(EstadoProveedorCambiadoError);
      const [despues] = await tx`SELECT session_invalidated_at FROM users WHERE id = ${f.g}`;
      expect(despues).toEqual(antes);
      await expect(cambiarEstadoProveedorSoat(INEXISTENTE, { activo: false, activoEsperado: true }))
        .rejects.toBeInstanceOf(ProveedorSoatNoEncontradoError);
      await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${f.otro}`;
      await expect(cambiarEstadoProveedorSoat(f.otro, { activo: false, activoEsperado: true }))
        .rejects.toBeInstanceOf(ProveedorSoatNoEncontradoError);
    });
  });
});
