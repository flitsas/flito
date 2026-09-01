// HU #11935 — verificación RUNT post-201 del canal Cliente.
//
// El alta responde 201 sin esperar a Kyverum. Este archivo flushea el `setImmediate` y afirma
// sobre lo que el job ESCRIBIÓ: estado de verificación, backfill de vehicles/organismo, y
// cero jsonb crudo. Un AC por bloque.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);
const logInfo = vi.fn();
const logWarn = vi.fn();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));
vi.mock('../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: logInfo, warn: logWarn, error: vi.fn() }) },
  loggerFor: () => ({ info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

function runtOk(over: Record<string, unknown> = {}, soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: 'JNH38H', vin: '9FKRG2222T2042405',
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
        ...over,
      },
      soat,
    },
  };
}

let sub = 300;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: string, id: number) =>
  `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: role as never })}`;

function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme' }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}

/**
 * El job corre en `setImmediate` y a menudo ANTES de que el test reciba el 201 (el await
 * HTTP deja pasar el event loop). Hay que registrar la fila del SELECT del job ANTES del
 * POST, pero RN-01 también lee `flito_soat` y tiene que ver vacío. El resolver distingue:
 * si aún no hubo INSERT, es la RN-01; si ya hay id, es el job.
 */
function prepararAltaYJob(jobOver: Record<string, unknown> = {}) {
  escenario();
  kdb.when.select('flito_soat', () => {
    const ins = espia.ultimoInsertEn('flito_soat');
    if (!ins.id) return [];
    return [filaParaJob(String(ins.id), jobOver)];
  });
}

const CAMPOS: Record<string, string> = {
  placa: 'jnh38h', vin: '9fkrg2222t2042405',
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombreCompleto: 'JUANA PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
};

function alta(app: express.Express, token: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const flush = () => new Promise<void>((r) => setImmediate(r));

async function flushJob(): Promise<void> {
  await flush();
  await flush();
  await flush();
}

/** Lo que el job lee de `flito_soat` (from + joins). Hay que registrarlo ANTES del flush. */
function filaParaJob(soatId: string, over: Record<string, unknown> = {}) {
  return {
    soatId,
    vin: '9FKRG2222T2042405',
    vehiculoId: VEHICULO_ID,
    placa: 'JNH38H',
    verificacionEstado: 'pendiente',
    solicitadoPorId: sub,
    solicitadoPorNombre: 'cliente@empresa.co',
    tipoDocumento: 'CC',
    numeroDocumento: '1020304050',
    ...over,
  };
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
});

describe('verificación RUNT post-201', () => {
  it('camino feliz: satélite `ok`, rellena vehicles y organismo; Kyverum con documento (Bug #11927)', async () => {
    prepararAltaYJob();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(201);
    await flushJob();

    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(
      'JNH38H', '9FKRG2222T2042405', '1020304050', 'C',
    );

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('ok');
    expect(sat.soatVigente).toBe(false);
    expect(sat.verificacionCodigo).toBeNull();
    expect(JSON.stringify(sat)).not.toContain('idAutomotor');
    expect(JSON.stringify(sat)).not.toContain('licencias');

    const veh = espia.updatesEn('vehicles').at(-1)!.datos;
    expect(veh).toMatchObject({ brand: 'MAZDA', model: 'CX-30', vehicleClass: 'CAMIONETA' });
    expect(Object.keys(veh)).not.toContain('ownerName');
    expect(Object.keys(veh)).not.toContain('ownerDocument');

    expect(espia.updatesEn('flito_soat').at(-1)!.datos.organismoCodigo).toBe(ORGANISMO_FUNZA);
  });

  it('RUNT caído → satélite `caido` + `runt_no_disponible`; no toca vehicles ni organismo', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'Timeout 90s' });
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('caido');
    expect(sat.verificacionCodigo).toBe('runt_no_disponible');
    expect(sat.soatVigente).toBeNull();
    expect(espia.updatesEn('vehicles').filter((u) => u.datos.brand)).toHaveLength(0);
    expect(espia.updatesEn('flito_soat').filter((u) => u.datos.organismoCodigo)).toHaveLength(0);
  });

  it('Kyverum lanza → `caido` (timeout/throw)', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockRejectedValue(new Error('ECONNRESET'));
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    expect(espia.updatesEn('flito_soat_solicitud').at(-1)!.datos.verificacionEstado).toBe('caido');
  });

  it('sin registro → `sin_registro` + `runt_sin_registro`', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: true, data: { vehiculo: { placa: 'JNH38H', vin: '9FKRG2222T2042405' } },
    });
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('sin_registro');
    expect(sat.verificacionCodigo).toBe('runt_sin_registro');
  });

  it('placa o VIN DIFIERE → `no_cuadra`; no toca vehicles ni organismo', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ placa: 'XXX999' }));
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('no_cuadra');
    expect(sat.verificacionCodigo).toBe('runt_no_cuadra');
    expect(espia.updatesEn('vehicles').filter((u) => u.datos.brand)).toHaveLength(0);
    expect(espia.updatesEn('flito_soat').filter((u) => u.datos.organismoCodigo)).toHaveLength(0);
  });

  it('campo que el RUNT no trajo NO es no_cuadra (NO_VERIFICABLE)', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ vin: null }));
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    expect(espia.updatesEn('flito_soat_solicitud').at(-1)!.datos.verificacionEstado).toBe('ok');
  });

  it('organismo no catalogado → `ok` + `organismo_no_catalogado`; organismo se queda NULL', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ organismoTransito: 'STRIA TTO DE MARTE' }));
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('ok');
    expect(sat.verificacionCodigo).toBe('organismo_no_catalogado');
    expect(espia.updatesEn('flito_soat').filter((u) => u.datos.organismoCodigo)).toHaveLength(0);
  });

  it('SOAT vigente → `ok` + soatVigente true + fecha; el estado del SOAT NO pasa a solicitado', async () => {
    prepararAltaYJob();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({}, { estadoSoat: 'VIGENTE', fechaVencimSoat: '01/02/2027' }));
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    const sat = espia.updatesEn('flito_soat_solicitud').at(-1)!.datos;
    expect(sat.verificacionEstado).toBe('ok');
    expect(sat.soatVigente).toBe(true);
    expect(sat.soatVigenteHasta).toBe('2027-02-01');
    expect(espia.ultimoInsertEn('flito_soat').estado).toBe('pendiente_revision');
    expect(espia.updatesEn('flito_soat').every((u) => u.datos.estado !== 'solicitado')).toBe(true);
  });

  it('idempotente: si ya no está `pendiente`, no llama a Kyverum', async () => {
    prepararAltaYJob({ verificacionEstado: 'ok' });
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(espia.updatesEn('flito_soat_solicitud')).toHaveLength(0);
  });

  it('el log del job es `{ soatId, verificacionEstado }` sin placa, VIN ni documento', async () => {
    prepararAltaYJob();
    const r = await alta(await buildApp(), await auth('cliente', siguienteUsuario()));
    await flushJob();

    expect(logInfo).toHaveBeenCalled();
    const payload = JSON.stringify(logInfo.mock.calls);
    expect(payload).toContain(r.body.id);
    expect(payload).toContain('ok');
    for (const pii of ['JNH38H', '9FKRG2222T2042405', '1020304050', 'JUANA PEREZ']) {
      expect(payload).not.toContain(pii);
    }
  });

  it('PPT se traduce a código de pasarela Y (Bug #11927)', async () => {
    prepararAltaYJob({ tipoDocumento: 'PPT' });
    const app = await buildApp();
    const token = await auth('cliente', siguienteUsuario());
    const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
    for (const [k, v] of Object.entries({ ...CAMPOS, tipoDocumento: 'PPT' })) req.field(k, v);
    const r = await req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    await flushJob();

    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(
      'JNH38H', '9FKRG2222T2042405', '1020304050', 'Y',
    );
  });
});
