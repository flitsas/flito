// HU #13960 (Feature #13940) — Eliminar un proveedor SOAT contra PostgreSQL de verdad.
//
// AC1–AC7 dentro de una transacción que termina en ROLLBACK (`base-en-tx.ts`), con el arnés de
// `db/proveedores-soat-estado.test.ts`: `db` es un Drizzle sobre la MISMA transacción. Aquí `db.transaction(fn)` abre un
// SAVEPOINT y lo revierte si `fn` lanza, para medir que un rechazo no deja nada escrito (como la transacción real).
// AC9 (dos DELETE concurrentes) necesita dos conexiones de verdad: confirma un proveedor desechable sin dependencias, lo
// elimina dos veces a la vez y lo borra en el `finally`. Sin TEST_DATABASE_URL se SALTA.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';
import { testToken } from '../helpers/auth.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const actual: { db: Db | null; tx: postgres.TransactionSql | null; real: Db | null } = { db: null, tx: null, real: null };
let sp = 0;
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (actual.real) {
        const r = actual.real as unknown as Record<string | symbol, unknown>;
        const v = r[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(r) : v;
      }
      if (prop === 'transaction') {
        return async (fn: (tx: unknown) => unknown) => {
          const nombre = `sp_hu13960_${++sp}`;
          await actual.tx!.unsafe(`SAVEPOINT ${nombre}`);
          try {
            const r = await fn(actual.db);
            await actual.tx!.unsafe(`RELEASE SAVEPOINT ${nombre}`);
            return r;
          } catch (e) {
            await actual.tx!.unsafe(`ROLLBACK TO SAVEPOINT ${nombre}`);
            throw e;
          }
        };
      }
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { eliminarProveedorSoat, ProveedorSoatNoEliminableError } =
  await import('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js');
const { EstadoProveedorCambiadoError, ProveedorSoatNoEncontradoError, impactoProveedorSoat } =
  await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const { cambiarActivo, reactivarUsuario, ProveedorSoatDelUsuarioEliminadoError } =
  await import('../../src/modules/users/users.service.js');

const ACTOR = { userId: null, email: null, rol: null };

/** P: inactivo, con lo que NO impide eliminarlo (SOAT pagado, compañía eliminada, usuarios). */
async function sembrar(tx: postgres.TransactionSql) {
  const proveedor = async (nombre: string, activo: boolean) =>
    (await tx`INSERT INTO flito_proveedores_soat (nombre, activo) VALUES (${nombre}, ${activo}) RETURNING id`)[0]!.id as string;
  const p = await proveedor('Gestora HU13960', false);
  const otro = await proveedor('Otra HU13960', true);
  const cliente = async (name: string, prov: string | null, eliminado = false) =>
    (await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id, deleted_at)
      VALUES (${name}, ${prov !== null}, ${prov}, CASE WHEN ${eliminado} THEN now() END) RETURNING id`)[0]!.id as number;
  const delta = await cliente('Delta HU13960', otro);
  // AC5: el único cliente con P como proveedor de SOAT sin trámite está eliminado → no cuenta.
  await cliente('Gamma HU13960', p, true);
  let n = 0;
  const soat = async (prov: string, estado: string) => {
    const [v] = await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
    await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id)
      VALUES (${delta}, ${v!.id}, ${'VINHU13960' + (++n)}, ${estado}::flito_soat_estado, ${prov})`;
  };
  await soat(p, 'pagado'); // un pagado no está en curso
  const [rol] = await tx`SELECT codigo FROM permisos_roles ORDER BY (codigo = 'gestor_soat') DESC, codigo LIMIT 1`;
  const usuario = async (u: string, prov: string, extra: { active?: boolean; baja?: boolean } = {}) =>
    (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id, active, deleted_at)
      VALUES (${'hu13960_' + u}, 'X', 'h', ${rol!.codigo}, ${prov}, ${extra.active ?? true}, CASE WHEN ${extra.baja === true} THEN now() END)
      RETURNING id`)[0]!.id as number;
  // AC1: G y H activos (pierden el acceso); B dado de baja antes (activo, se queda como está); J de otro proveedor.
  const g = await usuario('g', p);
  const h = await usuario('h', p);
  const b = await usuario('b', p, { baja: true });
  const j = await usuario('j', otro);
  return { p, otro, g, h, b, j, soat, cliente };
}

async function conBase(fn: (tx: postgres.TransactionSql, f: Awaited<ReturnType<typeof sembrar>>) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.tx = tx;
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx, await sembrar(tx));
    });
  } finally {
    actual.db = null; actual.tx = null;
    await sql.end();
  }
}

const motivo = async (id: string) => {
  try { await eliminarProveedorSoat(id, ACTOR); return null; } catch (e) {
    expect(e).toBeInstanceOf(ProveedorSoatNoEliminableError);
    return (e as Error).message;
  }
};

describe.skipIf(!URL_BASE)('eliminarProveedorSoat — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC1/AC5: baja lógica; sus usuarios sin baja quedan inactivos con sesión invalidada; nada más cambia', async () => {
    await conBase(async (tx, f) => {
      const r = await eliminarProveedorSoat(f.p, ACTOR);
      expect(r).toMatchObject({ id: f.p, nombre: 'Gestora HU13960' });
      expect([...r.usuariosDesactivados].sort()).toEqual([f.g, f.h].sort());
      const [prov] = await tx`SELECT deleted_at IS NOT NULL AS eliminado, deleted_by FROM flito_proveedores_soat WHERE id = ${f.p}`;
      expect(prov).toEqual({ eliminado: true, deleted_by: null });
      const filas = await tx`SELECT id, active, session_invalidated_at IS NOT NULL AS invalidada, deleted_at IS NOT NULL AS baja
        FROM users WHERE id IN (${f.g}, ${f.h}, ${f.b}, ${f.j}) ORDER BY id`;
      expect(filas).toEqual([
        { id: f.g, active: false, invalidada: true, baja: false },
        { id: f.h, active: false, invalidada: true, baja: false },
        { id: f.b, active: true, invalidada: false, baja: true },
        { id: f.j, active: true, invalidada: false, baja: false },
      ].sort((a, c) => a.id - c.id));
      // Rastro en la bitácora de permisos, uno por usuario que estaba activo.
      const [hist] = await tx`SELECT count(*)::int AS n FROM permisos_auditoria
        WHERE usuario_afectado_id IN (${f.g}, ${f.h}) AND campo = 'active'`;
      expect(hist!.n).toBe(2);
      // Ya eliminado → 404 (el nombre queda libre por el índice parcial de la 0259).
      await expect(eliminarProveedorSoat(f.p, ACTOR)).rejects.toBeInstanceOf(ProveedorSoatNoEncontradoError);
      await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('Gestora HU13960')`;
    });
  });

  it('AC2/AC3/AC4: condiciones en orden; el rechazo no escribe nada', async () => {
    await conBase(async (tx, f) => {
      await tx`UPDATE flito_proveedores_soat SET activo = true WHERE id = ${f.p}`;
      for (let i = 0; i < 4; i++) await f.soat(f.p, i % 2 ? 'solicitado' : 'pendiente');
      await f.cliente('Beta HU13960', f.p);
      await f.cliente('Alfa HU13960', f.p);
      expect(await motivo(f.p)).toBe('Primero debe desactivarlo.');
      await tx`UPDATE flito_proveedores_soat SET activo = false WHERE id = ${f.p}`;
      expect(await motivo(f.p)).toBe('Tiene 4 SOAT en curso.');
      await tx`UPDATE flito_soat SET estado = 'pagado'::flito_soat_estado WHERE proveedor_soat_id = ${f.p}`;
      expect(await motivo(f.p)).toBe('Es el proveedor de SOAT sin trámite de 2 compañías (Alfa HU13960, Beta HU13960).');
      expect((await impactoProveedorSoat(actual.db!, f.p))?.puedeEliminar).toBe(false);
      const [prov] = await tx`SELECT deleted_at FROM flito_proveedores_soat WHERE id = ${f.p}`;
      expect(prov!.deleted_at).toBeNull();
      const [g] = await tx`SELECT active FROM users WHERE id = ${f.g}`;
      expect(g!.active).toBe(true);
    });
  });

  it('AC6: el eliminado no aparece en GET /proveedores-soat', async () => {
    await conBase(async (tx, f) => {
      const [admin] = await tx`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL AND active ORDER BY id LIMIT 1`;
      const app = express();
      app.use(express.json());
      const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
      app.use('/api/flito/parametrizacion', router);
      const token = await testToken({ sub: admin!.id as number, role: 'admin' });
      const ids = async () => (await request(app).get('/api/flito/parametrizacion/proveedores-soat')
        .set('Authorization', `Bearer ${token}`)).body.map((p: { id: string }) => p.id);
      expect(await ids()).toContain(f.p);
      await eliminarProveedorSoat(f.p, ACTOR);
      const despues = await ids();
      expect(despues).not.toContain(f.p);
      expect(despues).toContain(f.otro);
    });
  });

  it('AC7: activar o reactivar a un usuario huérfano → error y nada cambia; con otro proveedor vigente, sí', async () => {
    await conBase(async (tx, f) => {
      await eliminarProveedorSoat(f.p, ACTOR);
      await expect(cambiarActivo(f.g, ACTOR)).rejects.toBeInstanceOf(ProveedorSoatDelUsuarioEliminadoError);
      await expect(cambiarActivo(f.g, ACTOR)).rejects.toThrow(
        'El proveedor SOAT de este usuario fue eliminado; asígnale otro antes de activarlo.');
      const [g] = await tx`SELECT active FROM users WHERE id = ${f.g}`;
      expect(g!.active).toBe(false);
      // B (dado de baja antes, aún `active`): reactivarlo lo dejaría activo con el proveedor eliminado.
      await expect(reactivarUsuario(f.b, ACTOR)).rejects.toBeInstanceOf(ProveedorSoatDelUsuarioEliminadoError);
      const [b] = await tx`SELECT deleted_at IS NOT NULL AS baja FROM users WHERE id = ${f.b}`;
      expect(b!.baja).toBe(true);
      // Reasignado a un proveedor vigente → se activa.
      await tx`UPDATE users SET flito_proveedor_soat_id = ${f.otro} WHERE id = ${f.g}`;
      expect((await cambiarActivo(f.g, ACTOR))?.active).toBe(true);
    });
  });
});

describe.skipIf(!URL_BASE)('eliminarProveedorSoat — AC9: dos DELETE concurrentes (conexiones reales)', () => {
  it('uno elimina; el otro, que esperaba el bloqueo, recibe «Otro administrador ya cambió su estado»', async () => {
    const sql = postgres(URL_BASE!, { max: 4, onnotice: () => {} });
    const nombre = `HU13960 concurrencia ${Date.now()}`;
    const [fila] = await sql`INSERT INTO flito_proveedores_soat (nombre, activo) VALUES (${nombre}, false) RETURNING id`;
    const id = fila!.id as string;
    try {
      actual.real = drizzle(sql, { schema });
      const resultados = await Promise.allSettled([eliminarProveedorSoat(id, ACTOR), eliminarProveedorSoat(id, ACTOR)]);
      const ok = resultados.filter((r) => r.status === 'fulfilled');
      const ko = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(1);
      expect(ko[0]!.reason).toBeInstanceOf(EstadoProveedorCambiadoError);
      expect((ko[0]!.reason as Error).message).toBe('Otro administrador ya cambió su estado');
    } finally {
      actual.real = null;
      await sql`DELETE FROM flito_proveedores_soat WHERE id = ${id}`;
      await sql.end();
    }
  });
});
