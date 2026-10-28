// HU #14018 (Feature #14012, Épica #13760) — reintento de una incompleta de RENOVACIÓN (placa + documento).
// Diseño §3 «Reintento»; ADR-0030.
//
// Matriz AC → casos:
//   AC2  RUNT responde y pasa la compuerta → SOAT en `solicitado`, tipo renovacion, SIN factura, despachado al
//        gestor; la consulta va por placa + el documento del propietario (comprador orden 0).
//   AC4  RUNT sigue caído → sigue por validar (motivo intacto); `sin_soat_anterior` → descartada con ese motivo.
//   AC5  Inicial: la consulta es la de siempre (VIN, tipo 'inicial') y sin el cruce extra por VIN.
//   AC6  motivo ≠ runt_sin_respuesta → 409 `incompleta_no_reintentable`; el rastro de PII lleva la placa como token.
//
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const consultarMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  l.child.mockReturnValue(l);
  return l;
});

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/modules/flito-soat/flito-soat-cliente-runt.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  consultarYClasificar: consultarMock,
}));

const { extraerDatosCanal } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');

const COMPANIA = 7;
const ID = '1c0a0000-0000-4000-8000-00000000bb01';
const RESERVADO = '5e5e0000-0000-4000-8000-00000000cc01';
const PROVEEDOR = '55555555-5555-4555-8555-555555555555';
const RADICADOR = 4242;
const VIN = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
const T0 = new Date('2026-09-27T15:00:00Z');
const URL = `/api/flito/soat/cliente/incompletas/${ID}/reintentar`;

const DATOS = extraerDatosCanal({
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
    cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON', pasajerosSentados: '5',
    puertas: '5', organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
  },
});
const OK = { clase: 'ok', datos: DATOS, vinEfectivo: VIN, organismoCodigo: '25286' };

const fila = (over: Record<string, unknown> = {}) => ({
  id: ID, estado: 'incompleta', vin: VIN, companiaId: COMPANIA, intentos: 2,
  placa: null, tipoSoat: 'inicial', modalidadConsulta: 'vin', motivoPendiente: 'runt_sin_respuesta',
  soatIdReservado: RESERVADO, solicitadoPorId: RADICADOR, solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0,
  facturaStorageKey: `clientes/acme/soat/facturas-venta/${RESERVADO}.pdf`, facturaHash: 'a'.repeat(64),
  facturaNombreArchivo: 'factura.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1234,
  ...over,
});
const PROPIETARIO = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: 'ANA', apellidos: 'PÉREZ', razonSocial: null,
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Funza', departamento: 'Cundinamarca',
};

let sub = 14018_50;
async function auth(opts: { tipoPrincipal?: 'interno' | 'externo'; tipoEnlace?: string; funciones?: string[] } = {}) {
  sub += 1;
  await registrarUsuarioDePrueba(sub, {
    rol: 'rol_prueba', tipoPrincipal: opts.tipoPrincipal ?? 'interno', tipoEnlace: opts.tipoEnlace ?? 'ninguno',
    excepciones: [], funcionesDelRol: ['pagina.flito_soat', ...(opts.funciones ?? ['soat.solicitud.reintentar_runt'])],
  });
  const t = await new SignJWT({ username: 'pedro@flito.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

let router: express.Router;
async function buildApp() {
  const app = express();
  app.use(express.json());
  router = (await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js')).default;
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

/** Escenario base (alcance `todo`): incompleta abierta, VIN libre, compañía con gestor activo. */
function escenario(over: Record<string, unknown[]> = {}) {
  kdb.when.scenario({
    flito_soat_incompletas: [fila()],
    flito_soat: [],
    flito_compradores: [PROPIETARIO],
    vehicles: [],
    clients: [{ proveedorId: PROVEEDOR, activo: true }],
    ...over,
  });
  kdb.when.insert('vehicles', [{ id: 55 }]);
}

const reintentar = async (app: express.Express, token?: string) =>
  request(app).post(URL).set('Authorization', token ?? await auth()).send({});

const updatesIncompleta = () => espia.updatesEn('flito_soat_incompletas').map((m) => m.datos);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  piiMock.mockClear();
  auditMock.mockClear();
  consultarMock.mockReset().mockResolvedValue(OK);
  logMock.info.mockClear(); logMock.warn.mockClear(); logMock.error.mockClear();
});


const filaRenovacion = (over: Record<string, unknown> = {}) => fila({
  vin: null, placa: PLACA, tipoSoat: 'renovacion', modalidadConsulta: 'placa',
  facturaStorageKey: null, facturaHash: null, facturaNombreArchivo: null, facturaContentType: null, facturaTamanoBytes: null,
  ...over,
});
/**
 * Escenario de renovación. El doble devuelve la misma fila para cualquier SELECT sobre la tabla, así que
 * el orden de lecturas se fija con `selectOnce`: 1) la incompleta, 2) la búsqueda de OTRA abierta con el
 * VIN del RUNT (vacía por defecto; `hermanas` la puebla).
 */
const escenarioRenovacion = (over: Record<string, unknown[]> = {}, hermanas?: unknown[]) => {
  escenario({ flito_soat_incompletas: [filaRenovacion()], ...over });
  kdb.when.selectOnce('flito_soat_incompletas', [filaRenovacion()]);
  // Solo los caminos que llegan a la comprobación de hermanas (RUNT OK) consumen la segunda lectura.
  if (hermanas) kdb.when.selectOnce('flito_soat_incompletas', hermanas);
};

describe('AC2 — renovación: el RUNT responde → SOAT en solicitado y despachado SIN pedir factura', () => {
  it('consulta por placa + documento del propietario con tipo renovacion', async () => {
    escenarioRenovacion({}, []);
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(consultarMock).toHaveBeenCalledWith(
      { modalidad: 'placa', placa: PLACA, documento: PROPIETARIO.numeroDocumento }, 'renovacion');
  });

  it('crea el SOAT (id reservado, estado solicitado, VIN del RUNT), tipo renovacion, sin soporte, y cierra la incompleta con el VIN', async () => {
    escenarioRenovacion({}, []);
    const r = await reintentar(await buildApp());
    expect(r.body).toEqual({ resultado: 'completada', soatId: RESERVADO, estado: 'solicitado', vigenciaProxima: null });
    const soat = espia.ultimoInsertEn('flito_soat');
    expect(soat).toMatchObject({ id: RESERVADO, vin: VIN, estado: 'solicitado', proveedorSoatId: PROVEEDOR, gestionOperaciones: false });
    expect(espia.ultimoInsertEn('flito_soat_solicitud')).toMatchObject({ soatId: RESERVADO, tipoSoat: 'renovacion', soatAnteriorId: null });
    expect(espia.insertsEn('flito_soportes'), 'sin factura no hay soporte').toHaveLength(0);
    expect(updatesIncompleta().at(-1)).toMatchObject({ estado: 'completada', soatId: RESERVADO, vin: VIN });
  });

  it('con un SOAT terminal PROPIO del vehículo lo enlaza como antecesor (no es 409)', async () => {
    escenarioRenovacion({ flito_soat: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', estado: 'pagado', companiaId: COMPANIA, venceEl: '2025-01-01', createdAt: T0 }] }, []);
    const r = await reintentar(await buildApp());
    expect(r.body.resultado).toBe('completada');
    expect(espia.ultimoInsertEn('flito_soat_solicitud').soatAnteriorId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('otra incompleta abierta con el VIN que devolvió el RUNT → descartada solicitud_existente', async () => {
    escenarioRenovacion({}, [{ id: 'otra' }]);
    const r = await reintentar(await buildApp());
    expect(r.body).toMatchObject({ resultado: 'descartada', motivo: 'solicitud_existente' });
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });
});

describe('AC4 — renovación reintentada sin éxito', () => {
  it('RUNT sigue caído → sigue_incompleta con intentos + 1; el motivo pendiente no se toca', async () => {
    escenarioRenovacion();
    consultarMock.mockResolvedValue({ clase: 'caido', causa: 'timeout' });
    const r = await reintentar(await buildApp());
    expect(r.body.resultado).toBe('sigue_incompleta');
    const u = updatesIncompleta();
    expect(u[0]).toMatchObject({ intentos: 3, ultimaCausaCaida: 'timeout' });
    expect(u[0]).not.toHaveProperty('motivoPendiente');
    expect(u[0]).not.toHaveProperty('estado');
  });

  it('el RUNT dice que no hay SOAT anterior → descartada con motivo sin_soat_anterior (la fila no se borra)', async () => {
    escenarioRenovacion();
    consultarMock.mockResolvedValue({ clase: 'sin_soat_anterior' });
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'descartada', motivo: 'sin_soat_anterior', soatActivo: null });
    expect(updatesIncompleta().at(-1)).toMatchObject({ estado: 'descartada', motivoDescarte: 'sin_soat_anterior' });
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });
});

describe('AC5 — Inicial se reintenta EXACTAMENTE como hoy', () => {
  it('consulta por VIN (string) con tipo inicial, factura como soporte, tipo inicial en el satélite', async () => {
    escenario();
    const r = await reintentar(await buildApp());
    expect(r.body.resultado).toBe('completada');
    expect(consultarMock).toHaveBeenCalledWith(VIN, 'inicial');
    expect(espia.ultimoInsertEn('flito_soat_solicitud')).toMatchObject({ tipoSoat: 'inicial', soatAnteriorId: null });
    expect(espia.ultimoInsertEn('flito_soportes').storageKey).toBe(`clientes/acme/soat/facturas-venta/${RESERVADO}.pdf`);
  });
});

describe('AC6 — motivo no reintentable y rastro de PII', () => {
  it('motivo_pendiente ≠ runt_sin_respuesta → 409 incompleta_no_reintentable sin consultar el RUNT', async () => {
    escenario({ flito_soat_incompletas: [fila({ motivoPendiente: 'falta_factura_venta' })] });
    const r = await reintentar(await buildApp());
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('incompleta_no_reintentable');
    expect(consultarMock).not.toHaveBeenCalled();
    expect(updatesIncompleta()).toHaveLength(0);
  });

  it('el reintento por placa anota el acceso con la placa como token HMAC, nunca en claro', async () => {
    escenarioRenovacion();
    consultarMock.mockResolvedValue({ clase: 'caido', causa: 'red' });
    await reintentar(await buildApp());
    const motivo = JSON.stringify(piiMock.mock.calls.map((c) => c[1]));
    expect(motivo).toMatch(/placa=v1:/);
    expect(motivo).not.toContain(PLACA);
    expect(JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls])).not.toContain(PLACA);
  });
});
