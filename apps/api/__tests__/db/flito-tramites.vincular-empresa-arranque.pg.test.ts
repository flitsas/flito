// Bug #14414 — Vincular la empresa a un trámite arranca SOAT e impuesto. Contra PostgreSQL de verdad, dentro de una transacción con ROLLBACK (`base-en-tx.ts`); se SALTA sin
// TEST_DATABASE_URL (el CI no levanta Postgres: lo que corre en CI está en `flito-sync.arrancar-tramite-guardado.test.ts`).
// `db` es un Drizzle sobre la transacción del test.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const actual: { db: Db | null; transaction: ((fn: (tx: unknown) => unknown) => unknown) | null } = { db: null, transaction: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => (actual.transaction ? actual.transaction(fn) : fn(actual.db));
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

// Hace fallar el arranque cuando el motivo del alta menciona este radicado.
const falla: { radicado: string | null } = { radicado: null };
vi.mock('../../src/shared/historial/estado-historial.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/shared/historial/estado-historial.js')>();
  return {
    ...real,
    registrarCambio: (async (...args: Parameters<typeof real.registrarCambio>) => {
      const motivo = (args[1] as { motivo?: string }).motivo ?? '';
      if (falla.radicado && motivo.includes(falla.radicado)) throw new Error('fallo simulado del arranque');
      return real.registrarCambio(...args);
    }) as typeof real.registrarCambio,
  };
});

const { crearEmpresaDesdeTramite } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

type Tx = postgres.TransactionSql;
const SUFIJO = String(Date.now()).slice(-6);
let secuencia = 0;
let opciones: postgres.Sql['options'];
const ctx = { userId: null } as never;
const AUTOGESTION_NO = { soat: false, impuestos: false, logistica: false };

async function organismoConModalidad(tx: Tx, modalidad: 'requiere_gestion' | 'autogestionado' | null): Promise<string> {
  const [o] = await tx`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 1`;
  const codigo = (o?.codigo ?? (await tx`INSERT INTO organismos_transito_config (codigo, alias) VALUES ('99914', 'Bug14414') RETURNING codigo`)[0]!.codigo) as string;
  await tx`UPDATE flito_organismo_vigencias SET hasta = now() WHERE organismo_codigo = ${codigo} AND hasta IS NULL`;
  if (modalidad) {
    await tx`INSERT INTO flito_organismo_vigencias (organismo_codigo, modalidad, desde, motivo, actor_nombre)
      VALUES (${codigo}, ${modalidad}, now() - interval '1 day', 'test Bug14414', 'test')`;
  }
  return codigo;
}

async function compania(tx: Tx, o: { soat?: boolean; impuestos?: boolean; activa?: boolean } = {}): Promise<{ id: number; nit: string }> {
  const nit = `B14414${SUFIJO}${++secuencia}`;
  const [c] = await tx`INSERT INTO clients (name, document, active, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
    VALUES ('Cliente Bug14414', ${nit}, ${o.activa ?? true}, ${o.soat ?? false}, ${o.impuestos ?? false}, false) RETURNING id`;
  return { id: c!.id as number, nit };
}

async function vehiculo(tx: Tx): Promise<{ id: number; vin: string }> {
  const vin = `V14414${SUFIJO}${String(++secuencia).padStart(3, '0')}`;
  const [v] = await tx`INSERT INTO vehicles (vin, plate) VALUES (${vin}, ${`T${secuencia}`}) RETURNING id`;
  return { id: v!.id as number, vin };
}

interface OpcTramite {
  organismo: string; nit?: string | null; companiaId?: number | null; vehiculoId?: number;
  fuente?: 'flit' | 'flit2'; flitEstado?: string; enmascarada?: boolean; comprador?: boolean;
  huella?: 'usuario' | 'api' | null; valor?: string | null; estado?: string | null;
}

async function tramite(tx: Tx, o: OpcTramite): Promise<{ id: string; idFlit: string; vehiculoId: number; vin: string | null }> {
  const v = o.vehiculoId ? { id: o.vehiculoId, vin: null } : await vehiculo(tx);
  const idFlit = `B14414-${SUFIJO}-${++secuencia}`;
  const fuente = o.fuente ?? 'flit2';
  const [t] = await tx`INSERT INTO flito_tramites (id_flit, flit_estado, estado, compania_id, compania_nit, organismo_codigo, vehiculo_id,
      fuente, id_flit2, sync_version, flit2_pii_enmascarada, valor_impuesto_liquidado, sincronizado_en)
    VALUES (${idFlit}, ${o.flitEstado ?? 'Asignado'}, ${o.estado ?? null}, ${o.companiaId ?? null}, ${o.nit ?? null}, ${o.organismo}, ${v.id},
      ${fuente}, ${fuente === 'flit2' ? crypto.randomUUID() : null}, ${fuente === 'flit2' ? 1 : null}, ${o.enmascarada ?? false}, ${o.valor ?? null}, now())
    RETURNING id`;
  const id = t!.id as string;
  if (o.comprador ?? true) {
    await tx`INSERT INTO flito_compradores (tramite_id, nombre_completo, numero_documento, orden) VALUES (${id}, 'Comprador Prueba', 'DOC-PRUEBA', 0)`;
  }
  if (o.huella) {
    await tx`INSERT INTO flito_tramite_historial (tramite_id, campo, valor_anterior, valor_nuevo, origen)
      VALUES (${id}, 'compania_id', NULL, ${String(o.companiaId)}, ${o.huella})`;
  }
  return { id, idFlit, vehiculoId: v.id, vin: v.vin };
}

async function estadoDe(tx: Tx, id: string) {
  const [t] = await tx`SELECT t.compania_id, t.soat_id, s.estado::text AS soat_estado, s.proveedor_soat_id, s.proveedor_sobrescrito,
      s.excepcion_autogestion AS soat_excepcion, i.estado::text AS impuesto_estado, i.valor_liquidado, i.modalidad_aplicada::text AS modalidad,
      i.excepcion_autogestion AS impuesto_excepcion, i.id AS impuesto_id
    FROM flito_tramites t LEFT JOIN flito_soat s ON s.id = t.soat_id LEFT JOIN flito_impuestos i ON i.tramite_id = t.id
    WHERE t.id = ${id}`;
  return t!;
}

const soatsDelVin = async (tx: Tx, vin: string) => (await tx`SELECT id, estado::text AS estado FROM flito_soat WHERE vin = ${vin}`);

function conBase(fn: (tx: Tx) => Promise<void>): () => Promise<void> {
  return async () => {
    const sql = abrirBase();
    try {
      await enTx(sql, async (tx) => {
        // La TransactionSql no expone `options`, que Drizzle lee para sus parsers (ver `clients-estado.test.ts`).
        opciones = sql.options;
        actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema }) as Db;
        actual.transaction = null;
        falla.radicado = null;
        await fn(tx);
      });
    } finally {
      actual.db = null;
      actual.transaction = null;
      falla.radicado = null;
      await sql.end();
    }
  };
}

/** Crea o reutiliza la empresa del NIT `c.nit`, ya existente en la base del test. */
const vincular = (nit: string) => crearEmpresaDesdeTramite('Cliente Bug14414', nit, AUTOGESTION_NO, ctx);

describe.skipIf(!URL_BASE)('Bug #14414 — crearEmpresaDesdeTramite arranca SOAT e impuesto', () => {
  it('repro: FLIT 2 Asignado con comprador y empresa NUEVA → nacen SOAT e impuesto pendiente', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const nit = `B14414N${SUFIJO}`;
    const t = await tramite(tx, { organismo, nit, valor: '150000.00' });

    const r = await vincular(nit);

    expect(r).toMatchObject({ yaExistia: false, revinculados: 1 });
    const e = await estadoDe(tx, t.id);
    expect(e.compania_id).toBe(r.companiaId);
    expect(e.soat_estado).toBe('pendiente');
    expect(e.proveedor_soat_id).toBeNull();
    expect(e.proveedor_sobrescrito).toBe(false);
    expect(e.soat_excepcion).toBe(false);
    expect(e.impuesto_estado).toBe('pendiente');
    expect(e.modalidad).toBe('requiere_gestion');
    expect(Number(e.valor_liquidado)).toBe(150000);
    const h = await tx`SELECT origen, valor_nuevo FROM flito_tramite_historial WHERE tramite_id = ${t.id} AND campo = 'compania_id'`;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ origen: 'usuario', valor_nuevo: String(r.companiaId) });
  }));

  it('repro: empresa YA EXISTENTE (yaExistia) → también arranca', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const c = await compania(tx);
    const t = await tramite(tx, { organismo, nit: c.nit });
    const r = await vincular(c.nit);
    expect(r).toEqual({ companiaId: c.id, yaExistia: true, revinculados: 1 });
    const e = await estadoDe(tx, t.id);
    expect(e.soat_estado).toBe('pendiente');
    expect(e.impuesto_estado).toBe('pendiente');
  }));

  it('FLIT 1 no exige comprador principal', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const c = await compania(tx);
    const t = await tramite(tx, { organismo, nit: c.nit, fuente: 'flit', comprador: false, enmascarada: true });
    await vincular(c.nit);
    const e = await estadoDe(tx, t.id);
    expect(e.soat_estado).toBe('pendiente');
    expect(e.impuesto_estado).toBe('pendiente');
  }));

  it('la compañía autogestiona SOAT e impuesto → se vincula pero no crea registros', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const c = await compania(tx, { soat: true, impuestos: true });
    const t = await tramite(tx, { organismo, nit: c.nit });
    await vincular(c.nit);
    const e = await estadoDe(tx, t.id);
    expect(e.compania_id).toBe(c.id);
    expect(e.soat_id).toBeNull();
    expect(e.impuesto_id).toBeNull();
  }));

  it.each<[string, Partial<OpcTramite>]>([
    ['no está Asignado', { flitEstado: 'Aprobado' }],
    ['FLIT 2 con compradores enmascarados', { enmascarada: true }],
    ['FLIT 2 sin comprador principal', { comprador: false }],
  ])('%s → se vincula pero no arranca', async (_n, opc) => conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const c = await compania(tx);
    const t = await tramite(tx, { organismo, nit: c.nit, ...opc });
    const r = await vincular(c.nit);
    expect(r.revinculados).toBe(1);
    const e = await estadoDe(tx, t.id);
    expect(e.compania_id).toBe(c.id);
    expect(e.soat_id).toBeNull();
    expect(e.impuesto_id).toBeNull();
  })());

  it('SOAT ya existente del VIN → lo vincula sin duplicar', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const c = await compania(tx);
    const v = await vehiculo(tx);
    const [s] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, estado, compania_id, organismo_codigo)
      VALUES (${v.vin}, ${v.id}, 'pendiente', ${c.id}, ${organismo}) RETURNING id`;
    const t = await tramite(tx, { organismo, nit: c.nit, vehiculoId: v.id });
    await vincular(c.nit);
    expect((await estadoDe(tx, t.id)).soat_id).toBe(s!.id);
    expect(await soatsDelVin(tx, v.vin)).toHaveLength(1);
  }));

  it('si el arranque falla se revierte todo: ni empresa ni vinculación ni historial', conBase(async (tx) => {
    const organismo = await organismoConModalidad(tx, 'requiere_gestion');
    const nit = `B14414F${SUFIJO}`;
    const t = await tramite(tx, { organismo, nit });
    falla.radicado = t.idFlit;
    actual.transaction = (fn) => tx.savepoint(async (sp) => fn(drizzle(Object.assign(sp, { options: opciones }) as unknown as postgres.Sql, { schema })));

    await expect(vincular(nit)).rejects.toThrow('fallo simulado del arranque');

    const e = await estadoDe(tx, t.id);
    expect(e.compania_id).toBeNull();
    expect(e.soat_id).toBeNull();
    expect(await tx`SELECT 1 FROM clients WHERE document = ${nit}`).toHaveLength(0);
    expect(await tx`SELECT 1 FROM flito_tramite_historial WHERE tramite_id = ${t.id}`).toHaveLength(0);
  }));
});
