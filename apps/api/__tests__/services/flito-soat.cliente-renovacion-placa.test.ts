// Feature #14012 · HU #14017 (ADR-0030) — Renovación por placa + documento del propietario.
// RUNT simulado (mock de `consultarVehiculoRunt`); el resto es la cadena real del canal Cliente.
// Mock de Drizzle por tabla (keyed-db): las filas de flito_soat del escenario son el SOAT actual.
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

/**
 * El logger, espiado. Lo añade el Bug #12179: la compuerta escribe una línea por cada desenlace que
 * RESUELVE organismo, y la renovación anticipada es uno de ellos —lleva el mismo `PayloadOk`—. Sin
 * este mock no hay forma de afirmar la FORMA de esa línea, que es lo único que separa «se mide el
 * organismo» de «se filtra PII en logs».
 */
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';


/** VIN y placa sintéticos: ni un VIN ni una cédula reales en esta suite. */
const VIN_RUNT = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
/** Una póliza sintética, ya normalizada, para poder afirmar la igualdad exacta al persistirla. */
const POLIZA_RUNT = '99887766';

/**
 * El día de hoy en Bogotá calculado **en el test y no con la función bajo prueba**.
 *
 * Los casos que van por HTTP no pueden congelar el reloj —el servidor de supertest y los limitadores
 * usan temporizadores—, así que la fecha del RUNT se construye relativa a hoy. Reimplementarla aquí
 * es lo que evita la tautología: si la de producción cambiara de zona, estos casos se caerían.
 */
function diaBogotaDelTest(instante: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instante);
}

/**
 * Una fecha a `n` días de hoy, en `yyyy-mm-dd`.
 *
 * `+10` está SIEMPRE dentro del umbral de 30 días y `+45` SIEMPRE fuera, así que estos casos no
 * caducan ni parpadean según el día en que se corran.
 * El borde exacto no se prueba por aquí: para eso está la mitad pura, con `hoy` congelado.
 */
function aDias(n: number): string {
  const hoy = diaBogotaDelTest();
  const base = Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1, Number(hoy.slice(8, 10)));
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

/** La respuesta del RUNT del canal; `soat` se sobrescribe caso a caso. */
function runtOk(soat: unknown = { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' }) {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: PLACA, vin: VIN_RUNT,
        idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular',
        tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5',
        organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      soat,
    },
  };
}

/** El RUNT reporta una póliza VIGENTE hasta `venceEl`, con su número. */
const runtVigenteHasta = (venceEl: string, numeroPoliza: string | null = POLIZA_RUNT) =>
  runtOk({ estadoSoat: 'VIGENTE', fechaVencimSoat: venceEl, ...(numeroPoliza ? { numeroPoliza } : {}) });

let sub = 4200;
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
    organismos_transito_config: [{ codigo: ORGANISMO_FUNZA, alias: 'FUNZA' }],
    vehicles: [],
    ...(over as Record<string, unknown[]>),
  });
  kdb.when.insert('vehicles', [{ id: VEHICULO_ID }]);
}


const DOC = '1020304050';
const NIT = '900123456';
const SOAT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const fila = (estado: string, venceEl: string | null, companiaId = COMPANIA) =>
  ({ id: SOAT_ID, estado, companiaId, venceEl, createdAt: new Date('2026-01-01T00:00:00Z') });

const post = (app: express.Express, token: string, cuerpo: Record<string, unknown>) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);
const renovar = (app: express.Express, token: string, extra: Record<string, unknown> = {}) =>
  post(app, token, { tipo: 'renovacion', placa: PLACA.toLowerCase(), numeroDocumento: DOC, ...extra });

const CAMPOS_TITULAR: Record<string, string> = {
  tipoDocumento: 'CC', numeroDocumento: DOC,
  nombres: 'JUANA', apellidos: 'PEREZ', correo: 'juana@empresa.co', celular: '3001234567',
  direccion: 'CALLE 1 # 2-3', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
function altaReq(app: express.Express, token: string, campos: Record<string, string>, conFactura: boolean) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS_TITULAR, ...campos })) req.field(k, v);
  return conFactura ? req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' }) : req;
}
const altaRenovacion = (app: express.Express, token: string, conFactura = false, campos: Record<string, string> = {}) =>
  altaReq(app, token, { tipo: 'renovacion', placa: PLACA.toLowerCase(), ...campos }, conFactura);

const todoElLog = () => JSON.stringify([
  ...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls,
]);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('preconsulta — el `tipo` ausente es INICIAL y la rama renovación exige tipo explícito', () => {
  it('sin `tipo` consulta POR VIN como hoy (placa y documento colados se descartan)', async () => {
    escenario();
    const r = await post(await buildApp(), await auth(siguienteUsuario()), { vin: VIN_RUNT, placa: 'XXX999', numeroDocumento: DOC });
    expect(r.status).toBe(200);
    expect(r.body.tipo).toBe('inicial');
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, VIN_RUNT, '', '');
  });

  it('`tipo` desconocido es 400 y no consulta al RUNT', async () => {
    escenario();
    const r = await post(await buildApp(), await auth(siguienteUsuario()), { tipo: 'otro', vin: VIN_RUNT });
    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it.each([
    ['sin documento', { tipo: 'renovacion', placa: PLACA }],
    ['sin placa', { tipo: 'renovacion', numeroDocumento: DOC }],
    ['placa corta', { tipo: 'renovacion', placa: 'AB1', numeroDocumento: DOC }],
    ['placa larga', { tipo: 'renovacion', placa: 'ABC12345', numeroDocumento: DOC }],
  ])('renovación %s: 400 sin tocar el RUNT', async (_n, cuerpo) => {
    escenario();
    const r = await post(await buildApp(), await auth(siguienteUsuario()), cuerpo);
    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });
});

describe('preconsulta renovación — la compuerta por placa + documento', () => {
  it('**AC2** consulta por placa normalizada + documento, SIN VIN ni tipo de documento; vencido => 200', async () => {
    escenario();
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.tipo).toBe('renovacion');
    expect(r.body.vigenciaProxima).toBeNull();
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(PLACA, undefined, DOC, undefined);
  });

  it('acepta un NIT: el documento viaja tal cual, sin tipo', async () => {
    escenario();
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()), { numeroDocumento: NIT });
    expect(r.status).toBe(200);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(PLACA, undefined, NIT, undefined);
  });

  it('**AC2** vigente que vence en <=30 días => 200 con aviso `vigenciaProxima`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.vigenciaProxima).toMatchObject({ venceEl: aDias(10) });
  });

  it('**AC7** vigente a >30 días => 409 `soat_vigente` con la fecha hasta la que vence', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(45)));
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('soat_vigente');
    expect(r.body.fechaVencimiento).toBe(aDias(45));
  });

  it('**AC6** `soat: []` => 422 `soat_sin_anterior` con el mensaje exacto y sin datos del RUNT', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('soat_sin_anterior');
    expect(r.body.error ?? r.body.mensaje ?? JSON.stringify(r.body)).toContain('Este vehículo no registra SOAT anterior: solicite un SOAT inicial');
    expect(JSON.stringify(r.body)).not.toContain(VIN_RUNT);
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['{}', {}],
    ['cadena', 'sin datos'],
  ])('`soat` %s es INDETERMINADO: 503 `runt_no_disponible`, NUNCA `soat_sin_anterior`', async (_n, soat) => {
    escenario();
    const ok = runtOk();
    if (soat === undefined) delete (ok.data as Record<string, unknown>).soat; else (ok.data as Record<string, unknown>).soat = soat;
    consultarVehiculoRuntMock.mockResolvedValue(ok);
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('runt_no_disponible');
  });

  it('Inicial NO evalúa «sin SOAT anterior»: `soat: []` por VIN sigue siendo 200', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));
    const r = await post(await buildApp(), await auth(siguienteUsuario()), { vin: VIN_RUNT });
    expect(r.status).toBe(200);
  });

  it('**AC5** documento que no corresponde (200 ok:false) => 422 `runt_no_cuadra` SIN revelar el valor del RUNT', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({
      ok: false, httpStatus: 200,
      message: 'Los datos registrados no corresponden con los propietarios activos para el vehículo consultado.',
    });
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
    const texto = JSON.stringify(r.body);
    expect(texto).toMatch(/placa y el documento del propietario/);
    expect(texto).not.toMatch(/VIN/);
    expect(texto).not.toContain(VIN_RUNT);
    expect(texto).not.toContain('propietarios activos');
  });

  it('**AC5** vía directa (sin httpStatus) con el mismo texto también es 422, no 503', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, message: 'no corresponden con los propietarios activos' });
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
  });

  it('sin registro => 422 `runt_sin_registro` con el mensaje de placa y documento', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: true, data: {} });
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_sin_registro');
    expect(JSON.stringify(r.body)).toMatch(/placa y el documento del propietario/);
  });

  it('la placa devuelta distinta de la tecleada => 422 `runt_no_cuadra` con `campo: placa` (sin el valor)', async () => {
    escenario();
    const ok = runtOk();
    (ok.data.vehiculo as Record<string, unknown>).placa = 'ZZZ999';
    consultarVehiculoRuntMock.mockResolvedValue(ok);
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('runt_no_cuadra');
    expect(r.body.campo).toBe('placa');
    expect(JSON.stringify(r.body)).not.toContain('ZZZ999');
  });

  it('el RUNT lanza => 503 `runt_no_disponible` (la renovación no se aparca en esta HU)', async () => {
    escenario();
    consultarVehiculoRuntMock.mockRejectedValue(new Error('timeout'));
    const r = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('runt_no_disponible');
  });

  it('vehículo con SOAT `pagado` propio: 200 y `flito.yaEnFlito`; uno ABIERTO bloquea con 409', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(10))] });
    const r1 = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r1.status).toBe(200);
    expect(r1.body.flito).toMatchObject({ yaEnFlito: true, abierto: false, soatId: SOAT_ID });

    escenario({ flito_soat: [fila('solicitado', aDias(10))] });
    const r2 = await renovar(await buildApp(), await auth(siguienteUsuario()));
    expect(r2.status).toBe(409);
    expect(r2.body.codigo).toBe('vin_ya_tiene_soat');
  });

  it('**AC9** ni la placa ni el documento llegan al log; el rastro PII se deja en la lectura', async () => {
    escenario();
    await renovar(await buildApp(), await auth(siguienteUsuario()));
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));
    await renovar(await buildApp(), await auth(siguienteUsuario()));
    const log = todoElLog();
    for (const pii of [PLACA, PLACA.toLowerCase(), DOC, VIN_RUNT]) expect(log).not.toContain(pii);
    expect(piiMock).toHaveBeenCalled();
    for (const [, opciones] of piiMock.mock.calls) {
      const motivo = JSON.stringify(opciones);
      expect(motivo).not.toContain(PLACA);
      expect(motivo).not.toContain(DOC);
    }
  });
});

describe('alta renovación', () => {
  const solicitudes = () => espia.insertsEn('flito_soat_solicitud').map((m) => m.datos);

  it('**AC2** sin factura: 201, SOAT `solicitado` con tipo renovación, sin soporte ni subida, y SIN antecesor si el previo solo está en el RUNT', async () => {
    escenario();
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(PLACA, undefined, DOC, undefined);
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
    expect(espia.insertsEn('flito_soat')[0].datos).toMatchObject({ estado: 'solicitado', vin: VIN_RUNT });
    expect(solicitudes()).toHaveLength(1);
    expect(solicitudes()[0]).toMatchObject({ tipoSoat: 'renovacion', soatAnteriorId: null });
    expect(espia.insertsEn('flito_soportes').filter((m) => m.datos.tipo === 'factura_venta')).toHaveLength(0);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('el propietario se toma de los datos ENVIADOS y el documento consultado es el persistido', async () => {
    escenario();
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(espia.insertsEn('flito_compradores')[0].datos).toMatchObject({ numeroDocumento: DOC, nombres: 'JUANA' });
  });

  it('**AC3** con factura: se sube y queda su soporte; el tipo sigue siendo renovación', async () => {
    escenario();
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()), true);
    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(espia.insertsEn('flito_soportes').filter((m) => m.datos.tipo === 'factura_venta')).toHaveLength(1);
    expect(solicitudes()[0]).toMatchObject({ tipoSoat: 'renovacion' });
  });

  it('**AC2** vehículo ya en FLITO con SOAT `pagado` propio: no bloquea y `soat_anterior_id` es ese SOAT', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(5))] });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(201);
    expect(solicitudes()[0]).toMatchObject({ tipoSoat: 'renovacion', soatAnteriorId: SOAT_ID });
  });

  it('un SOAT ABIERTO propio => 409 y no se crea nada', async () => {
    escenario({ flito_soat: [fila('pendiente', aDias(5))] });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('un `pagado` de OTRA compañía => 409 recortado', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(5), 999)] });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.propia).toBe(false);
  });

  it('**AC6** sin SOAT anterior => 422 `soat_sin_anterior`, nada se escribe', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk([]));
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('soat_sin_anterior');
    expect(espia.inserts).toHaveLength(0);
  });

  it('**AC7** vigente a >30 días => 409 `soat_vigente`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(45)));
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('soat_vigente');
    expect(espia.inserts).toHaveLength(0);
  });

  it('**AC5** documento que no corresponde => 422 sin valores del RUNT', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue({ ok: false, httpStatus: 200, message: 'no corresponden con los propietarios activos' });
    const r = await altaRenovacion(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain(VIN_RUNT);
    expect(espia.inserts).toHaveLength(0);
  });

  // El RUNT caído en la renovación ya NO es 503: se aparca (HU #14018, AC1) — ver
  // flito-soat.cliente-renovacion-incompleta.test.ts.

  it('renovación con placa inválida => 400', async () => {
    escenario();
    const r = await altaReq(await buildApp(), await auth(siguienteUsuario()), { tipo: 'renovacion', placa: 'A' }, false);
    expect(r.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
  });

  it('**AC4** `tipo` ausente = INICIAL: consulta por VIN, factura obligatoria y tipo `inicial`', async () => {
    escenario();
    const app = await buildApp();
    const sinFactura = await altaReq(app, await auth(siguienteUsuario()), { vin: VIN_RUNT }, false);
    expect(sinFactura.status).toBe(400);
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();

    const r = await altaReq(app, await auth(siguienteUsuario()), { vin: VIN_RUNT }, true);
    expect(r.status).toBe(201);
    expect(consultarVehiculoRuntMock).toHaveBeenCalledWith(undefined, VIN_RUNT, '', '');
    expect(solicitudes()[0]).toMatchObject({ tipoSoat: 'inicial', soatAnteriorId: null });
  });

  it('**AC4** Inicial sigue bloqueando un `pagado` propio con 409 (no se enlaza antecesor)', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(5))] });
    const r = await altaReq(await buildApp(), await auth(siguienteUsuario()), { vin: VIN_RUNT }, true);
    expect(r.status).toBe(409);
  });
});

describe('`sinSoatAnterior` — la ÚNICA definición', () => {
  it('tabla de verdad', async () => {
    const { sinSoatAnterior } = await import('../../src/modules/flito-soat/flito-soat-cliente-consulta.js');
    expect(sinSoatAnterior({ soat: [] })).toBe(true);
    expect(sinSoatAnterior({ soat: [{ numSoat: '1' }] })).toBe(false);
    expect(sinSoatAnterior({ soat: { numSoat: '1' } })).toBe(false);
    for (const d of [{}, { soat: null }, { soat: {} }, { soat: 'x' }, { soat: 0 }, null, undefined]) {
      expect(sinSoatAnterior(d), JSON.stringify(d)).toBeNull();
    }
  });
});
