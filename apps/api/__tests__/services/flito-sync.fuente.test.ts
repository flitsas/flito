// HU #13070 · AC2 — el sync de FLIT (FLIT 1) no escribe ni pisa `flito_tramites.fuente`.
//
// Un trámite nuevo nace con el DEFAULT 'flit' de la columna (migración 0213) y re-sincronizarlo no
// le cambia la fuente: ni el INSERT ni el UPDATE del upsert llevan la clave. Si la llevaran, un
// trámite que FLIT 2 hubiera creado con el mismo id quedaría re-etiquetado por el sync de FLIT 1.
// Recorrido real de `sincronizar` sobre el keyed-db, igual que flito-sync.motor-serie-bug12643.
//
// HU #13091 (AC4, TC-23/TC-24): una fila con `fuente='flit2'` la trajo FLIT 2 y el sync de FLIT 1 no
// la toca (ni el trámite ni su vehículo); una con `fuente='flit'` se actualiza como siempre. Por eso
// el caso «re-sincronizar» usa ahora una fila `fuente='flit'` (antes era 'flit2', que desde esta HU
// es precisamente la que se omite); su aserto no cambia.

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
  return { ...real, organismoPorCodigo: organismoPorCodigoMock, companiaPorNit: companiaPorNitMock, modalidadVigente: modalidadVigenteMock };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { flitoTramites } = await import('../../src/db/schema.js');

const T_TRAMITES = getTableName(flitoTramites);
const RANGO = { initialDate: '20260801', finalDate: '20260830' };
const TRAMITE_ID = 'dddd0000-0000-0000-0000-00000000000e';

// Datos sintéticos: ningún VIN, placa ni documento real.
const tramiteFlit = () => ({
  idFlit: 'FLIT-099002', estadoFlit: 'Asignado', vin: '9FKTEST00000000002', placa: 'ZZZ002',
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-2', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'Ana', numeroDocumento: '1', correo: null, celular: null, direccion: null }],
  valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
});
const puertoConUno = (tf: Record<string, unknown>) => ({
  obtenerTramites: async () => [tf], obtenerUrlFactura: async () => null, marcarEntregado: async () => undefined,
} as never);

function espiar(metodo: 'insert' | 'update', clave: 'values' | 'set') {
  const vistos: { tabla: string; datos: Record<string, unknown> }[] = [];
  const base = kdb[metodo].getMockImplementation()!;
  kdb[metodo].mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const orig = c[clave] as (v: unknown) => unknown;
    c[clave] = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), datos: v as Record<string, unknown> });
      return orig(v);
    };
    return c;
  });
  return vistos;
}

describe('HU #13070 · AC2 — el sync de FLIT no escribe ni pisa la fuente', () => {
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
      .insert('vehicles', [{ id: 4243 }])
      .insert('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
  });

  it('trámite nuevo: el INSERT de flito_tramites no lleva fuente (nace con el DEFAULT flit)', async () => {
    const inserts = espiar('insert', 'values');
    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesNuevos).toBe(1);
    const alta = inserts.find((i) => i.tabla === T_TRAMITES)?.datos;
    expect(alta, 'hubo INSERT de flito_tramites').toBeDefined();
    expect(alta!.idFlit).toBe('FLIT-099002');
    expect(Object.keys(alta!)).not.toContain('fuente');
  });

  it('re-sincronizar: el UPDATE de flito_tramites no lleva fuente (no la pisa)', async () => {
    kdb.when
      .select('vehicles', [{ id: 4243 }])
      .select('flito_tramites', [{
        id: TRAMITE_ID, idFlit: 'FLIT-099002', fuente: 'flit', flitEstado: 'Asignado', facturaVentaFlitId: 'F-2',
        fechaAprobacion: null, companiaId: 7, organismoCodigo: '25286', tipoTramite: 'Otros', ciudad: 'FUNZA', soatId: null,
      }])
      .update('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
    const updates = espiar('update', 'set');
    await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    const set = updates.find((u) => u.tabla === T_TRAMITES)?.datos;
    expect(set, 'hubo UPDATE de flito_tramites').toBeDefined();
    expect(set!.flitEstado).toBe('Asignado');
    expect(Object.keys(set!)).not.toContain('fuente');
  });

  it('HU #13091 · TC-23: una fila con fuente flit2 no se toca (ni trámite, ni vehículo, ni historial)', async () => {
    kdb.when
      .select('vehicles', [{ id: 4243 }])
      .select('flito_tramites', [{
        id: TRAMITE_ID, idFlit: 'FLIT-099002', fuente: 'flit2', flitEstado: 'Aprobado', facturaVentaFlitId: null,
        fechaAprobacion: null, companiaId: 7, organismoCodigo: '25286', tipoTramite: 'Matricula', ciudad: 'FUNZA', soatId: null,
      }]);
    const updates = espiar('update', 'set');
    const inserts = espiar('insert', 'values');
    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesOmitidosOtraFuente).toBe(1);
    expect(r.tramitesNuevos + r.tramitesActualizados + r.tramitesSinCambios).toBe(0);
    expect(updates.map((u) => u.tabla)).toEqual([]);
    expect(inserts.map((i) => i.tabla)).toEqual([]);
  });

  it('HU #13091 · TC-24: una fila con fuente flit se sigue actualizando (la guarda solo filtra flit2)', async () => {
    kdb.when
      .select('vehicles', [{ id: 4243 }])
      .select('flito_tramites', [{
        id: TRAMITE_ID, idFlit: 'FLIT-099002', fuente: 'flit', flitEstado: 'Aprobado', facturaVentaFlitId: 'F-2',
        fechaAprobacion: null, companiaId: 7, organismoCodigo: '25286', tipoTramite: 'Otros', ciudad: 'FUNZA', soatId: null,
      }])
      .update('flito_tramites', [{ id: TRAMITE_ID, soatId: null }]);
    const updates = espiar('update', 'set');
    const r = await sincronizar(RANGO, puertoConUno(tramiteFlit()));
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r.tramitesOmitidosOtraFuente).toBe(0);
    expect(r.tramitesActualizados).toBe(1);
    expect(updates.find((u) => u.tabla === T_TRAMITES)?.datos.flitEstado).toBe('Asignado');
    expect(updates.some((u) => u.tabla === 'vehicles')).toBe(true);
  });
});
