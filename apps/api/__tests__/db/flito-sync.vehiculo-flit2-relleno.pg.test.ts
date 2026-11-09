// Bug #14491 — `upsertVehiculo` con clase / año / capacidad de FLIT 2, contra Postgres REAL: con la
// columna en NULL se llena; con valor previo NO se pisa. Todo corre en una transacción que se revierte
// al final (no deja filas). Solo corre con TEST_DATABASE_URL.

import { describe, it, expect, vi, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

const URL_BASE = process.env.TEST_DATABASE_URL;
const cliente = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  cliente.sql = sql;
  return { db: drizzle(sql, { schema }), getPoolStats: () => ({}) };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

class Revertir extends Error {}
type Db = typeof import('../../src/db/client.js')['db'];

describe.skipIf(!URL_BASE)('upsertVehiculo · relleno solo-si-vacío de FLIT 2 (Bug #14491)', () => {
  afterAll(async () => { await (cliente.sql as postgres.Sql | null)?.end(); });

  const VIN = 'ZZZBUG14491000001';
  const tf = (over: Record<string, unknown> = {}) => ({
    vin: VIN, placa: null, marca: 'MAZDA', linea: 'CX-30', cilindraje: '2000', carroceria: null, tipoServicio: null,
    numMotor: null, numSerie: null, compradores: [], ...over,
  });

  /** Corre `cuerpo` en una transacción y la revierte siempre. */
  async function enTransaccion(cuerpo: (tx: Db) => Promise<void>): Promise<void> {
    const { db } = await import('../../src/db/client.js');
    await expect(db.transaction(async (tx) => { await cuerpo(tx as unknown as Db); throw new Revertir(); })).rejects.toBeInstanceOf(Revertir);
  }

  it('con las tres columnas en NULL, FLIT 2 las llena', async () => {
    const { upsertVehiculo } = await import('../../src/modules/flito-sync/flito-sync.service.js');
    const { vehicles } = await import('../../src/db/schema.js');
    await enTransaccion(async (tx) => {
      const id = await upsertVehiculo(tx as never, tf(), null);
      await upsertVehiculo(tx as never, tf({ clase: 'CAMIONETA', modeloAno: 2024, capacidad: '5' }), null);
      const [v] = await tx
        .select({ c: vehicles.vehicleClass, y: vehicles.year, p: vehicles.pasajerosSentados }).from(vehicles).where(eq(vehicles.id, id));
      expect(v).toEqual({ c: 'CAMIONETA', y: 2024, p: '5' });
    });
  });

  it('con valor previo NO se pisan, y las demás columnas siguen la política de siempre (FLIT 2 manda)', async () => {
    const { upsertVehiculo } = await import('../../src/modules/flito-sync/flito-sync.service.js');
    const { vehicles } = await import('../../src/db/schema.js');
    await enTransaccion(async (tx) => {
      const id = await upsertVehiculo(tx as never, tf({ clase: 'AUTOMOVIL', modeloAno: 2020, capacidad: '4' }), null);
      await upsertVehiculo(tx as never, tf({ cilindraje: '1600', clase: 'CAMIONETA', modeloAno: 2024, capacidad: '5' }), null);
      const [v] = await tx
        .select({ c: vehicles.vehicleClass, y: vehicles.year, p: vehicles.pasajerosSentados, cil: vehicles.cilindraje })
        .from(vehicles).where(eq(vehicles.id, id));
      expect(v).toEqual({ c: 'AUTOMOVIL', y: 2020, p: '4', cil: '1600' });
    });
  });

  it('FLIT 1 (sin los campos) no toca lo guardado', async () => {
    const { upsertVehiculo } = await import('../../src/modules/flito-sync/flito-sync.service.js');
    const { vehicles } = await import('../../src/db/schema.js');
    await enTransaccion(async (tx) => {
      const id = await upsertVehiculo(tx as never, tf({ clase: 'AUTOMOVIL', modeloAno: 2020, capacidad: '4' }), null);
      await upsertVehiculo(tx as never, tf(), null, { soloSiCambia: true });
      await upsertVehiculo(tx as never, tf(), null);
      const [v] = await tx
        .select({ c: vehicles.vehicleClass, y: vehicles.year, p: vehicles.pasajerosSentados }).from(vehicles).where(eq(vehicles.id, id));
      expect(v).toEqual({ c: 'AUTOMOVIL', y: 2020, p: '4' });
    });
  });
});
