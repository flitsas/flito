/**
 * HU #13627 — Bitácora de los trámites de FLIT 1 que fallan al aplicarse (`sincronizar` → catch →
 * `registrarFalloBitacoraSync(db, …)`). Cada trámite va en su propia transacción: el que falla deja su
 * «falló» fuera de ella y los demás siguen.
 *
 * Mock keyed: el 2.º trámite lanza al insertarse (espía de `.values()` sobre `flito_tramites`). La
 * deduplicación se prueba con lo que devuelve la lectura de `audit_logs`; su SQL real (LIKE + orden) se
 * prueba en la base en memoria de `flito-sync.flit2-lectura.test.ts`. Datos sintéticos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  organismoPorCodigo: vi.fn().mockResolvedValue({ codigo: '25286' }),
  companiaPorNit: vi.fn().mockResolvedValue({ id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true }),
  modalidadVigente: vi.fn().mockResolvedValue('autogestionado'),
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');

const CEDULA = '1023456789';
const CORREO = 'titular.sintetico@ejemplo.test';
const TRAMITE_ID = 'dddd0000-0000-0000-0000-000000013627';
const RANGO = { initialDate: '20261001', finalDate: '20261015' };
const R = ['FLIT-0136271', 'FLIT-0136272', 'FLIT-0136273'];

const tramiteFlit = (idFlit: string) => ({
  idFlit, estadoFlit: 'Asignado', vin: `9FKTEST0000${idFlit.slice(-7)}`, placa: null,
  ciudad: 'Medellín', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'TRANSITO EJEMPLO', organismoCodigo: '25286', fechaAprobacion: null, fechaCreacionFlit: null,
  tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'TITULAR SINTETICO', numeroDocumento: '1000013627', correo: null, celular: null, direccion: null }], valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  marca: 'M', linea: 'L', cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular', numMotor: 'M', numSerie: 'S',
});
const puerto = (lista: Record<string, unknown>[]) => ({
  obtenerTramites: async () => lista, obtenerUrlFactura: async () => null, marcarEntregado: async () => undefined,
} as never);

const errorConPii = (code: string | undefined = '23505') =>
  Object.assign(new Error(`duplicate key (numero_documento)=(${CEDULA}) correo ${CORREO}`), code ? { code } : {});

let audits: Record<string, unknown>[] = [];
/** Radicado → error con el que falla su INSERT en `flito_tramites`. */
let fallos = new Map<string, Error>();
let fallaAudit = false;

beforeEach(() => {
  kdb.reset();
  for (const m of Object.values(logMock)) m.mockClear();
  audits = []; fallos = new Map(); fallaAudit = false;
  kdb.when
    .select('vehicles', [{ id: 1 }])
    .select('flito_tramites', []); // todos nuevos (y la búsqueda del UUID del fallo no encuentra nada)
  kdb.insert.mockImplementation((tabla: unknown) => {
    const nombre = getTableName(tabla as never);
    let v: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    for (const m of ['returning', 'onConflictDoNothing', 'onConflictDoUpdate']) c[m] = () => c;
    c.values = (x: Record<string, unknown>) => { v = x; return c; };
    const run = async () => {
      if (nombre === 'flito_tramites') {
        const e = fallos.get(String(v.idFlit));
        if (e) throw e;
        return [{ id: TRAMITE_ID, idFlit: v.idFlit, flitEstado: 'Asignado', soatId: null, vehiculoId: 1, valorImpuestoLiquidado: null }];
      }
      if (nombre === 'audit_logs') {
        if (fallaAudit && String(v.detail).includes('falló')) throw new Error(`fallo simulado de la Bitácora ${CEDULA}`);
        audits.push(v);
      }
      return [{ id: 1 }];
    };
    c.then = (a: (x: unknown) => unknown, b?: (e: unknown) => unknown) => run().then(a, b);
    return c;
  });
});

const fallo = (radicado: string, codigo = '23505') => `[FLIT 1] fallo · radicado ${radicado} · error ${codigo} · falló`;

describe('HU #13627 · Bitácora de fallos (FLIT 1)', () => {
  it('AC1/AC4: de 3 trámites falla el 2.º → 1.º y 3.º «aplicado», 2.º «falló» con su código, resourceId null', async () => {
    fallos.set(R[1], errorConPii());
    const r = await sincronizar(RANGO, puerto(R.map(tramiteFlit)));
    expect(audits.map((a) => a.detail)).toEqual([
      `[FLIT 1] creación · radicado ${R[0]} · aplicado`,
      fallo(R[1]),
      `[FLIT 1] creación · radicado ${R[2]} · aplicado`,
    ]);
    expect(audits[1]).toMatchObject({ resource: 'flito_tramite', resourceId: null, userId: null, userEmail: 'sistema', action: 'update' });
    expect(r.tramitesNuevos).toBe(2);
  });

  it('AC1 (RN-B7): si el trámite ya existía (falla su UPDATE), la entrada de fallo lleva su UUID', async () => {
    const existente = {
      id: TRAMITE_ID, idFlit: R[1], fuente: 'flit', flitEstado: 'Asignado', facturaVentaFlitId: 'F-1', fechaAprobacion: null,
      companiaId: 7, organismoCodigo: '25286', tipoTramite: 'Otros', ciudad: 'Medellín', plateComplete: null,
      soatId: null, vehiculoId: 1, valorImpuestoLiquidado: null,
    };
    kdb.when
      .select('flito_tramites', [existente])
      .update('flito_tramites', () => { throw errorConPii(); });
    await sincronizar(RANGO, puerto([tramiteFlit(R[1])]));
    expect(audits).toEqual([expect.objectContaining({ detail: fallo(R[1]), resourceId: TRAMITE_ID })]);
  });

  it('AC1: sin código, el tipo es el nombre de la clase', async () => {
    class RevientaError extends Error {}
    fallos.set(R[1], new RevientaError(`dato ${CEDULA}`));
    await sincronizar(RANGO, puerto([tramiteFlit(R[1])]));
    expect(audits.map((a) => a.detail)).toEqual([fallo(R[1], 'RevientaError')]);
  });

  it('AC3: el mensaje con cédula y correo no llega ni al detail ni al log del servidor', async () => {
    fallos.set(R[1], errorConPii());
    await sincronizar(RANGO, puerto([tramiteFlit(R[1])]));
    expect(logMock.error).toHaveBeenCalledWith({ idFlit: R[1], err: '23505' }, 'no se pudo sincronizar el trámite');
    const todo = JSON.stringify([audits, logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls]);
    for (const x of [CEDULA, CORREO, 'duplicate key']) expect(todo).not.toContain(x);
  });

  it('AC5: si la entrada de fallo tampoco se escribe, la corrida sigue y el log no lleva PII', async () => {
    fallos.set(R[1], errorConPii());
    fallaAudit = true;
    const r = await sincronizar(RANGO, puerto(R.map(tramiteFlit)));
    expect(r.tramitesNuevos).toBe(2);
    expect(audits.map((a) => a.detail)).toEqual([
      `[FLIT 1] creación · radicado ${R[0]} · aplicado`, `[FLIT 1] creación · radicado ${R[2]} · aplicado`,
    ]);
    expect(logMock.error).toHaveBeenCalledWith({ fuente: 'FLIT 1', radicado: R[1], err: 'Error' }, expect.stringContaining('Bitácora'));
    const todo = JSON.stringify(logMock.error.mock.calls);
    for (const x of [CEDULA, CORREO, 'fallo simulado']) expect(todo).not.toContain(x);
  });

  it('RN-B6: si la última entrada del radicado ya es ese mismo «falló», no se escribe otra; con otro código, sí', async () => {
    fallos.set(R[1], errorConPii('23505'));
    kdb.when.select('audit_logs', [{ detail: fallo(R[1], '23505') }]);
    await sincronizar(RANGO, puerto([tramiteFlit(R[1])]));
    expect(audits).toEqual([]);
    fallos.set(R[1], errorConPii('23514'));
    await sincronizar(RANGO, puerto([tramiteFlit(R[1])]));
    expect(audits.map((a) => a.detail)).toEqual([fallo(R[1], '23514')]);
  });
});
