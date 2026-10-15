/**
 * Bug #13585 — FLIT 1: un trámite anulado modifica el vehículo que comparte VIN con el trámite vigente.
 *
 * Repro: dos trámites del mismo VIN en el reporte (uno Anulado sin placa, otro Aprobado con placa).
 * `upsertVehiculo` hacía UPDATE con los dos y `setVehiculoDesdeFlit` escribía `plate: tf.placa` sin
 * condición: si el anulado iba después, `vehicles.plate` quedaba en NULL.
 *
 * Los asertos van sobre lo que realmente viaja a `vehicles` (espía de `.set()` / `.values()`), no sobre
 * la fila que devuelve el mock: el mock keyed devuelve la fila configurada y no aplicaría el SET.
 * Para el «estado final» del vehículo se aplican los SET capturados, en orden, sobre la fila previa.
 *
 * FLIT 2 (RN-26) se prueba en `flito-sync.flit2-lectura.test.ts` («Bug #13585 · RN-26»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const organismoPorCodigoMock = vi.fn();
const companiaPorNitMock = vi.fn();
const modalidadVigenteMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    organismoPorCodigo: organismoPorCodigoMock,
    companiaPorNit: companiaPorNitMock,
    modalidadVigente: modalidadVigenteMock,
  };
});

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { setVehiculoDesdeFlit, sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { vehicles } = await import('../../src/db/schema.js');

// Datos sintéticos: ningún VIN, placa ni documento real.
const VIN = '9FKTEST00000013585';
const VIN_NUEVO = '9FKTEST00000013586';
const PLACA = 'ZZZ585';
const VEHICULO_ID = 13585;
const TRAMITE_ID = 'dddd0000-0000-0000-0000-000000013585';
const RANGO = { initialDate: '20261001', finalDate: '20261015' };
const T_VEHICLES = getTableName(vehicles);

const compradorDe = (nombre: string, doc: string) =>
  [{ nombreCompleto: nombre, numeroDocumento: doc, correo: null, celular: null, direccion: null }];

const tramiteFlit = (over: Record<string, unknown> = {}) => ({
  idFlit: 'FLIT-013585', estadoFlit: 'Aprobado', vin: VIN, placa: PLACA,
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: compradorDe('TITULAR VIGENTE', '1000000001'),
  valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  marca: 'MARCA VIGENTE', linea: 'LINEA VIGENTE',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular', numMotor: 'MTR-V', numSerie: 'SER-V',
  ...over,
});

/** El anulado del repro: mismo VIN, sin placa y con otros datos (titular, marca, técnicos). */
const anulado = (over: Record<string, unknown> = {}) => tramiteFlit({
  idFlit: 'FLIT-013584', estadoFlit: 'Anulado', placa: null,
  compradores: compradorDe('TITULAR ANULADO', '2000000002'),
  marca: 'MARCA ANULADA', linea: 'LINEA ANULADA',
  cilindraje: '999', carroceria: 'HATCHBACK', tipoServicio: 'Publico', numMotor: 'MTR-A', numSerie: 'SER-A',
  ...over,
});

const puerto = (lista: Record<string, unknown>[]) => ({
  obtenerTramites: async () => lista,
  obtenerUrlFactura: async () => null,
  marcarEntregado: async () => undefined,
} as never);

function espiarInserts() {
  const vistos: { tabla: string; values: Record<string, unknown> }[] = [];
  const base = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const values = c.values as (v: unknown) => unknown;
    c.values = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), values: v as Record<string, unknown> });
      return values(v);
    };
    return c;
  });
  return vistos;
}

function espiarUpdates() {
  const vistos: { tabla: string; set: Record<string, unknown> }[] = [];
  const base = kdb.update.getMockImplementation()!;
  kdb.update.mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const set = c.set as (v: unknown) => unknown;
    c.set = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), set: v as Record<string, unknown> });
      return set(v);
    };
    return c;
  });
  return vistos;
}

const setsDeVehiculo = (updates: { tabla: string; set: Record<string, unknown> }[]) =>
  updates.filter((u) => u.tabla === T_VEHICLES).map((u) => u.set);

/** Fila previa del vehículo (la del trámite vigente) con los SET aplicados en orden, como haría la BD. */
const filaFinal = (sets: Record<string, unknown>[]) =>
  sets.reduce<Record<string, unknown>>((fila, s) => ({ ...fila, ...s }), {
    plate: PLACA, brand: 'MARCA VIGENTE', ownerName: 'TITULAR VIGENTE', ownerDocument: '1000000001',
  });

beforeEach(() => {
  kdb.reset();
  logMock.error.mockClear();
  organismoPorCodigoMock.mockReset().mockResolvedValue({ codigo: '25286' });
  companiaPorNitMock.mockReset().mockResolvedValue({
    id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true,
  });
  modalidadVigenteMock.mockReset().mockResolvedValue('autogestionado');
  kdb.when
    .select('vehicles', [{ id: VEHICULO_ID }]) // el VIN ya existe (lo dio de alta el vigente)
    .select('flito_tramites', [])
    .insert('vehicles', [{ id: VEHICULO_ID + 1 }])
    .insert('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
});

describe('Bug #13585 · setVehiculoDesdeFlit — una placa vacía no borra la conocida', () => {
  it('sin placa (null o "") el SET no lleva `plate`; con placa sí', () => {
    for (const placa of [null, '']) {
      const set = setVehiculoDesdeFlit(tramiteFlit({ placa }) as never);
      expect(Object.keys(set), `placa=${JSON.stringify(placa)}`).not.toContain('plate');
    }
    expect(setVehiculoDesdeFlit(tramiteFlit() as never)).toMatchObject({ plate: PLACA });
  });
});

describe('Bug #13585 · sincronizar (FLIT 1) — dos trámites del mismo VIN, uno anulado', () => {
  it.each([
    ['aprobado → anulado', () => [tramiteFlit(), anulado()]],
    ['anulado → aprobado', () => [anulado(), tramiteFlit()]],
  ])('repro (%s): el vehículo conserva la placa y el titular del aprobado', async (_orden, lista) => {
    const updates = espiarUpdates();
    const r = await sincronizar(RANGO, puerto(lista()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesNuevos).toBe(2); // los dos trámites se guardan

    const sets = setsDeVehiculo(updates);
    expect(sets, 'solo el aprobado escribe en vehicles').toHaveLength(1);
    expect(filaFinal(sets)).toMatchObject({
      plate: PLACA, brand: 'MARCA VIGENTE', ownerName: 'TITULAR VIGENTE', ownerDocument: '1000000001',
    });
  });

  it('un anulado con titular, marca y datos técnicos distintos NO hace UPDATE del vehículo existente', async () => {
    const updates = espiarUpdates();
    const inserts = espiarInserts();
    const r = await sincronizar(RANGO, puerto([anulado()]));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesNuevos).toBe(1);
    expect(setsDeVehiculo(updates)).toEqual([]);
    expect(inserts.some((i) => i.tabla === T_VEHICLES), 'tampoco crea otro vehículo').toBe(false);
    // El trámite anulado sí se guarda, colgado del vehículo que ya existía.
    const tramite = inserts.find((i) => i.tabla === 'flito_tramites')?.values;
    expect(tramite).toMatchObject({ idFlit: 'FLIT-013584', vehiculoId: VEHICULO_ID });
  });

  it('un anulado con VIN que no existe SÍ da de alta el vehículo (el trámite necesita vehiculo_id)', async () => {
    kdb.when.select('vehicles', []);
    const updates = espiarUpdates();
    const inserts = espiarInserts();
    await sincronizar(RANGO, puerto([anulado({ vin: VIN_NUEVO })]));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(setsDeVehiculo(updates)).toEqual([]);
    expect(inserts.find((i) => i.tabla === T_VEHICLES)?.values).toMatchObject({ vin: VIN_NUEVO, brand: 'MARCA ANULADA' });
    expect(inserts.find((i) => i.tabla === 'flito_tramites')?.values).toMatchObject({ vehiculoId: VEHICULO_ID + 1 });
  });

  it('control: un trámite vigente sin placa actualiza el resto pero no toca `plate`', async () => {
    const updates = espiarUpdates();
    await sincronizar(RANGO, puerto([tramiteFlit({ placa: null })]));
    const sets = setsDeVehiculo(updates);
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0])).not.toContain('plate');
    expect(sets[0]).toMatchObject({ brand: 'MARCA VIGENTE' });
  });
});
