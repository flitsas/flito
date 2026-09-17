/**
 * Bug #12643 — el sync de FLIT aterriza `numeroMotor` / `numeroSerie` en `vehicles.num_motor` /
 * `num_serie` (padre Feature #12400; política de la HU #11906; recorte de `motorYSerieParaVehiculo`).
 *
 * TCs del modo A (qa-agent), derivados de los Repro Steps y del «Criterio de cierre»:
 *   TC-01 repro: FLIT trae `numeroMotor`/`numeroSerie` → `TramiteFlit.numMotor`/`numSerie`. HOY CAE.
 *   TC-02 borde: sin las claves, o vacías, quedan ausentes (nunca '').
 *   TC-03 borde: 60 caracteres → 50 con un warn SIN el valor (misma regla que el RUNT).
 *   TC-04 UPDATE: `setVehiculoDesdeFlit` lleva `numMotor`/`numSerie` cuando hay valor. HOY CAE.
 *   TC-05 UPDATE: vacío o ausente → las claves NO viajan en el SET (ni `null`): no borra lo del RUNT.
 *   TC-06 ALTA: el INSERT de `upsertVehiculo` lleva los dos. HOY CAE.
 *   TC-07 ALTA sin dato: no se escribe un motor inventado ('' o cadena).
 *   TC-08 UPDATE por `sincronizar` (recorrido real, no solo el helper). HOY CAE.
 *   Regresión (specs vecinos, no duplicados aquí): runt.vehiculo-motor-serie.test.ts (recorte y
 *   paridad con varchar(50)), flito-soat-export.test.ts («NumeroMotor» sale de `vehicles`),
 *   flito-sync.test.ts (los tres datos técnicos de la #11906) y el canal Cliente
 *   (flito-soat.gestor-radicador-canal.test.ts).
 *
 * Supuesto de nombres (a confirmar con la impl): en `TramiteFlit` los campos se llaman `numMotor` /
 * `numSerie`, igual que las columnas de `vehicles` y que `MotorYSeriePersistible`, para que el spread
 * de `motorYSerieParaVehiculo` caiga directo en `.set()` / `.values()`.
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
const { aTramite } = await import('../../src/modules/flito-sync/flit-http.adapter.js');
const { MAX_MOTOR_SERIE } = await import('../../src/modules/runt/vehiculo-motor-serie.js');
const { vehicles } = await import('../../src/db/schema.js');

type Tf = ReturnType<typeof aTramite> & { numMotor?: string | null; numSerie?: string | null };

// Datos sintéticos: ningún VIN, placa ni motor real.
const MOTOR = 'MTR-FLIT-0001';
const SERIE = 'SER-FLIT-0001';
const MOTOR_60 = 'M'.repeat(60);
const SERIE_60 = 'S'.repeat(60);

const itemFlit = (over: Record<string, unknown> = {}) => ({
  Id: 'FLIT-099001', Vin: '9FKTEST00000000001', Placa: 'ZZZ001', Ciudad: 'FUNZA', Estado: 'Aprobado',
  Tramite: 'Otros', Transito: 'STRIA TTOyTTE MCPAL FUNZA', CompaniaGestora: '901789698',
  codigoSecretaria: '25286', cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  ...over,
}) as never;

const ausente = (v: unknown) => v === undefined || v === null;

describe('Bug #12643 · aTramite — las claves numeroMotor / numeroSerie de FLIT', () => {
  beforeEach(() => logMock.warn.mockClear());

  it('TC-01 (repro): un ítem con numeroMotor y numeroSerie produce un TramiteFlit con los dos campos', () => {
    const tf = aTramite(itemFlit({ numeroMotor: ` ${MOTOR} `, numeroSerie: SERIE })) as Tf;
    expect(tf.numMotor).toBe(MOTOR); // con trim, como el resto del reporte
    expect(tf.numSerie).toBe(SERIE);
  });

  it('TC-02 (borde): sin las claves, o con cadena vacía/blanca, los campos quedan ausentes — nunca ""', () => {
    const sin = aTramite(itemFlit()) as Tf;
    expect(ausente(sin.numMotor), 'numMotor sin clave').toBe(true);
    expect(ausente(sin.numSerie), 'numSerie sin clave').toBe(true);
    const vacio = aTramite(itemFlit({ numeroMotor: '', numeroSerie: '   ' })) as Tf;
    expect(ausente(vacio.numMotor), 'numMotor vacío').toBe(true);
    expect(ausente(vacio.numSerie), 'numSerie en blanco').toBe(true);
    expect(logMock.warn).not.toHaveBeenCalled(); // un vacío no es un recorte
  });

  it('TC-03 (borde): 60 caracteres se recortan a 50 con un warn que NO lleva el valor (regla del RUNT)', () => {
    const tf = aTramite(itemFlit({ numeroMotor: MOTOR_60, numeroSerie: SERIE_60 })) as Tf;
    expect(tf.numMotor).toBe(MOTOR_60.slice(0, MAX_MOTOR_SERIE));
    expect(tf.numSerie).toBe(SERIE_60.slice(0, MAX_MOTOR_SERIE));
    expect(tf.numMotor).toHaveLength(50);
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    for (const [ctx] of logMock.warn.mock.calls as [Record<string, unknown>][]) {
      expect(ctx).toMatchObject({ longitud: 60, max: MAX_MOTOR_SERIE });
      expect(JSON.stringify(ctx)).not.toContain('MMMMM');
      expect(JSON.stringify(ctx)).not.toContain('SSSSS');
    }
    // Y el borde exacto NO avisa ni recorta.
    logMock.warn.mockClear();
    const justo = aTramite(itemFlit({ numeroMotor: 'M'.repeat(50) })) as Tf;
    expect(justo.numMotor).toHaveLength(50);
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

describe('Bug #12643 · setVehiculoDesdeFlit — política de la #11906 sobre motor y serie', () => {
  const tf = (over: Record<string, unknown> = {}) => ({
    placa: 'ZZZ001', marca: null, linea: null, compradores: [],
    cilindraje: null, carroceria: null, tipoServicio: null, ...over,
  } as never);

  it('TC-04: con valor, el SET lleva numMotor y numSerie con el valor de FLIT', () => {
    const set = setVehiculoDesdeFlit(tf({ numMotor: MOTOR, numSerie: SERIE }));
    expect(set).toMatchObject({ numMotor: MOTOR, numSerie: SERIE });
  });

  it('TC-05: vacío o ausente → las claves NO viajan (ni null): no se borra lo que puso el RUNT', () => {
    // `'  '` no entra: el puerto es `string | null` y el adaptador ya recortó espacios (TC-02).
    for (const caso of [tf(), tf({ numMotor: null, numSerie: null }), tf({ numMotor: '', numSerie: '' })]) {
      const set = setVehiculoDesdeFlit(caso);
      expect(Object.keys(set)).not.toContain('numMotor');
      expect(Object.keys(set)).not.toContain('numSerie');
    }
    // Campo a campo: el que viene se escribe y el otro no pisa.
    const solo = setVehiculoDesdeFlit(tf({ numSerie: SERIE }));
    expect(solo).toMatchObject({ numSerie: SERIE });
    expect(Object.keys(solo)).not.toContain('numMotor');
  });
});

// ───────────── Recorrido real: `sincronizar` → `upsertVehiculo` (ALTA e UPDATE) ─────────────

const T_VEHICLES = getTableName(vehicles);
const RANGO = { initialDate: '20260801', finalDate: '20260830' };
const VEHICULO_ID = 4242;
const TRAMITE_ID = 'dddd0000-0000-0000-0000-00000000000d';

const tramiteFlit = (over: Record<string, unknown> = {}) => ({
  idFlit: 'FLIT-099001', estadoFlit: 'Asignado', vin: '9FKTEST00000000001', placa: 'ZZZ001',
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'Ana', numeroDocumento: '1', correo: null, celular: null, direccion: null }],
  valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  numMotor: MOTOR, numSerie: SERIE,
  ...over,
});

const puertoConUno = (tf: Record<string, unknown>) => ({
  obtenerTramites: async () => [tf],
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

describe('Bug #12643 · sincronizar → upsertVehiculo — motor y serie LLEGAN a vehicles', () => {
  beforeEach(() => {
    kdb.reset();
    logMock.error.mockClear();
    organismoPorCodigoMock.mockReset().mockResolvedValue({ codigo: '25286' });
    companiaPorNitMock.mockReset().mockResolvedValue({
      id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true,
    });
    modalidadVigenteMock.mockReset().mockResolvedValue('autogestionado');
    kdb.when
      .select('vehicles', [])
      .select('flito_tramites', [])
      .insert('vehicles', [{ id: VEHICULO_ID }])
      .insert('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
  });

  const alta = (inserts: { tabla: string; values: Record<string, unknown> }[]) =>
    inserts.find((i) => i.tabla === T_VEHICLES)?.values;

  it('TC-06 (ALTA, VIN nuevo): el INSERT lleva numMotor y numSerie', async () => {
    const inserts = espiarInserts();
    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesNuevos).toBe(1);
    expect(alta(inserts)).toMatchObject({ vin: '9FKTEST00000000001', numMotor: MOTOR, numSerie: SERIE });
  });

  it('TC-07 (ALTA sin dato): no se inventa motor ni serie (ausente o null, nunca cadena)', async () => {
    const inserts = espiarInserts();
    await sincronizar(RANGO, puertoConUno(tramiteFlit({ numMotor: null, numSerie: null })));
    expect(logMock.error).not.toHaveBeenCalled();
    const values = alta(inserts)!;
    expect(ausente(values.numMotor)).toBe(true);
    expect(ausente(values.numSerie)).toBe(true);
  });

  it('TC-08 (UPDATE, VIN existente): el SET escribe los dos; y sin dato NO los toca (ni null)', async () => {
    kdb.when.select('vehicles', [{ id: VEHICULO_ID }]);
    const inserts = espiarInserts();
    const updates = espiarUpdates();

    await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(alta(inserts)).toBeUndefined();
    const set = updates.find((u) => u.tabla === T_VEHICLES)?.set;
    expect(set).toMatchObject({ plate: 'ZZZ001', numMotor: MOTOR, numSerie: SERIE });

    updates.length = 0;
    await sincronizar(RANGO, puertoConUno(tramiteFlit({ numMotor: null, numSerie: null })));
    const set2 = updates.find((u) => u.tabla === T_VEHICLES)?.set;
    expect(set2, 'hubo UPDATE de vehicles').toBeDefined();
    expect(Object.keys(set2!)).not.toContain('numMotor');
    expect(Object.keys(set2!)).not.toContain('numSerie');
  });
});
