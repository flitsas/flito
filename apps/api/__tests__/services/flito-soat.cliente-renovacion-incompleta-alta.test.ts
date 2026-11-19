// HU #14018 (Feature #14012, Épica #13760) — renovación con el RUNT caído: el alta APARCA la solicitud en
// `flito_soat_incompletas` (modalidad 'placa', motivo 'runt_sin_respuesta') y responde 202. ADR-0030 §3.
//
// Matriz AC → casos:
//   AC1  renovación (con y sin factura) y RUNT caído → 202; incompleta tipo renovacion / modalidad placa /
//        motivo runt_sin_respuesta, placa normalizada, sin VIN; sin factura no se sube nada.
//   AC3  incompleta abierta para la placa → 409 `solicitud_incompleta_existente`: propia (id) / ajena
//        (recortado: propia false, sin id); la carrera del índice único por placa (23505) también.
//   AC5  Inicial intacta: VIN + factura obligatoria, tipo inicial / modalidad vin, sin placa.
//   AC10 el log no lleva placa, documento ni el mensaje crudo.
//
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const OTRA_COMPANIA = 99;
const VEHICULO_ID = 55;
const INCOMPLETA_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN, placa y documento sintéticos: ninguno es de nadie. */
const VIN = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
const DOCUMENTO = '1020304050';

function runtOk(soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: PLACA, vin: VIN, idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON',
        pasajerosSentados: '5', puertas: '5', organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      soat,
    },
  };
}
const CAIDO = { ok: false, message: 'La consulta no pudo ser atendida' };

let sub = 14018_00;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

const auth = async (id: number) => `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: 'cliente' as never })}`;

function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{
      id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme',
      proveedorId: '55555555-5555-4555-8555-555555555555', activo: true,
    }],
    flito_soat: [],
    flito_soat_incompletas: [],
    organismos_transito_config: [{ codigo: '25286', alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
  kdb.when.insert('flito_soat_incompletas', [{ id: INCOMPLETA_ID }]);
}

const CAMPOS: Record<string, string> = {
  vin: VIN.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: DOCUMENTO,
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}


beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/reservado.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});


const CAMPOS_RENOVACION: Record<string, string> = {
  tipo: 'renovacion', placa: PLACA.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: DOCUMENTO, nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};
function altaRenovacion(app: express.Express, token: string, conFactura: boolean) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS_RENOVACION)) req.field(k, v);
  return conFactura ? req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' }) : req;
}
const todoElLog = () => JSON.stringify([
  ...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls,
]);

describe('AC1 — renovación con el RUNT caído queda POR VALIDAR (202), con o sin factura', () => {
  it('con factura: 202 y la fila nace tipo renovacion / modalidad placa / motivo runt_sin_respuesta, sin VIN', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), true);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ desenlace: 'incompleta', id: INCOMPLETA_ID, estado: 'incompleta' });

    const inc = espia.ultimoInsertEn('flito_soat_incompletas');
    expect(inc).toMatchObject({
      tipoSoat: 'renovacion', modalidadConsulta: 'placa', motivoPendiente: 'runt_sin_respuesta',
      placa: PLACA, vin: null, companiaId: COMPANIA, intentos: 1,
    });
    expect(inc.facturaStorageKey).toBe('clientes/acme/soat/facturas-venta/reservado.pdf');
    // El documento de la consulta ES el del propietario: no hay columna aparte.
    expect(espia.ultimoInsertEn('flito_compradores')).toMatchObject({ numeroDocumento: DOCUMENTO, orden: 0 });
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    expect(espia.insertsEn('vehicles')).toHaveLength(0);
  });

  it('sin factura: 202, las cinco columnas de factura en NULL y NO se sube nada a storage', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), false);
    expect(r.status).toBe(202);
    const inc = espia.ultimoInsertEn('flito_soat_incompletas');
    expect(inc).toMatchObject({
      tipoSoat: 'renovacion', modalidadConsulta: 'placa', placa: PLACA, vin: null,
      facturaStorageKey: null, facturaHash: null, facturaNombreArchivo: null,
      facturaContentType: null, facturaTamanoBytes: null,
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('el log del desenlace no lleva placa, documento ni el mensaje crudo (AC10)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockRejectedValue(new Error(`ECONNRESET consultando ${PLACA} ${DOCUMENTO}`));
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), false);
    expect(r.status).toBe(202);
    const todo = todoElLog();
    expect(todo).toContain(INCOMPLETA_ID);
    for (const pii of [PLACA, DOCUMENTO, 'ECONNRESET']) expect(todo, `sin «${pii}»`).not.toContain(pii);
  });
});

describe('AC3 — duplicado por placa: 409 recortado', () => {
  it('incompleta abierta PROPIA de esa placa → 409 con propia: true + id, y no se aparca otra', async () => {
    escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: COMPANIA }] });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), false);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'solicitud_incompleta_existente', propia: true, id: INCOMPLETA_ID });
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(0);
  });

  it('incompleta abierta de OTRA compañía → 409 recortado: propia false, sin id, sin estado ni compañía', async () => {
    escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: OTRA_COMPANIA }] });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), false);
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('solicitud_incompleta_existente');
    expect(r.body.propia).toBe(false);
    expect(r.body.id).toBeUndefined();
    expect(r.body.estado).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(String(OTRA_COMPANIA));
    expect(JSON.stringify(r.body)).not.toContain(PLACA);
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(0);
  });

  it('la carrera: el índice único por placa (23505) tras la guarda → 409 recortado, no 500', async () => {
    escenario({ flito_soat_incompletas: [{ id: INCOMPLETA_ID, companiaId: OTRA_COMPANIA }] });
    kdb.when.selectOnce('flito_soat_incompletas', []);
    kdb.when.insert('flito_soat_incompletas', () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    });
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), false);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'solicitud_incompleta_existente', propia: false });
    expect(espia.insertsEn('flito_compradores')).toHaveLength(0);
  });
});

describe('AC5 — Inicial queda INTACTA: VIN + factura obligatoria, se aparca como hoy', () => {
  it('Inicial con RUNT caído: 202 y la fila lleva VIN, tipo inicial, modalidad vin, sin placa y con factura', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(202);
    const inc = espia.ultimoInsertEn('flito_soat_incompletas');
    expect(inc).toMatchObject({
      tipoSoat: 'inicial', modalidadConsulta: 'vin', motivoPendiente: 'runt_sin_respuesta',
      vin: VIN, placa: null, facturaStorageKey: 'clientes/acme/soat/facturas-venta/reservado.pdf',
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('Inicial sin factura sigue siendo 400 (no se aparca nada ni se consulta el RUNT)', async () => {
    escenario();
    const req = request(await buildApp()).post('/api/flito/soat/cliente').set('Authorization', await auth(siguienteUsuario()));
    for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
    const r = await req;
    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(espia.insertsEn('flito_soat_incompletas')).toHaveLength(0);
  });
});
