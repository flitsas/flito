// HU #13629 (Feature #13612, Épica #13576) — AC6: FLIT 1 solo escribe lo que cambió. Un trámite y un
// vehículo idénticos a lo guardado no hacen UPDATE (no mueven `updated_at`), no dejan historial ni
// Bitácora y no reemplazan compradores. AC9: el invariante del Bug #13585 (anulado = `soloAlta`, placa
// vacía no borra) y FLIT 2 intacto (sin la opción, escribe como antes).
//
// Los asertos van sobre lo que VIAJA a la base (espías de `.set()`/`.values()`/`.delete()` y la proyección
// del `select`), no sobre lo que devuelve el mock keyed, que entrega la fila configurada sin mirar la
// proyección (memoria «mock chain inventa columnas»). Datos SINTÉTICOS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const param = vi.hoisted(() => ({ organismoPorCodigo: vi.fn(), companiaPorNit: vi.fn(), modalidadVigente: vi.fn() }));
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), ...param,
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { sincronizar, upsertVehiculo, escribirTramite } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { jsonIgual, mismoValor, tramiteCambia, parcheVehiculo, compradoresIguales } =
  await import('../../src/modules/flito-sync/solo-si-cambia.js');

const VIN = '9FKTEST00000013629';
const VEHICULO_ID = 13629;
const TRAMITE_ID = 'eeee0000-0000-0000-0000-000000013629';
const RANGO = { initialDate: '20261009', finalDate: '20261017' };
const VIEJO = new Date('2026-10-01T00:00:00Z');

const tramiteFlit = (over: Record<string, unknown> = {}) => ({
  idFlit: 'FLIT-013629', estadoFlit: 'Aprobado', vin: VIN, placa: 'ZZZ629',
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: '2026-10-10T15:00:00.000Z', fechaCreacionFlit: '2026-10-09T15:00:00.000Z', tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'TITULAR SINTETICO', numeroDocumento: '1000000001', correo: 'x@ejemplo.test', celular: '3000000000', direccion: 'CALLE 1' }],
  valorImpuestoLiquidado: 1000, processStatus: 5,
  raw: { Id: 'FLIT-013629', b: 1, a: { y: 2, x: 1 } },
  marca: 'MARCA', linea: 'LINEA', cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  numMotor: 'MTR-1', numSerie: 'SER-1',
  ...over,
});
const puerto = (lista: Record<string, unknown>[]) => ({
  obtenerTramites: async () => lista, obtenerUrlFactura: async () => null, marcarEntregado: async () => undefined,
} as never);

/** Vehículo guardado: lo mismo que FLIT 1 escribiría hoy. */
const VEHICULO_GUARDADO = {
  id: VEHICULO_ID, plate: 'ZZZ629', brand: 'MARCA', model: 'LINEA', ownerName: 'TITULAR SINTETICO', ownerDocument: '1000000001',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular', numMotor: 'MTR-1', numSerie: 'SER-1',
};

interface Visto { tabla: string; dato: unknown }
function espiar() {
  const updates: Visto[] = []; const inserts: Visto[] = []; const deletes: string[] = []; const selects: Visto[] = [];
  const envolver = (fn: typeof kdb.update, metodo: 'set' | 'values', destino: Visto[]) => {
    const base = fn.getMockImplementation()!;
    fn.mockImplementation((tabla: unknown) => {
      const c = base(tabla) as Record<string, unknown>;
      const orig = c[metodo] as (v: unknown) => unknown;
      c[metodo] = (v: unknown) => { destino.push({ tabla: getTableName(tabla as never), dato: v }); return orig(v); };
      return c;
    });
  };
  envolver(kdb.update, 'set', updates);
  envolver(kdb.insert, 'values', inserts);
  const baseDel = kdb.delete.getMockImplementation()!;
  kdb.delete.mockImplementation((tabla: unknown) => { deletes.push(getTableName(tabla as never)); return baseDel(tabla); });
  const baseSel = kdb.select.getMockImplementation()!;
  kdb.select.mockImplementation((proj: unknown) => {
    const c = baseSel(proj) as Record<string, unknown>;
    const from = c.from as (t: unknown) => unknown;
    c.from = (t: unknown) => { selects.push({ tabla: getTableName(t as never), dato: proj ? Object.keys(proj as object) : '*' }); return from(t); };
    return c;
  });
  const de = (l: Visto[], t: string) => l.filter((x) => x.tabla === t).map((x) => x.dato as Record<string, unknown>);
  return { updates, inserts, deletes, selects, de };
}

/** Primera pasada (alta) para obtener lo que se guardó, «como en la base». */
async function guardadoComoEnLaBase() {
  kdb.when.select('vehicles', []).select('flito_tramites', []).select('flito_compradores', [])
    .insert('vehicles', [{ id: VEHICULO_ID }]).insert('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
  const e = espiar();
  await sincronizar(RANGO, puerto([tramiteFlit()]));
  const [valores] = e.de(e.inserts, 'flito_tramites');
  const compradores = (e.de(e.inserts, 'flito_compradores')[0] as unknown as Record<string, unknown>[])
    .map(({ tramiteId: _t, ...c }) => c);
  kdb.reset();
  const raw = valores.flitRaw as Record<string, unknown>;
  return {
    tramite: {
      ...valores, id: TRAMITE_ID, soatId: null, fuente: 'flit', createdAt: VIEJO, updatedAt: VIEJO, sincronizadoEn: VIEJO,
      // Como lo devuelve Postgres: numeric con escala, jsonb con las claves reordenadas, fechas nuevas.
      valorImpuestoLiquidado: '1000.00',
      flitRaw: { a: { x: 1, y: 2 }, b: 1, Id: raw.Id },
      fechaAprobacion: new Date(String((valores.fechaAprobacion as Date).toISOString())),
    },
    compradores,
  };
}

let G: Awaited<ReturnType<typeof guardadoComoEnLaBase>>;

beforeEach(async () => {
  kdb.reset();
  for (const m of Object.values(logMock)) m.mockClear();
  param.organismoPorCodigo.mockReset().mockResolvedValue({ codigo: '25286' });
  param.companiaPorNit.mockReset().mockResolvedValue({ id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true });
  param.modalidadVigente.mockReset().mockResolvedValue('autogestionado');
  G = await guardadoComoEnLaBase();
  kdb.when.select('vehicles', [VEHICULO_GUARDADO]).select('flito_tramites', [G.tramite])
    .select('flito_compradores', G.compradores).update('flito_tramites', [G.tramite]);
});

describe('HU #13629 · AC6 · FLIT 1 con todo idéntico', () => {
  it('sin UPDATE de trámite ni de vehículo, sin reemplazar compradores, sin historial ni Bitácora', async () => {
    const e = espiar();
    const r = await sincronizar(RANGO, puerto([tramiteFlit()]));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r).toMatchObject({ tramitesSinCambios: 1, tramitesActualizados: 0, tramitesNuevos: 0, tramitesFallidos: 0 });
    expect(e.updates).toEqual([]);
    expect(e.deletes).toEqual([]);
    expect(e.inserts).toEqual([]);
  });

  it('el vehículo se compara leyendo las 10 columnas que escribe el sync', async () => {
    const e = espiar();
    await sincronizar(RANGO, puerto([tramiteFlit()]));
    const proyecciones = e.selects.filter((s) => s.tabla === 'vehicles').map((s) => s.dato);
    expect(proyecciones).toEqual([['id'], [
      'plate', 'brand', 'model', 'ownerName', 'ownerDocument', 'cilindraje', 'carroceria', 'tipoServicio', 'numMotor', 'numSerie',
    ]]);
  });
});

describe('HU #13629 · AC6 · FLIT 1 con un cambio', () => {
  it('un campo del trámite cambia: UPDATE del trámite (con historial), el vehículo sigue intacto', async () => {
    const e = espiar();
    const r = await sincronizar(RANGO, puerto([tramiteFlit({ ciudad: 'MOSQUERA' })]));
    expect(r.tramitesActualizados).toBe(1);
    const sets = e.de(e.updates, 'flito_tramites');
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ ciudad: 'MOSQUERA' });
    expect(sets[0].updatedAt).toBeInstanceOf(Date);
    expect(e.de(e.updates, 'vehicles')).toEqual([]);
    expect(e.deletes).toEqual([]);
  });

  it('solo el flit_raw cambia de verdad (no de orden): hay UPDATE', async () => {
    const e = espiar();
    await sincronizar(RANGO, puerto([tramiteFlit({ raw: { Id: 'FLIT-013629', b: 1, a: { y: 3, x: 1 } } })]));
    expect(e.de(e.updates, 'flito_tramites')).toHaveLength(1);
  });

  it('P-4: un cambio solo del vehículo escribe SOLO esa columna y el trámite cuenta «sin cambios»', async () => {
    const e = espiar();
    const r = await sincronizar(RANGO, puerto([tramiteFlit({ marca: 'MARCA NUEVA' })]));
    const sets = e.de(e.updates, 'vehicles');
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0]).sort()).toEqual(['brand', 'updatedAt']);
    expect(sets[0].brand).toBe('MARCA NUEVA');
    expect(e.de(e.updates, 'flito_tramites')).toEqual([]);
    expect(r.tramitesSinCambios).toBe(1);
  });

  it('un comprador cambia: se reemplazan los compradores; el trámite no se reescribe', async () => {
    const e = espiar();
    const compradores = [{ ...tramiteFlit().compradores[0], celular: '3009999999' }];
    await sincronizar(RANGO, puerto([tramiteFlit({ compradores })]));
    expect(e.deletes).toEqual(['flito_compradores']);
    expect(e.de(e.inserts, 'flito_compradores')).toHaveLength(1);
    expect(e.de(e.updates, 'flito_tramites')).toEqual([]);
  });
});

describe('HU #13629 · AC9 · invariantes del Bug #13585', () => {
  it('anulado con VIN existente: ni lee las columnas del vehículo ni lo actualiza', async () => {
    const e = espiar();
    await sincronizar(RANGO, puerto([tramiteFlit({ estadoFlit: 'Anulado', placa: null, marca: 'OTRA' })]));
    expect(e.selects.filter((s) => s.tabla === 'vehicles').map((s) => s.dato)).toEqual([['id']]);
    expect(e.de(e.updates, 'vehicles')).toEqual([]);
  });

  it('placa vacía con el resto idéntico: no hay UPDATE del vehículo (la placa no se borra)', async () => {
    const e = espiar();
    await sincronizar(RANGO, puerto([tramiteFlit({ placa: null })]));
    expect(e.de(e.updates, 'vehicles')).toEqual([]);
  });

  it('placa vacía con otra columna cambiada: el parche no lleva `plate`', async () => {
    const e = espiar();
    await sincronizar(RANGO, puerto([tramiteFlit({ placa: null, cilindraje: '2000' })]));
    const [set] = e.de(e.updates, 'vehicles');
    expect(Object.keys(set).sort()).toEqual(['cilindraje', 'updatedAt']);
  });
});

describe('HU #13629 · FLIT 2 intacto (sin la opción)', () => {
  it('upsertVehiculo sin soloSiCambia hace UPDATE aunque sea idéntico y no lee columnas', async () => {
    const e = espiar();
    await upsertVehiculo(kdb.db as never, tramiteFlit() as never, 7);
    expect(e.de(e.updates, 'vehicles')).toHaveLength(1);
    expect(e.selects.filter((s) => s.tabla === 'vehicles')).toHaveLength(1);
  });

  it('escribirTramite sin soloSiCambia hace UPDATE aunque sea idéntico', async () => {
    const e = espiar();
    const { sincronizadoEn: _s, id: _i, idFlit: _f, createdAt: _c, ...valores } = G.tramite as Record<string, unknown>;
    await escribirTramite(kdb.db as never, G.tramite as never, 'FLIT-013629', { ...valores, sincronizadoEn: new Date() } as never);
    expect(e.de(e.updates, 'flito_tramites')).toHaveLength(1);
  });
});

describe('HU #13629 · comparaciones puras', () => {
  it('jsonIgual ignora el orden de claves pero no el de los arrays', () => {
    expect(jsonIgual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(jsonIgual([1, 2], [2, 1])).toBe(false);
    expect(jsonIgual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(jsonIgual({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it('mismoValor: fechas por instante, numérico por valor, null = undefined', () => {
    expect(mismoValor('fechaAprobacion', new Date('2026-10-10T15:00:00Z'), new Date('2026-10-10T15:00:00.000Z'))).toBe(true);
    expect(mismoValor('valorImpuestoLiquidado', '1000.00', '1000')).toBe(true);
    expect(mismoValor('valorImpuestoLiquidado', '1000.50', '1000')).toBe(false);
    expect(mismoValor('ciudad', null, undefined)).toBe(true);
    expect(mismoValor('ciudad', 'A', null)).toBe(false);
  });

  it('tramiteCambia ignora sincronizadoEn; parcheVehiculo solo trae lo distinto', () => {
    expect(tramiteCambia({ ciudad: 'A', sincronizadoEn: VIEJO }, { ciudad: 'A', sincronizadoEn: new Date() })).toBe(false);
    expect(tramiteCambia({ ciudad: 'A' }, { ciudad: 'B' })).toBe(true);
    expect(parcheVehiculo({ plate: 'X', brand: 'M' }, { plate: 'X', brand: 'N' })).toEqual({ brand: 'N' });
  });

  it('compradoresIguales exige mismos órdenes, campos y porcentaje', () => {
    const c = { orden: 0, nombreCompleto: 'A', numeroDocumento: '1', correo: null, celular: null, direccion: null, porcentajeParticipacion: '100.00' };
    expect(compradoresIguales([c], [{ ...c, porcentajeParticipacion: 100 }])).toBe(true);
    expect(compradoresIguales([c], [{ ...c, orden: 1 }])).toBe(false);
    expect(compradoresIguales([c], [{ ...c, porcentajeParticipacion: 50 }])).toBe(false);
    expect(compradoresIguales([c], [c, { ...c, orden: 1 }])).toBe(false);
  });
});
