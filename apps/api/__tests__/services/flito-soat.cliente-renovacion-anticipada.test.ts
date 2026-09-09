// HU #12212 (Feature #12073) — **renovación anticipada: el SOAT vigente deja de bloquear cuando le
// queda un mes o menos**.
//
// Dos mitades, y las dos hacen falta:
//
//   1. **El umbral, como FUNCIÓN PURA y con `hoy` congelado.** `diaEnBogota`,
//      `limiteRenovacionAnticipada` y `esRenovacionAnticipada` deciden si una solicitud se crea o se
//      rechaza con un 409, y el borde es una fecha exacta (AC4). Probarlo solo por HTTP obligaría a
//      mover el reloj del proceso para ver la frontera, que es justo lo que esta regla NO puede
//      depender de: el contenedor corre en UTC y el umbral es colombiano.
//   2. **La PERSISTENCIA del alta permitida (AC9)**, medida sobre el payload real del INSERT con
//      `espia-drizzle`. Es lo que el tipo no puede garantizar: que `vence_el` y `poliza_runt` se
//      escriban, y que `estado_vigencia`, `verificada_en` y `numero_poliza` **no aparezcan en el
//      objeto** —ni siquiera como `null`—. Un `null` explícito pisaría el default de la columna, y
//      afirmar sobre la fila que el mock devuelve sería una tautología (el mock `chain` devuelve la
//      fila entera aunque el `select` pidiera menos).
//
// `TZ=UTC` a propósito y desde la primera línea: con el huso local de Colombia (-05) un cálculo que
// usara el reloj del proceso daría el mismo resultado que el correcto durante casi todo el día, y el
// mutante sobreviviría. Con UTC, las horas de la tarde-noche de Bogotá caen ya en el día siguiente
// del proceso, y ahí las dos implementaciones se separan.
process.env.TZ = 'UTC';

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

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock,
  consultarPersonaRunt: vi.fn(),
}));

const COMPANIA = 7;
const VEHICULO_ID = 55;
const ORGANISMO_FUNZA = '25286';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

/** VIN y placa sintéticos: ni un VIN ni una cédula reales en esta suite. */
const VIN_RUNT = '9FKRG2222T2042405';
const PLACA = 'JNH38H';
/** Una póliza sintética, ya normalizada, para poder afirmar la igualdad exacta al persistirla. */
const POLIZA_RUNT = '99887766';

// ── Fechas del escenario del AC, tal como las escribió el PO ────────────────────────────────────
const HOY_AC = '2026-09-09';
/** AC1: vence dentro de menos de un mes → se permite. */
const VENCE_PRONTO = '2026-10-05';
/** AC2: vence dentro de más de un mes → 409 de siempre. */
const VENCE_LEJOS = '2026-10-20';
/** AC4: la frontera exacta —mismo día del mes siguiente— y el día de después. */
const FRONTERA = '2026-10-09';
const PASADA_LA_FRONTERA = '2026-10-10';

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
 * `+10` está SIEMPRE dentro del umbral (el mes más corto tiene 28 días) y `+45` SIEMPRE fuera (el
 * más largo tiene 31), así que estos casos no caducan ni parpadean según el día en que se corran.
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
  app.use('/api/flito/soat', router);
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

const CAMPOS: Record<string, string> = {
  vin: VIN_RUNT.toLowerCase(),
  tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ',
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

function alta(app: express.Express, token: string, campos: Record<string, string | null> = {}) {
  const req = request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  for (const [k, v] of Object.entries({ ...CAMPOS, ...campos })) {
    if (v !== null) req.field(k, v);
  }
  return req.attach('facturaVenta', PDF, { filename: 'factura.pdf', contentType: 'application/pdf' });
}

const preconsultar = (app: express.Express, token: string, cuerpo: Record<string, string> = { vin: VIN_RUNT }) =>
  request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send(cuerpo);

const umbral = () => import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockResolvedValue('clientes/acme/soat/facturas-venta/abc.pdf');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ═══════════ El día de hoy: Colombia, no el reloj del proceso (AC4) ══════════

describe('`diaEnBogota` — el día se resuelve en `America/Bogota`, nunca con el reloj del proceso', () => {
  it('**02:30 UTC es todavía AYER en Bogotá**, y es ahí donde las dos lecturas se separan', async () => {
    const { diaEnBogota } = await umbral();
    const instante = new Date('2026-09-10T02:30:00Z');

    // El control positivo: el proceso corre en UTC y para él ya es día 10.
    expect(instante.toISOString().slice(0, 10)).toBe('2026-09-10');
    expect(diaEnBogota(instante)).toBe('2026-09-09');
  });

  it('**el borde de las 05:00 UTC**: un segundo antes es el día anterior, en punto es el nuevo', async () => {
    const { diaEnBogota } = await umbral();
    expect(diaEnBogota(new Date('2026-09-10T04:59:59Z'))).toBe('2026-09-09');
    expect(diaEnBogota(new Date('2026-09-10T05:00:00Z'))).toBe('2026-09-10');
  });

  it('devuelve `yyyy-mm-dd` con ceros a la izquierda: es el formato del que depende la comparación', async () => {
    const { diaEnBogota } = await umbral();
    // Un `1-2-2026` rompería el orden lexicográfico sin romper ningún tipo.
    expect(diaEnBogota(new Date('2026-01-02T15:00:00Z'))).toBe('2026-01-02');
    expect(diaEnBogota(new Date('2026-12-31T23:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('**su defecto es AHORA**: sin argumento lee el instante actual, no una constante', async () => {
    const { diaEnBogota } = await umbral();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-03-01T03:00:00Z'));
      expect(diaEnBogota()).toBe('2027-02-28');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══════════ El límite: mes CALENDARIO, con clamp (AC4 y AC5) ════════════════

describe('`limiteRenovacionAnticipada` — misma fecha del mes siguiente, y nunca desborda', () => {
  it('**el caso del AC**: 2026-09-09 → 2026-10-09', async () => {
    const { limiteRenovacionAnticipada } = await umbral();
    expect(limiteRenovacionAnticipada(HOY_AC)).toBe(FRONTERA);
  });

  it('**AC5 — 2027-01-31 → 2027-02-28**, y el límite NO cae en marzo', async () => {
    const { limiteRenovacionAnticipada } = await umbral();
    const limite = limiteRenovacionAnticipada('2027-01-31');

    expect(limite).toBe('2027-02-28');
    // El aserto que mata al mutante: `new Date(Date.UTC(2027, 1, 31))` desborda a `2027-03-03`, y un
    // límite en marzo ampliaría el umbral tres días justo para los cierres de mes.
    expect(limite.slice(5, 7)).toBe('02');
  });

  it('el clamp respeta los bisiestos: 2024-01-31 → 2024-02-29, y 2026-01-31 → 2026-02-28', async () => {
    const { limiteRenovacionAnticipada } = await umbral();
    expect(limiteRenovacionAnticipada('2024-01-31')).toBe('2024-02-29');
    expect(limiteRenovacionAnticipada('2026-01-31')).toBe('2026-02-28');
  });

  it('los meses de 31 y de 30 días: 2026-03-31 → 2026-04-30, y 2026-04-30 → 2026-05-30', async () => {
    const { limiteRenovacionAnticipada } = await umbral();
    expect(limiteRenovacionAnticipada('2026-03-31')).toBe('2026-04-30');
    // Sin clamp que aplicar: mayo tiene 31, así que el día se conserva tal cual.
    expect(limiteRenovacionAnticipada('2026-04-30')).toBe('2026-05-30');
  });

  it('**diciembre pasa de año**: 2026-12-15 → 2027-01-15, y 2026-12-31 → 2027-01-31', async () => {
    const { limiteRenovacionAnticipada } = await umbral();
    expect(limiteRenovacionAnticipada('2026-12-15')).toBe('2027-01-15');
    expect(limiteRenovacionAnticipada('2026-12-31')).toBe('2027-01-31');
  });
});

// ═══════════ El predicado: frontera inclusive y defecto seguro (AC3/AC4/AC5) ══

describe('`esRenovacionAnticipada` — la frontera es INCLUSIVE y sin fecha no se permite', () => {
  it('**AC4 — 2026-10-09 se permite y 2026-10-10 se bloquea**, con hoy congelado en 2026-09-09', async () => {
    const { esRenovacionAnticipada } = await umbral();
    expect(esRenovacionAnticipada(FRONTERA, HOY_AC)).toBe(true);
    expect(esRenovacionAnticipada(PASADA_LA_FRONTERA, HOY_AC)).toBe(false);
  });

  it('AC1 y AC2 — 2026-10-05 se permite; 2026-10-20 no', async () => {
    const { esRenovacionAnticipada } = await umbral();
    expect(esRenovacionAnticipada(VENCE_PRONTO, HOY_AC)).toBe(true);
    expect(esRenovacionAnticipada(VENCE_LEJOS, HOY_AC)).toBe(false);
  });

  it('**AC3 — sin fecha, `false`**: de «vigente y no digo hasta cuándo» no se deduce «falta un mes»', async () => {
    const { esRenovacionAnticipada } = await umbral();
    expect(esRenovacionAnticipada(null, HOY_AC)).toBe(false);
    // La cadena vacía es el otro «no hay fecha» que un extractor puede producir.
    expect(esRenovacionAnticipada('', HOY_AC)).toBe(false);
  });

  it('**AC5 — hoy 2027-01-31 con vencimiento 2027-02-28 se permite; el 2027-03-01 ya no**', async () => {
    const { esRenovacionAnticipada } = await umbral();
    expect(esRenovacionAnticipada('2027-02-28', '2027-01-31')).toBe(true);
    expect(esRenovacionAnticipada('2027-03-01', '2027-01-31')).toBe(false);
  });

  it('una póliza YA VENCIDA cae del lado que no bloquea: es el resultado correcto', async () => {
    const { esRenovacionAnticipada } = await umbral();
    expect(esRenovacionAnticipada('2020-01-01', HOY_AC)).toBe(true);
  });

  it('**no consulta el reloj del proceso**: con `hoy` fijo, el resultado no cambia al mover el sistema', async () => {
    const { esRenovacionAnticipada } = await umbral();
    vi.useFakeTimers();
    try {
      // Un año entero después. Si el predicado mirara `new Date()` en vez de su parámetro, el
      // vencimiento de 2026 pasaría a estar «hace mucho» y este par de asertos se separaría.
      vi.setSystemTime(new Date('2027-09-09T12:00:00Z'));
      expect(esRenovacionAnticipada(FRONTERA, HOY_AC)).toBe(true);
      expect(esRenovacionAnticipada(PASADA_LA_FRONTERA, HOY_AC)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══════════ El punto ÚNICO de decisión: el clasificador (AC6 y AC7) ═════════

describe('`clasificarDesenlaceRunt` — la bifurcación vive en el paso 5 y no altera el orden', () => {
  const clasificar = async (respuesta: unknown, hoy = HOY_AC, vin = VIN_RUNT) => {
    const { clasificarDesenlaceRunt } = await umbral();
    return clasificarDesenlaceRunt(respuesta as never, vin, hoy);
  };

  it('**AC1 — vigente hasta 2026-10-05 es `renovacion_anticipada`**, con el payload de `ok` entero', async () => {
    escenario();
    const desenlace = await clasificar(runtVigenteHasta(VENCE_PRONTO));

    expect(desenlace).toMatchObject({
      clase: 'renovacion_anticipada',
      venceEl: VENCE_PRONTO,
      poliza: POLIZA_RUNT,
      vinEfectivo: VIN_RUNT,
      organismoCodigo: ORGANISMO_FUNZA,
    });
    // El vehículo viaja igual que en `ok`: sin él, el alta no podría crear la ficha.
    expect(desenlace).toMatchObject({ datos: { placa: PLACA, marca: 'MAZDA' } });
  });

  it('**AC2 — vigente hasta 2026-10-20 sigue siendo `vigente`**, con su fecha', async () => {
    escenario();
    expect(await clasificar(runtVigenteHasta(VENCE_LEJOS)))
      .toEqual({ clase: 'vigente', fechaVencimiento: VENCE_LEJOS });
  });

  it('**AC3 — vigente SIN fecha es `vigente` con `fechaVencimiento: null`**, nunca renovación', async () => {
    escenario();
    expect(await clasificar(runtOk({ estadoSoat: 'VIGENTE' })))
      .toEqual({ clase: 'vigente', fechaVencimiento: null });
  });

  it('**AC4 — la frontera decide también aquí**: el 09 renueva, el 10 bloquea', async () => {
    escenario();
    expect((await clasificar(runtVigenteHasta(FRONTERA))).clase).toBe('renovacion_anticipada');
    expect((await clasificar(runtVigenteHasta(PASADA_LA_FRONTERA))).clase).toBe('vigente');
  });

  it('**AC7 — un VIN que no cuadra gana sobre la renovación anticipada**: 422, no aviso', async () => {
    escenario();
    // Las dos condiciones a la vez: el RUNT devuelve otro VIN Y la póliza vence en tres días. Si la
    // bifurcación se hubiera colado delante de los «revise», saldría `renovacion_anticipada`.
    const respuesta = runtVigenteHasta(VENCE_PRONTO);
    (respuesta.data.vehiculo as Record<string, unknown>).vin = 'OTROVIN000000001';

    expect(await clasificar(respuesta)).toEqual({ clase: 'revise', codigo: 'runt_no_cuadra', campo: 'vin' });
  });

  it('**y «sin registro» y «sin VIN» también siguen ganando**: el orden §2.3 está entero', async () => {
    escenario();
    const sinVin = runtVigenteHasta(VENCE_PRONTO);
    (sinVin.data.vehiculo as Record<string, unknown>).vin = null;
    expect(await clasificar(sinVin)).toEqual({ clase: 'revise', codigo: 'runt_sin_vin' });

    expect(await clasificar({ ok: true, data: { vehiculo: { placa: PLACA, vin: VIN_RUNT }, soat: { estadoSoat: 'VIGENTE', fechaVencimSoat: VENCE_PRONTO } } }))
      .toEqual({ clase: 'revise', codigo: 'runt_sin_registro' });
  });

  it('el RUNT sin póliza reportada deja `poliza: null`, y eso no impide la renovación', async () => {
    escenario();
    expect(await clasificar(runtVigenteHasta(VENCE_PRONTO, null)))
      .toMatchObject({ clase: 'renovacion_anticipada', venceEl: VENCE_PRONTO, poliza: null });
  });
});

// ═══════════ AC9 — qué se PERSISTE, medido sobre el payload del INSERT ═══════

describe('AC9 — el alta por renovación anticipada guarda la fecha y la póliza, y NADA MÁS', () => {
  it('**`vence_el` y `poliza_runt` se escriben con lo que reportó el RUNT**', async () => {
    escenario();
    const venceEl = aDias(10);
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(venceEl));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(201);
    const fila = espia.ultimoInsertEn('flito_soat');
    expect(fila.venceEl).toBe(venceEl);
    expect(fila.polizaRunt).toBe(POLIZA_RUNT);
  });

  it('**las tres columnas que NO se tocan están AUSENTES del payload**, ni siquiera como `null`', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    expect((await alta(await buildApp(), await auth(siguienteUsuario()))).status).toBe(201);

    const fila = espia.ultimoInsertEn('flito_soat');
    // `numero_poliza` es la llave de conciliación del OCR; `verificada_en` sacaría la fila del censo
    // del día; `estado_vigencia` en `'vigente'` haría que la cola dijera «vencido» sobre una
    // solicitud sin pagar en cuanto pasara `vence_el`. Un `null` explícito pisaría el default, así
    // que el aserto es de AUSENCIA de la clave y no de su valor.
    expect(fila).not.toHaveProperty('numeroPoliza');
    expect(fila).not.toHaveProperty('verificadaEn');
    expect(fila).not.toHaveProperty('estadoVigencia');
    expect(Object.keys(fila)).not.toContain('numero_poliza');
  });

  it('**el estado y el recorrido no cambian**: nace en `solicitado` y con su destino, como cualquier alta', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    expect((await alta(await buildApp(), await auth(siguienteUsuario()))).status).toBe(201);

    const fila = espia.ultimoInsertEn('flito_soat');
    expect(fila.estado).toBe('solicitado');
    expect(fila.origen).toBe('cliente');
    expect(fila.companiaId).toBe(COMPANIA);
    expect(fila.vin).toBe(VIN_RUNT);
    // La verificación se anota igual que siempre: la compuerta corrió y la lectura fue concluyente.
    const solicitud = espia.ultimoInsertEn('flito_soat_solicitud');
    expect(solicitud.verificacionEstado).toBe('ok');
  });

  it('**sin renovación anticipada las dos claves NO aparecen**: el camino de siempre no cambia', async () => {
    escenario();
    // El `runtOk` por defecto: SOAT no vigente. Es el control negativo del caso de arriba —sin él,
    // un INSERT que escribiera `venceEl` SIEMPRE pasaría los dos primeros asertos—.
    expect((await alta(await buildApp(), await auth(siguienteUsuario()))).status).toBe(201);

    const fila = espia.ultimoInsertEn('flito_soat');
    expect(fila).not.toHaveProperty('venceEl');
    expect(fila).not.toHaveProperty('polizaRunt');
  });

  it('**AC8 — la RN-01 sigue intacta**: si ese VIN ya tiene SOAT, no hay segundo registro', async () => {
    escenario({ flito_soat: [{ id: 'aaaa', estado: 'pagado', companiaId: COMPANIA }] });
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('vin_ya_tiene_soat');
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
    // La RN-01 corta ANTES de gastar la consulta: la renovación anticipada no le abre una puerta.
    expect(consultarVehiculoRuntMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ═══════════ AC1/AC2/AC6 — el contrato HTTP de los dos endpoints ═════════════

describe('AC6 — los dos endpoints deciden lo mismo ante la misma respuesta del RUNT', () => {
  it('**AC1 — la preconsulta responde 200 con vehículo, organismo y el aviso con la fecha**', async () => {
    escenario();
    const venceEl = aDias(10);
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(venceEl));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.vehiculo).toMatchObject({ vin: VIN_RUNT, placa: PLACA, marca: 'MAZDA' });
    expect(r.body.organismo).toEqual({ codigo: ORGANISMO_FUNZA, nombre: 'FUNZA' });
    expect(r.body.vigenciaProxima).toEqual({ venceEl });
  });

  it('**la póliza NO viaja en el 200** (RN-B1): se persiste en servidor y no se publica', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body.vigenciaProxima).not.toHaveProperty('poliza');
    // Y por ninguna otra clave: enumerar VIN no puede cosechar números de póliza.
    expect(JSON.stringify(r.body)).not.toContain(POLIZA_RUNT);
  });

  it('**la clave `vigenciaProxima` está SIEMPRE presente**: `null` cuando no hay aviso', async () => {
    escenario();
    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('vigenciaProxima');
    expect(r.body.vigenciaProxima).toBeNull();
  });

  it('**AC1 — y el alta con ese mismo VIN SÍ crea la solicitud**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    const r = await alta(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('solicitado');
    expect(espia.insertsEn('flito_soat')).toHaveLength(1);
  });

  it('**AC2 — a más de un mes, los DOS responden 409 `soat_vigente` con la fecha, y no se crea fila**', async () => {
    escenario();
    const venceEl = aDias(45);
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(venceEl));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    expect(pre.status).toBe(409);
    expect(pre.body.codigo).toBe('soat_vigente');
    // La fecha viaja como clave HERMANA de `error` y `codigo`, no anidada: `manejarError` esparce
    // `e.datos` en el cuerpo (`...(e.datos ?? {})`), igual que hace con `propia`/`id`/`estado` de la
    // RN-01. Esta HU no cambia esa forma; solo cambia CUÁNDO se emite el 409.
    expect(pre.body.fechaVencimiento).toBe(venceEl);

    const r = await alta(app, await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('soat_vigente');
    expect(r.body.fechaVencimiento).toBe(venceEl);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });

  it('**AC3 — vigente sin fecha: 409 sin `fechaVencimiento`, y tampoco se crea fila**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtOk({ estadoSoat: 'VIGENTE' }));
    const app = await buildApp();

    const pre = await preconsultar(app, await auth(siguienteUsuario()));
    expect(pre.status).toBe(409);
    expect(pre.body.codigo).toBe('soat_vigente');
    // Sin fecha, la clave NO se inventa: el 409 se construye sin `datos` (AC3).
    expect(pre.body.fechaVencimiento).toBeUndefined();

    const r = await alta(app, await auth(siguienteUsuario()));
    expect(r.status).toBe(409);
    expect(espia.insertsEn('flito_soat')).toHaveLength(0);
  });
});

// ═══════════ Ley 1581, art. 17 — lo que el 200 divulga, declarado ════════════

describe('rastro PII — el aviso de vigencia se declara en `campos_accedidos` cuando viaja', () => {
  it('**con aviso, la lista incluye `fecha_vencimiento_soat`**', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(10)));

    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin', 'fecha_vencimiento_soat']));
  });

  it('**sin aviso, NO se declara**: el registro no cuenta divulgaciones que no ocurrieron', async () => {
    escenario();
    await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    const registro = piiMock.mock.calls[0][1];
    expect(registro.camposAccedidos).not.toContain('fecha_vencimiento_soat');
    expect(registro.camposAccedidos).toEqual(expect.arrayContaining(['placa', 'vin']));
  });

  it('el 409 sigue siendo un INTENTO: no declara ningún campo accedido', async () => {
    escenario();
    consultarVehiculoRuntMock.mockResolvedValue(runtVigenteHasta(aDias(45)));

    const r = await preconsultar(await buildApp(), await auth(siguienteUsuario()));

    expect(r.status).toBe(409);
    const registro = piiMock.mock.calls[0][1];
    expect(registro.camposAccedidos).toEqual([]);
  });
});
