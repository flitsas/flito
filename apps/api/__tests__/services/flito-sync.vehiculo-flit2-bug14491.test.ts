/**
 * Bug #14491 — clase, año-modelo y capacidad de FLIT 2 llegan a `vehicles` (`vehicle_class`, `year`,
 * `pasajeros_sentados`) SOLO cuando la columna está vacía (`coalesce(columna, valor)`, decisión del
 * humano): nunca pisan lo que ya puso el RUNT, el OCR u otra versión. FLIT 1 no los trae y no cambia.
 */
import { describe, it, expect, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { renderizar } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { setVehiculoDesdeFlit, rellenoVehiculoDesdeFlit } = await import('../../src/modules/flito-sync/flito-sync.service.js');
type VehiculoFlit = Parameters<typeof setVehiculoDesdeFlit>[0];

const base: VehiculoFlit = {
  vin: '9FKTEST0000000001', placa: 'ZZZ001', marca: 'MAZDA', linea: 'CX-30', cilindraje: '2000', carroceria: 'SUV',
  tipoServicio: 'Particular', numMotor: null, numSerie: null, compradores: [],
};

describe('Bug #14491 · clase / modeloAno / capacidad: solo llenan el vacío', () => {
  it('FLIT 2 con los tres: cada uno es `coalesce(<su columna>, <valor>)` — con valor previo no se pisa', () => {
    const r = rellenoVehiculoDesdeFlit({ ...base, clase: 'CAMIONETA', modeloAno: 2024, capacidad: '5' });
    expect(Object.keys(r).sort()).toEqual(['pasajerosSentados', 'vehicleClass', 'year']);
    const clase = renderizar(r.vehicleClass!);
    expect(clase.sql).toBe('coalesce("vehicles"."vehicle_class", $1)');
    expect(clase.params).toEqual(['CAMIONETA']);
    expect(renderizar(r.year!).sql).toBe('coalesce("vehicles"."year", $1::integer)');
    expect(renderizar(r.year!).params).toEqual([2024]);
    expect(renderizar(r.pasajerosSentados!).sql).toBe('coalesce("vehicles"."pasajeros_sentados", $1)');
    expect(renderizar(r.pasajerosSentados!).params).toEqual(['5']);
  });

  it('las tres NO entran por `setVehiculoDesdeFlit` (que sí pisa): la política de las demás no cambia', () => {
    const set = setVehiculoDesdeFlit({ ...base, clase: 'CAMIONETA', modeloAno: 2024, capacidad: '5' });
    expect(set).toEqual({ plate: 'ZZZ001', brand: 'MAZDA', model: 'CX-30', cilindraje: '2000', carroceria: 'SUV', tipoServicio: 'Particular' });
  });

  it('FLIT 1 (sin los campos) y FLIT 2 con null: sin relleno', () => {
    expect(rellenoVehiculoDesdeFlit(base)).toEqual({});
    expect(rellenoVehiculoDesdeFlit({ ...base, clase: null, modeloAno: null, capacidad: null })).toEqual({});
  });
});
