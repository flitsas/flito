// HU #13967 — «SOAT sin trámite» por permiso + proveedor, contra PostgreSQL de verdad (tx con ROLLBACK).
//
// Sin `TEST_DATABASE_URL` se SALTA (el CI no levanta Postgres; el contrato de las rutas lo miden
// `services/flito-soat.cliente-*.test.ts`, `services/auth-me-puede-solicitar-soat.test.ts` y
// `services/clients-listado-permiso-sin-efecto.test.ts`). Hay que LEER que no dice `skipped`.
//
// El `db` global del código se redirige a un Drizzle sobre la transacción (Proxy), así que el
// servicio y el resolutor leen las filas que el test sembró y nadie más las ve.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

let actual: Record<string | symbol, unknown> | null = null;
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, k) => (actual as Record<string | symbol, unknown>)[k] }),
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { companiasDelCanal } = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');
const { canalSinTramiteAbierto, canalSinTramiteAbiertoPara } = await import('../../src/modules/clients/cliente-operable.js');
const { companiasConUsuarioConFuncion, fijarFuenteDePermisos, resolverPermisos } =
  await import('../../src/shared/permisos-efectivos.js');
type Ctx = Parameters<typeof companiasDelCanal>[0];

async function conBase(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema }) as never;
      try { await fn(tx); } finally { actual = null; }
    });
  } finally { await sql.end(); }
}

const proveedor = async (tx: postgres.TransactionSql, nombre: string, activo = true) =>
  (await tx`INSERT INTO flito_proveedores_soat (nombre, activo) VALUES (${nombre}, ${activo}) RETURNING id`)[0]!.id as string;
const compania = async (tx: postgres.TransactionSql, nombre: string, prov: string | null) =>
  (await tx`INSERT INTO clients (name, flito_proveedor_soat_sin_tramite_id) VALUES (${nombre}, ${prov}) RETURNING id`)[0]!.id as number;
const usuario = async (tx: postgres.TransactionSql, n: string, role: string, companiaId: number | null, borrado = false) =>
  (await tx`INSERT INTO users (username, password_hash, name, role, compania_id, deleted_at)
    VALUES (${`zz13967_${n}@prueba.co`}, 'x', ${`zz13967 ${n}`}, ${role}, ${companiaId}, CASE WHEN ${borrado} THEN now() END)
    RETURNING id`)[0]!.id as number;

beforeAll(() => { fijarFuenteDePermisos(null); });

describe('HU #13967 — el predicado único del canal', () => {
  it('`canalSinTramiteAbierto` es «tiene proveedor elegido», y nada del interruptor retirado', () => {
    const { sql } = new PgDialect().sqlToQuery(canalSinTramiteAbierto);
    expect(sql).toBe('"clients"."flito_proveedor_soat_sin_tramite_id" is not null');
  });
});

describe.skipIf(!URL_BASE)('HU #13967 — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('AC4/AC5: sin enlace → solo compañías con proveedor, ACTIVO O INACTIVO; sin proveedor no aparece', async () => {
    await conBase(async (tx) => {
      const activo = await proveedor(tx, 'zz13967 activo');
      const inactivo = await proveedor(tx, 'zz13967 inactivo', false);
      const conActivo = await compania(tx, 'zz13967 A con activo', activo);
      const conInactivo = await compania(tx, 'zz13967 B con inactivo', inactivo);
      const sinProveedor = await compania(tx, 'zz13967 C sin proveedor', null);

      const r = await companiasDelCanal({ alcance: 'todo', companiaId: null } as unknown as Ctx);
      const ids = r.companias.map((c) => c.id);
      expect(r.fija).toBe(false);
      expect(ids).toEqual(expect.arrayContaining([conActivo, conInactivo]));
      expect(ids).not.toContain(sinProveedor);
      expect(Object.keys(r.companias[0]!).sort()).toEqual(['id', 'nombre']);
    });
  });

  it('AC1/AC2: enlace compañía → la suya si tiene proveedor; sin proveedor, lista vacía', async () => {
    await conBase(async (tx) => {
      const p = await proveedor(tx, 'zz13967 gestor');
      const con = await compania(tx, 'zz13967 con', p);
      const sin = await compania(tx, 'zz13967 sin', null);
      expect(await companiasDelCanal({ alcance: 'compania', companiaId: con } as unknown as Ctx))
        .toEqual({ fija: true, companias: [{ id: con, nombre: 'zz13967 con' }] });
      expect(await companiasDelCanal({ alcance: 'compania', companiaId: sin } as unknown as Ctx))
        .toEqual({ fija: true, companias: [] });
    });
  });

  // La consulta de `/me` (`puedeSolicitarSoat` → `canalSinTramiteAbiertoPara`). Los tests de la ruta mockean
  // `db` y el booleano lo decide el fixture; aquí lo decide el filtro (mata el mutante «sin el predicado»).
  it('AC1/AC2 `/me` — enlace compañía: true con proveedor, false con NULL', async () => {
    await conBase(async (tx) => {
      const p = await proveedor(tx, 'zz13967 gestor me');
      const con = await compania(tx, 'zz13967 me con', p);
      const sin = await compania(tx, 'zz13967 me sin', null);
      expect(await canalSinTramiteAbiertoPara('compania', con)).toBe(true);
      expect(await canalSinTramiteAbiertoPara('compania', sin)).toBe(false);
      expect(await canalSinTramiteAbiertoPara('compania', null)).toBe(false);
    });
  });

  it('AC4 `/me` — sin enlace: true si existe alguna compañía con proveedor; false si ninguna lo tiene', async () => {
    await conBase(async (tx) => {
      // Dentro de la tx (ROLLBACK): ninguna compañía de la base conserva proveedor.
      await tx`UPDATE clients SET flito_proveedor_soat_sin_tramite_id = NULL WHERE flito_proveedor_soat_sin_tramite_id IS NOT NULL`;
      const p = await proveedor(tx, 'zz13967 gestor ninguno');
      await compania(tx, 'zz13967 ninguno sin', null);
      expect(await canalSinTramiteAbiertoPara('ninguno', null)).toBe(false);

      await compania(tx, 'zz13967 ninguno con', p);
      expect(await canalSinTramiteAbiertoPara('ninguno', null)).toBe(true);
      // Otro enlace nunca radica, aunque haya compañías con proveedor.
      expect(await canalSinTramiteAbiertoPara('proveedor', null)).toBe(false);
    });
  });

  it('AC7: companiasConUsuarioConFuncion coincide con el resolutor sobre usuarios reales', async () => {
    await conBase(async (tx) => {
      const a = await compania(tx, 'zz13967 A', null);
      const b = await compania(tx, 'zz13967 B', null);
      const c = await compania(tx, 'zz13967 C', null);
      const d = await compania(tx, 'zz13967 D', null);
      const ua = await usuario(tx, 'a', 'cliente', a); // enlace compañía con la función → A
      const ub = await usuario(tx, 'b', 'cliente', b, true); // dado de baja → no cuenta
      const uc = await usuario(tx, 'c', 'auditor', c); // otro enlace → no cuenta

      const res = await companiasConUsuarioConFuncion('soat.solicitud.crear', [a, b, c, d]);
      const esperado = new Set<number>();
      for (const [uid, cid] of [[ua, a], [uc, c]] as const) {
        const p = await resolverPermisos(uid);
        if (p.ok && p.tipoEnlace === 'compania' && p.funciones.has('soat.solicitud.crear')) esperado.add(cid);
      }
      expect(esperado).toEqual(new Set([a]));
      expect(res).toEqual(esperado);
      expect(res.has(b)).toBe(false);
      void ub;
    });
  });
});
