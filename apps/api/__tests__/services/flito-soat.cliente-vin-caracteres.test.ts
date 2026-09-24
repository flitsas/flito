// HU #12843 (Feature #12840) — **el servidor rechaza un VIN con I, O o Q**, antes de consultar el RUNT.
//
// La web ya lo avisaba (`errorVin` en `apps/web/src/lib/soatCliente.ts`); el borde no, y una «O»
// tecleada por un cero salía al RUNT como consulta de pago perdida. La regla vive en `vehiculoSchema`
// y el alta lo reutiliza con `.merge()`: por eso aquí se prueba en las DOS rutas, y en ambas se
// afirma que el mock del RUNT no se llamó —un 400 que igualmente hubiera consultado sería el mismo
// agujero con otra respuesta—.
//
// Montaje calcado de `flito-soat.cliente-runt-por-vin.test.ts`: router real, `authMiddleware` real,
// un `sub` distinto por caso (el limitador del canal es por usuario). VINs sintéticos: ninguno real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

const COMPANIA = 7;
const ORGANISMO_FUNZA = '25286';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** El mismo sentido que `errorVin` de la web. Se compara por las tres letras, no por el copy entero. */
const MENSAJE_IOQ = /no lleva las letras I, O ni Q/;

/**
 * Un VIN de 17 SIN I/O/Q cuyo dígito de control (posición 9) es INCORRECTO: el cálculo ISO 3779 da
 * `6` y aquí hay un `5`. Es lo que fija el AC4 — la regla no valida el dígito de control.
 */
const VIN_DIGITO_MALO = '9ZZTEST1523456789';

function runtOk(vin: string) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: 'JNH38H', vin,
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      tipoDocPropietario: 'C',
      soat: { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' },
    },
  };
}

let sub = 12843_000;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (id: number) => `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: 'cliente' as never })}`;

function escenario() {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{
      id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme',
      proveedorId: '55555555-5555-4555-8555-555555555555', activo: true,
    }],
    flito_soat: [],
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
  });
  kdb.when.insert('vehicles', [{ id: 55 }]);
}

const CAMPOS: Record<string, string> = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string, vin: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, vin })) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string, vin: string) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send({ vin });

/** Los errores de campo del VIN, tal como los devuelve `flatten()`. */
const erroresVin = (body: { details?: { fieldErrors?: Record<string, string[]> } }) =>
  body.details?.fieldErrors?.vin ?? [];

beforeEach(() => {
  kdb.reset();
  consultarVehiculoRuntMock.mockReset();
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
});

describe('AC1 — un VIN con I, O o Q es 400 con el mensaje de la web, y no llega al RUNT', () => {
  const CON_IOQ: readonly [string, string][] = [
    ['O', '9ZZTEST0000O12345'],
    ['I', '9ZZTEST0000I12345'],
    ['Q', '9ZZTEST0000Q12345'],
  ];

  it.each(CON_IOQ)('**preconsulta** con «%s» (`%s`) → 400 sin consultar', async (_letra, vin) => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), vin);

    expect(r.status).toBe(400);
    expect(erroresVin(r.body).some((m) => MENSAJE_IOQ.test(m))).toBe(true);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it.each(CON_IOQ)('**alta** con «%s» (`%s`) → 400 sin consultar ni subir el PDF', async (_letra, vin) => {
    escenario();
    const r = await alta(await buildApp(), await auth(siguienteUsuario()), vin);

    expect(r.status).toBe(400);
    expect(erroresVin(r.body).some((m) => MENSAJE_IOQ.test(m))).toBe(true);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('la letra en minúscula también se rechaza: la regla corre DESPUÉS de pasar a mayúsculas', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), '9zztest0000o12345');

    expect(r.status).toBe(400);
    expect(erroresVin(r.body).some((m) => MENSAJE_IOQ.test(m))).toBe(true);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — la normalización se conserva y la regla se evalúa sobre lo normalizado', () => {
  it('«9zz-test-1234-56789» entra y sale al RUNT como «9ZZTEST123456789»', async () => {
    // En crudo tiene minúsculas y guiones, que la regla rechazaría: si se evaluara ANTES de
    // normalizar, esto sería 400.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk('9ZZTEST123456789'));
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), '9zz-test-1234-56789');

    expect(r.status).toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, '9ZZTEST123456789', '', '');
  });
});

describe('AC3 — la longitud sigue siendo 11 a 17, con la regla nueva encima', () => {
  it.each([
    [11, '9ZZTEST1234'],
    [16, '9ZZTEST123456789'],
    [17, '9ZZTEST1234567890'],
  ])('sin I/O/Q y %i caracteres → pasa la validación y consulta', async (largo, vin) => {
    expect(vin).toHaveLength(largo);
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk(vin));
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), vin);

    expect(r.status).toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, vin, '', '');
  });

  it.each([
    [10, '9ZZTEST123'],
    [18, '9ZZTEST12345678901'],
  ])('%i caracteres → 400 por longitud, como hoy, y sin consultar', async (largo, vin) => {
    expect(vin).toHaveLength(largo);
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), vin);

    expect(r.status).toBe(400);
    expect(erroresVin(r.body).some((m) => /caracteres/.test(m))).toBe(true);
    expect(erroresVin(r.body).some((m) => MENSAJE_IOQ.test(m))).toBe(false);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — no se valida el dígito de control; el «no encontrado» del RUNT sigue bloqueando', () => {
  it('un VIN de 17 con dígito de control incorrecto pasa la validación y se consulta', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk(VIN_DIGITO_MALO));
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), VIN_DIGITO_MALO);

    expect(r.status).toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, VIN_DIGITO_MALO, '', '');
  });

  it('el mismo VIN, si el RUNT no tiene registro, sigue siendo 422 `runt_sin_registro`', async () => {
    // El eco de la consulta (solo placa y VIN) es «sin registro», igual que en la compuerta del alta.
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: true, data: { vehiculo: { placa: 'JNH38H', vin: VIN_DIGITO_MALO } } });
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()), VIN_DIGITO_MALO);

    expect(consultarVehiculoRuntMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_sin_registro');
  });
});
