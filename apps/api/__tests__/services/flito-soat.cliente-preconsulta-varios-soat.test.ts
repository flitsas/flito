// Feature #14012 · HU #14016 (ADR-0031) — varios SOAT por vehículo, uno abierto a la vez.
// Preconsulta con «ya en FLITO» (AC1-AC5, AC10) y alta Inicial que conserva el 409 (AC6).
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

const preconsultar = (app: express.Express, token: string, cuerpo: Record<string, string> = { vin: VIN_RUNT }) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);


const SOAT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const fila = (estado: string, venceEl: string | null, companiaId = COMPANIA) =>
  ({ id: SOAT_ID, estado, companiaId, venceEl, createdAt: new Date('2026-01-01T00:00:00Z') });

const CAMPOS_ALTA: Record<string, string> = {
  vin: VIN_RUNT.toLowerCase(), tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ', correo: 'juana@empresa.co', celular: '3001234567',
  direccion: 'CALLE 1 # 2-3', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
function alta(app: express.Express, token: string) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries(CAMPOS_ALTA)) req.field(k, v);
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
});

describe('preconsulta — «ya en FLITO» sobre un vehículo con SOAT `pagado` propio', () => {
  it('**AC1** — vence en <=30 días: 200 con flito renovable y días de vigencia', async () => {
    const venceEl = aDias(10);
    escenario({ flito_soat: [fila('pagado', venceEl)] });
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(venceEl));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.flito).toMatchObject({
      yaEnFlito: true, abierto: false, estadoAbierto: null, soatId: SOAT_ID,
      venceEl, diasVigencia: 10, fuenteVigencia: 'runt', renovable: true,
    });
  });

  it('**AC2** — ya vencido: 200, renovable y diasVigencia <= 0 (fecha de flito_soat si el RUNT no trae)', async () => {
    const venceEl = aDias(-5);
    escenario({ flito_soat: [fila('pagado', venceEl)] });

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.flito).toMatchObject({ yaEnFlito: true, abierto: false, diasVigencia: -5, fuenteVigencia: 'flito', renovable: true });
  });

  it('**AC10** — sin fecha ni en el RUNT ni en flito_soat.vence_el: renovable:false (defecto seguro)', async () => {
    escenario({ flito_soat: [fila('pagado', null)] });

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.flito).toMatchObject({ yaEnFlito: true, diasVigencia: null, venceEl: null, fuenteVigencia: null, renovable: false });
  });

  it('**AC5** — vigente a >30 días: 409 `soat_vigente` con diasVigencia y renovable:false (y rastro PII)', async () => {
    const venceEl = aDias(45);
    escenario({ flito_soat: [fila('pagado', venceEl)] });
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(venceEl));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('soat_vigente');
    expect(r.body.diasVigencia).toBe(45);
    expect(r.body.flito).toMatchObject({ yaEnFlito: true, abierto: false, renovable: false, diasVigencia: 45 });
    expect(piiMock).toHaveBeenCalled();
  });

  it('un vehículo SIN SOAT en FLITO devuelve `flito.yaEnFlito:false`', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(200);
    expect(r.body.flito).toMatchObject({ yaEnFlito: false, abierto: false, soatId: null });
  });
});

describe('preconsulta — con un SOAT ABIERTO el vehículo «ya está en un proceso»', () => {
  it.each(['pendiente', 'solicitado', 'con_novedad'])(
    '**AC3** — propio en `%s`: 409 vin_ya_tiene_soat, estadoAbierto y renovable:false (y rastro PII)',
    async (estado) => {
      escenario({ flito_soat: [fila(estado, aDias(10))] });

      const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

      expect(r.status).toBe(409);
      expect(r.body.codigo).toBe('vin_ya_tiene_soat');
      expect(JSON.stringify(r.body)).toContain('ya está en un proceso');
      expect(r.body.propia).toBe(true);
      expect(r.body.flito).toMatchObject({ abierto: true, estadoAbierto: estado, renovable: false });
      expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
      expect(piiMock).toHaveBeenCalled();
    },
  );

  it('**AC4** — abierto de OTRA compañía: 409 recortado (sin id, estado ni vigencia)', async () => {
    escenario({ flito_soat: [fila('solicitado', aDias(10), 999)] });

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(r.body.propia).toBe(false);
    for (const k of ['id', 'estado', 'flito', 'diasVigencia', 'venceEl']) expect(r.body).not.toHaveProperty(k);
  });

  it('un `pagado` de OTRA compañía tampoco se sondea: mismo 409 recortado', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(10), 999)] });
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.propia).toBe(false);
    expect(r.body).not.toHaveProperty('flito');
  });
});

describe('**AC6** — el alta Inicial conserva el 409 `vin_ya_tiene_soat`', () => {
  it('sobre un SOAT `pagado` propio: 409 con `flito.renovable` para que la web ofrezca renovar', async () => {
    escenario({ flito_soat: [fila('pagado', aDias(10))] });

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(r.body.propia).toBe(true);
    expect(r.body.flito).toMatchObject({ yaEnFlito: true, abierto: false, renovable: true });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('sobre un SOAT abierto propio: 409 con `flito.abierto:true`', async () => {
    escenario({ flito_soat: [fila('con_novedad', null)] });
    const r = await alta(await buildApp(), await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.flito).toMatchObject({ abierto: true, estadoAbierto: 'con_novedad', renovable: false });
  });
});
