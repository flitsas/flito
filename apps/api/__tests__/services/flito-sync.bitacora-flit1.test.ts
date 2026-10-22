/**
 * HU #13626 — Bitácora de la sincronización, fuente FLIT 1 (`upsertTramite` → `registrarBitacoraSync`).
 * Diseño: `docs/diseno/hu-13626-bitacora-cambios-sync.md`.
 *
 * Mock keyed (devuelve la fila configurada, ignora la proyección): los asertos van sobre lo que realmente
 * viaja a `audit_logs` y a `flito_tramite_historial` (espía de `.values()`), no sobre lo que devuelve el
 * select. La lectura de compradores guardados se prueba ANTES del reemplazo con un resolver que responde
 * vacío si ya pasó el DELETE: leídos después, la entrada diría «compradores: 0 → 1» en vez del campo.
 *
 * Datos sintéticos: ningún documento, celular, placa ni VIN real.
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
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  organismoPorCodigo: organismoPorCodigoMock, companiaPorNit: companiaPorNitMock, modalidadVigente: modalidadVigenteMock,
}));

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');

const VIN = '9FKTEST00000013626';
const PLACA = 'ZZZ626';
const DOC = '1000013626';
const NOMBRE = 'TITULAR SINTETICO';
const CEL_ANTES = '3000013626';
const CEL_DESPUES = '3999913626';
const TRAMITE_ID = 'dddd0000-0000-0000-0000-000000013626';
const RADICADO = 'FLIT-013626';
const RANGO = { initialDate: '20261001', finalDate: '20261015' };

const tramiteFlit = (over: Record<string, unknown> = {}) => ({
  idFlit: RADICADO, estadoFlit: 'Asignado', vin: VIN, placa: PLACA,
  ciudad: 'Medellín', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'TRANSITO EJEMPLO', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: NOMBRE, numeroDocumento: DOC, correo: null, celular: CEL_ANTES, direccion: null }],
  valorImpuestoLiquidado: null, processStatus: 5, raw: {},
  marca: 'MARCA', linea: 'LINEA', cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular', numMotor: 'M', numSerie: 'S',
  ...over,
});

/** El trámite ya guardado: lo mismo que `tramiteFlit()` traería. */
const existente = (over: Record<string, unknown> = {}) => ({
  id: TRAMITE_ID, idFlit: RADICADO, fuente: 'flit', flitEstado: 'Asignado', facturaVentaFlitId: 'F-1', fechaAprobacion: null,
  companiaId: 7, organismoCodigo: '25286', tipoTramite: 'Otros', ciudad: 'Medellín', plateComplete: PLACA,
  soatId: null, vehiculoId: 1, valorImpuestoLiquidado: null, ...over,
});

/** Como lo devuelve la BD: numeric '100.00' y texto vacío donde FLIT manda null (riesgo de falso «cambió»). */
const guardado = (over: Record<string, unknown> = {}) => ({
  orden: 0, numeroDocumento: DOC, nombreCompleto: NOMBRE, correo: '', celular: CEL_ANTES, direccion: null,
  porcentajeParticipacion: '100.00', ...over,
});

const puerto = (lista: Record<string, unknown>[]) => ({
  obtenerTramites: async () => lista, obtenerUrlFactura: async () => null, marcarEntregado: async () => undefined,
} as never);

let vistos: { tabla: string; values: Record<string, unknown> }[] = [];
let borroCompradores = false;

function espiar(): void {
  vistos = [];
  borroCompradores = false;
  const ins = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tabla: unknown) => {
    const c = ins(tabla) as Record<string, unknown>;
    const values = c.values as (v: unknown) => unknown;
    c.values = (v: unknown) => {
      for (const fila of Array.isArray(v) ? v : [v]) vistos.push({ tabla: getTableName(tabla as never), values: fila as Record<string, unknown> });
      return values(v);
    };
    return c;
  });
  const del = kdb.delete.getMockImplementation()!;
  kdb.delete.mockImplementation((tabla: unknown) => {
    if (getTableName(tabla as never) === 'flito_compradores') borroCompradores = true;
    return del(tabla);
  });
}

const audits = () => vistos.filter((v) => v.tabla === 'audit_logs').map((v) => v.values);
const historial = () => vistos.filter((v) => v.tabla === 'flito_tramite_historial').map((v) => v.values);

/** Escenario de actualización: trámite guardado + compradores guardados (vacío si ya se borraron). */
function guardados(tramite: Record<string, unknown>, compradores: Record<string, unknown>[]): void {
  kdb.when
    .select('flito_tramites', [tramite])
    .select('flito_compradores', () => (borroCompradores ? [] : compradores))
    .update('flito_tramites', [tramite]);
}

beforeEach(() => {
  kdb.reset();
  organismoPorCodigoMock.mockReset().mockResolvedValue({ codigo: '25286' });
  // Compañía que autogestiona SOAT e impuesto: el arranque no crea nada y no deja su propio audit.
  companiaPorNitMock.mockReset().mockResolvedValue({ id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: true });
  modalidadVigenteMock.mockReset().mockResolvedValue('autogestionado');
  kdb.when
    .select('vehicles', [{ id: 1 }])
    .insert('flito_tramites', [existente()]);
  espiar();
});

describe('HU #13626 · Bitácora FLIT 1', () => {
  it('AC1: Asignado → Aprobado deja UNA entrada «cambio de estado» con radicado y «aplicado», sin la vieja «Estado FLIT»', async () => {
    guardados(existente(), [guardado()]);
    const r = await sincronizar(RANGO, puerto([tramiteFlit({ estadoFlit: 'Aprobado' })]));
    expect(audits()).toEqual([expect.objectContaining({
      resource: 'flito_tramite', resourceId: TRAMITE_ID, action: 'update', userId: null, userEmail: 'sistema',
      detail: `[FLIT 1] cambio de estado · radicado ${RADICADO} · estado: Asignado → Aprobado · aplicado`,
    })]);
    expect(audits().some((a) => String(a.detail).startsWith('Estado FLIT'))).toBe(false);
    // AC8: el historial sigue igual (una fila por campo, solo el estado).
    expect(historial()).toEqual([expect.objectContaining({ campo: 'flit_estado', valorAnterior: 'Asignado', valorNuevo: 'Aprobado', origen: 'api' })]);
    expect(r.tramitesActualizados).toBe(1);
  });

  it('AC2: cambia el celular del comprador (leído ANTES del reemplazo) → «cambió celular», sin el valor anterior ni el nuevo', async () => {
    guardados(existente(), [guardado()]);
    const tf = tramiteFlit();
    (tf.compradores as Record<string, unknown>[])[0].celular = CEL_DESPUES;
    await sincronizar(RANGO, puerto([tf]));
    expect(audits()).toEqual([expect.objectContaining({
      action: 'update', resourceId: TRAMITE_ID,
      detail: `[FLIT 1] cambio de datos · radicado ${RADICADO} · cambió celular (comprador 1) · aplicado`,
    })]);
    const texto = JSON.stringify(audits());
    for (const x of [CEL_ANTES, CEL_DESPUES, DOC, NOMBRE, PLACA]) expect(texto).not.toContain(x);
    expect(historial()).toEqual([]); // AC8: los compradores de FLIT 1 nunca dejaron historial
  });

  it('AC3: ciudad Medellín → Bogotá deja «ciudad: Medellín → Bogotá», tipo «cambio de datos»', async () => {
    guardados(existente(), [guardado()]);
    await sincronizar(RANGO, puerto([tramiteFlit({ ciudad: 'Bogotá' })]));
    expect(audits().map((a) => a.detail)).toEqual([
      `[FLIT 1] cambio de datos · radicado ${RADICADO} · ciudad: Medellín → Bogotá · aplicado`,
    ]);
  });

  it('AC4: la creación deja «creación» con fuente, radicado y «aplicado», sin PII de compradores', async () => {
    kdb.when.select('flito_tramites', []);
    const r = await sincronizar(RANGO, puerto([tramiteFlit()]));
    expect(r.tramitesNuevos).toBe(1);
    expect(audits()).toEqual([expect.objectContaining({
      resource: 'flito_tramite', resourceId: TRAMITE_ID, action: 'create', userEmail: 'sistema',
      detail: `[FLIT 1] creación · radicado ${RADICADO} · aplicado`,
    })]);
    const texto = JSON.stringify(audits());
    for (const x of [CEL_ANTES, DOC, NOMBRE, PLACA]) expect(texto).not.toContain(x);
  });

  it('AC5/AC6 FLIT 1: releer el mismo trámite y el mismo comprador («100.00» frente a 100, «» frente a null) → 0 entradas', async () => {
    guardados(existente(), [guardado()]);
    const r = await sincronizar(RANGO, puerto([tramiteFlit({ raw: { otro: 'crudo' } })]));
    expect(audits()).toEqual([]);
    expect(historial()).toEqual([]);
    expect(r.tramitesSinCambios).toBe(1);
  });

  it('decisión del hilo: estado y datos a la vez → tipo «cambio de estado» y lista también los datos', async () => {
    guardados(existente(), [guardado()]);
    const tf = tramiteFlit({ estadoFlit: 'Aprobado', ciudad: 'Bogotá' });
    (tf.compradores as Record<string, unknown>[])[0].correo = 'nuevo@ejemplo.test';
    await sincronizar(RANGO, puerto([tf]));
    expect(audits().map((a) => a.detail)).toEqual([
      `[FLIT 1] cambio de estado · radicado ${RADICADO} · estado: Asignado → Aprobado; ciudad: Medellín → Bogotá; cambió correo (comprador 1) · aplicado`,
    ]);
    expect(JSON.stringify(audits())).not.toContain('nuevo@ejemplo.test');
  });

  it('Nota (AC8): un cambio solo de placa deja «cambió placa» en la Bitácora, sin historial y sin contar como cambio', async () => {
    guardados(existente(), [guardado()]);
    const r = await sincronizar(RANGO, puerto([tramiteFlit({ placa: 'YYY626' })]));
    expect(audits().map((a) => a.detail)).toEqual([`[FLIT 1] cambio de datos · radicado ${RADICADO} · cambió placa · aplicado`]);
    expect(JSON.stringify(audits())).not.toContain('YYY626');
    expect(historial()).toEqual([]);
    expect(r.tramitesSinCambios).toBe(1);
  });
});
