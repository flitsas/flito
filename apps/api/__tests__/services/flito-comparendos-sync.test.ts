// FLITO comparendos — la corrida de sincronización (HU #11500, Feature #11492 17a).
//
// Es la HU que más test necesita porque es la única del módulo que ESCRIBE datos de fuente y la
// única que puede apagar un histórico. Lo que se demuestra, de más caro a menos:
//
//   1. **Un fallo parcial NO inactiva** (CF-10/RN-18). Si un municipio da timeout, ese NIT no pierde
//      ni un comparendo. Es el daño más caro que este módulo puede hacer y el que un refactor
//      distraído reintroduce con más facilidad.
//   2. **El modo simulado se aborta en producción** (RN-16). Sin esto, la variable sin provisionar en
//      PDN escribiría comparendos `MOCK-…` en la base real y luego inactivaría los verdaderos.
//   3. **El merge**: SIMIT gana, el municipal rellena huecos, y lo que ya estaba no se borra.
//   4. **Idempotencia**: re-sincronizar los mismos datos no duplica ni filas ni eventos del timeline.
//   5. **Cardinalidad y paralelismo**: 1 llamada SIMIT por NIT, N×M municipales, con el pool acotado
//      por `COMPARENDOS_SYNC_CONCURRENCIA` (ADR-0001 §7).
//
// Los dos adapters están mockeados —no `integraciones/http.js`— porque lo que se ejerce aquí es la
// ORQUESTACIÓN: qué se llama, cuántas veces, qué se escribe y qué NO se apaga. Que la petición salga
// bien formada y que el token no se filtre ya lo prueba `flito-comparendos-clients.test.ts`.
//
// Drizzle va con el mock keyed por tabla + el espía de escrituras: sin él, afirmar sobre el merge
// obligaría a mirar la fila que el propio test devolvió, que es una tautología.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia, type Mutacion } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';
import { Redacted } from '../../src/shared/utils/crypto.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/**
 * El lock se mockea para poder ejercer las dos ramas: la corrida normal y el 409.
 *
 * Devolver `null` es exactamente lo que hace `withLock` cuando otro proceso tiene el lock vigente,
 * así que simularlo así prueba el contrato real y no una versión de mentira.
 */
const withLockMock = vi.fn(
  async (_nombre: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
);
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: (nombre: string, ttl: number, fn: () => Promise<unknown>) => withLockMock(nombre, ttl, fn),
  acquireLock: vi.fn(), releaseLock: vi.fn(),
}));

const simitMock = vi.fn();
vi.mock('../../src/modules/flito-comparendos/clients/verifik-simit.client.js', () => ({
  consultarComparendosSimit: (...args: unknown[]) => simitMock(...args),
}));

const municipalMock = vi.fn();
vi.mock('../../src/modules/flito-comparendos/clients/uts-municipal.client.js', () => ({
  consultarComparendosMunicipales: (...args: unknown[]) => municipalMock(...args),
}));

const tokenMock = vi.fn(async () => new Redacted('TOKEN-SIMIT-QUE-NO-DEBE-APARECER'));
vi.mock('../../src/modules/flito-comparendos/flito-comparendos.token.service.js', () => ({
  obtenerTokenSimit: () => tokenMock(),
  obtenerMetaTokenSimit: vi.fn().mockResolvedValue({ configurado: false }),
  guardarTokenSimit: vi.fn(),
}));

/** Todo lo logueado, para la aserción de «el NIT no sale en claro» (Ley 1581, RN-20). */
const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const {
  ComparendosFuenteHttpError,
  ComparendosFuenteTimeoutError,
  ComparendosTokenNoConfiguradoError,
} = await import('../../src/modules/flito-comparendos/flito-comparendos.errors.js');
const { env } = await import('../../src/config/env.js');

const BASE = '/api/flito/comparendos';
const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NIT_A = '900123456';
const NIT_B = '800999888';

type EnvMutable = {
  COMPARENDOS_SIMIT_MODE: 'mock' | 'real';
  COMPARENDOS_SYNC_CONCURRENCIA: number;
  NODE_ENV: string;
};
const entorno = env as unknown as EnvMutable;
const original = { ...entorno };

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: TestRole = 'admin', sub = 7) =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/**
 * Un usuario distinto por llamada.
 *
 * El limitador de `POST /sync` cuenta por `sub` y son 4 corridas por minuto —a propósito: cada una
 * son NITs × municipios peticiones de pago—. Con un único usuario, el quinto test del archivo
 * recibiría 429 y los fallos dependerían del ORDEN de ejecución. El corte se prueba aparte, con su
 * propio usuario.
 */
let subSecuencial = 1000;

const sync = async (body?: Record<string, unknown>, role: TestRole = 'admin') => {
  const req = request(await buildApp()).post(`${BASE}/sync`)
    .set('Authorization', await auth(role, ++subSecuencial));
  return body === undefined ? req : req.send(body);
};

// ─────────────────────────────── Datos de las fuentes ───────────────────────────────────────────

const respuestaSimit = (items: Record<string, unknown>[], httpStatus: number | null = null) =>
  ({ origen: 'simit', fuente: 'simit', modo: 'mock', httpStatus, items });

const respuestaMunicipal = (fuente: string, items: Record<string, unknown>[]) =>
  ({ origen: 'municipal', fuente, modo: 'mock', httpStatus: null, items });

/** El comparendo que ven las DOS fuentes: SIMIT sin descripción, el municipio con ella (CF-08). */
const ITEM_SIMIT = {
  numeroComparendo: 'C-0001', placa: 'ABC123', codigoInfraccion: 'C29',
  fechaComparendo: '2026-05-14', secretariaNombre: 'Secretaría de Medellín',
  valorAPagar: '604100', estado: 'Pendiente de pago',
};
const ITEM_MUNICIPAL = {
  numero: 'C-0001', placa: 'ABC123', codigo: 'C29',
  descripcion: 'Estacionar en sitio prohibido', fecha: '2026-05-14',
  organismo: 'Secretaría de Bello', valor: '999', estado: 'Notificado',
};

const MAPA = [
  { version: 1, origen: 'simit', sourcePath: 'numeroComparendo', targetField: 'numeroComparendo', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'placa', targetField: 'placa', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'codigoInfraccion', targetField: 'codigoInfraccion', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'descripcionInfraccion', targetField: 'descripcionInfraccion', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'fechaComparendo', targetField: 'fechaComparendo', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'secretariaNombre', targetField: 'organismo', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'valorAPagar', targetField: 'monto', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'estado', targetField: 'estadoFuente', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'numero', targetField: 'numeroComparendo', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'placa', targetField: 'placa', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'codigo', targetField: 'codigoInfraccion', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'descripcion', targetField: 'descripcionInfraccion', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'fecha', targetField: 'fechaComparendo', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'organismo', targetField: 'organismo', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'valor', targetField: 'monto', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'estado', targetField: 'estadoFuente', prioridad: 1, provisional: true },
];

// ─────────────────────────────── Escenario de base de datos ─────────────────────────────────────

interface OpcionesEscenario {
  nits?: string[];
  municipios?: string[];
  /** Filas ya existentes en `flito_comparendos_registros` para los números consultados. */
  existentes?: Record<string, unknown>[];
  /**
   * Filas activas que el barrido de inactivación ENCUENTRA. `municipioFuente` es la fuente por la
   * que se vio cada una: el mock lo usa para respetar el WHERE de verdad (ver `sobrevivenAlWhere`).
   */
  inactivados?: { id: string; municipioFuente?: string | null }[];
  mapa?: typeof MAPA;
}

/**
 * Serializa las condiciones de drizzle a SQL real. Es lo que permite afirmar sobre el WHERE de un
 * UPDATE masivo en vez de sobre lo que el mock decidió devolver.
 */
const dialecto = new PgDialect();

const sqlDe = (mutacion: Mutacion): { sql: string; params: unknown[] } =>
  dialecto.sqlToQuery(mutacion.condiciones[0] as never);

/**
 * Emula el WHERE del barrido de inactivación sobre las filas del escenario.
 *
 * Sin esto, el mock devuelve lo registrado pase lo que pase en el `where`, así que un barrido que
 * apaga de más y uno que no son indistinguibles — y la corrección de RN-23 vive precisamente en esa
 * condición. Se emula la parte que importa: si el UPDATE acota por `municipio_fuente`, solo pasan
 * las filas sin municipio (vistas por SIMIT) y las de un municipio que esta corrida consultó.
 *
 * Los parámetros del WHERE llevan además el NIT y el id de la corrida; no colisionan con un código
 * de municipio, así que basta con mirar si el código está entre ellos.
 */
function sobrevivenAlWhere(
  filas: { id: string; municipioFuente?: string | null }[], mutacion: Mutacion,
): { id: string }[] {
  const q = sqlDe(mutacion);
  const acotaPorMunicipio = q.sql.includes('municipio_fuente');
  const consultados = new Set(q.params.filter((p): p is string => typeof p === 'string'));
  return filas
    .filter((f) => !acotaPorMunicipio || f.municipioFuente == null || consultados.has(f.municipioFuente))
    .map((f) => ({ id: f.id }));
}

let idRegistro = 0;

function escenario(opciones: OpcionesEscenario = {}): void {
  const nits = opciones.nits ?? [NIT_A];
  const municipios = opciones.municipios ?? ['BELLO'];

  kdb.when
    .select('flito_comparendos_nits', nits.map((nit) => ({ nit })))
    .select('flito_comparendos_field_map', opciones.mapa ?? MAPA)
    .select('flito_comparendos_municipios', municipios.map((codigoFuente) => ({ codigoFuente })))
    .select('flito_comparendos_registros', opciones.existentes ?? [])
    .insert('flito_comparendos_sync_runs', [{ id: RUN_ID }])
    .insert('flito_comparendos_registros', () => [{ id: `reg-${++idRegistro}` }])
    // Los UPDATE sobre registros los hacen DOS cosas distintas —el upsert y la inactivación— y el
    // mock enruta por tabla, no por intención. Se distinguen por lo que se está escribiendo, que es
    // justo lo que el espía acaba de registrar.
    .update('flito_comparendos_registros', () => {
      const ultimo = espia.updatesEn('flito_comparendos_registros').at(-1);
      if (ultimo?.datos.estado !== 'inactivo') return [{ id: 'reg-existente' }];
      return sobrevivenAlWhere(opciones.inactivados ?? [], ultimo);
    });
}

/** Fila existente en la base, con los valores que el merge va a comparar. */
const filaRegistro = (over: Record<string, unknown> = {}) => ({
  id: 'reg-existente',
  numeroComparendo: 'C-0001',
  estado: 'activo',
  vistoEnSimit: true,
  vistoEnMunicipal: false,
  municipioFuente: null,
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: null,
  fechaComparendo: '2026-05-14',
  organismo: 'Secretaría de Medellín',
  monto: '604100.00',
  estadoFuente: 'Pendiente de pago',
  // HU #11712: por defecto la fila existente es un COMPARENDO (sin resolución). Los casos de multa
  // las ponen con `filaRegistro({ numeroResolucion: … })`.
  numeroResolucion: null,
  idResolucion: null,
  ...over,
});

const insertsEn = (tabla: string) => espia.insertsEn(tabla).map((m) => m.datos);
const updatesEn = (tabla: string) => espia.updatesEn(tabla).map((m) => m.datos);
/** Los eventos se insertan en lote: `.values([...])` recibe un array. */
const eventosEscritos = (): Record<string, unknown>[] =>
  insertsEn('flito_comparendos_eventos').flatMap((d) => (Array.isArray(d) ? d : [d]));

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  auditMock.mockClear();
  registros.length = 0;
  idRegistro = 0;
  Object.assign(entorno, original);

  withLockMock.mockClear();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());

  simitMock.mockReset();
  simitMock.mockImplementation(async () => respuestaSimit([ITEM_SIMIT]));
  municipalMock.mockReset();
  municipalMock.mockImplementation(async (_nit: string, fuente: string) =>
    respuestaMunicipal(fuente, [ITEM_MUNICIPAL]));
  tokenMock.mockClear();
  tokenMock.mockImplementation(async () => new Redacted('TOKEN-SIMIT-QUE-NO-DEBE-APARECER'));
});

afterEach(() => { Object.assign(entorno, original); });

// ─────────────────────────── AC1 · Alcance y cardinalidad ───────────────────────────────────────

describe('POST /sync — alcance global o por NIT (AC1)', () => {
  it('sin cuerpo sincroniza TODOS los NITs activos y devuelve el resultado completo', async () => {
    escenario({ nits: [NIT_A, NIT_B], municipios: ['BELLO', 'ITAGUI'] });

    // Sin `.send()`: un sync global se pide con un POST pelado, sin cuerpo ni Content-Type.
    const r = await sync();

    expect(r.status).toBe(200);
    expect(r.body.runId).toBe(RUN_ID);
    expect(r.body.estado).toBe('completed');
    expect(r.body.scopeNits).toEqual([NIT_A, NIT_B]);
    expect(r.body.resumen).toMatchObject({ modo: 'mock', nitsProcesados: 2 });
    // Un paso por par (NIT, fuente): 2 NIT × (1 SIMIT + 2 municipios).
    expect(r.body.steps).toHaveLength(6);
  });

  it('con `nits` sincroniza solo esos y deja fuera al resto del catálogo', async () => {
    escenario({ nits: [NIT_A, NIT_B] });

    const r = await sync({ nits: [NIT_A] });

    expect(r.status).toBe(200);
    expect(r.body.scopeNits).toEqual([NIT_A]);
    expect(simitMock).toHaveBeenCalledTimes(1);
    expect(simitMock).toHaveBeenCalledWith(NIT_A, expect.anything());
  });

  it('`nits: []` es lo mismo que no mandar nada: sincroniza todo el catálogo activo', async () => {
    escenario({ nits: [NIT_A, NIT_B] });

    const r = await sync({ nits: [] });

    expect(r.status).toBe(200);
    expect(r.body.scopeNits).toEqual([NIT_A, NIT_B]);
  });

  it('`nit` en singular NO se ignora: 400 en vez de un sync global inesperado', async () => {
    escenario({ nits: [NIT_A, NIT_B] });

    // Es el error de dedo más fácil de cometer. Sin `.strict()`, Zod descartaría la clave
    // desconocida, el cuerpo quedaría vacío y se sincronizaría el catálogo ENTERO creyendo que se
    // pidió un NIT — con la cuota del proveedor y los minutos de espera que eso cuesta.
    const r = await sync({ nit: NIT_A });

    expect(r.status).toBe(400);
    expect(simitMock).not.toHaveBeenCalled();
  });

  it('el filtro normaliza igual que el alta: «900.123.456» es el NIT «900123456»', async () => {
    escenario({ nits: [NIT_A] });

    // Rechazarlo por la puntuación sería un 400 incomprensible para quien lo copió de un RUT.
    const r = await sync({ nits: ['900.123.456'] });

    expect(r.status).toBe(200);
    expect(r.body.scopeNits).toEqual([NIT_A]);
  });

  it('1 llamada SIMIT por NIT y una municipal por cada par (NIT, municipio)', async () => {
    escenario({ nits: [NIT_A, NIT_B], municipios: ['BELLO', 'ITAGUI', 'MEDELLIN'] });

    await sync();

    // La cardinalidad es la que decide la factura del proveedor y el presupuesto de tiempo del
    // endpoint síncrono: 2 SIMIT y 2×3 municipales, ni una más.
    expect(simitMock).toHaveBeenCalledTimes(2);
    expect(municipalMock).toHaveBeenCalledTimes(6);
    expect(municipalMock.mock.calls.map((c) => c[1])).toEqual([
      'BELLO', 'ITAGUI', 'MEDELLIN', 'BELLO', 'ITAGUI', 'MEDELLIN',
    ]);
  });

  it('el token se descifra UNA vez por corrida, no una por NIT (RN-17)', async () => {
    entorno.COMPARENDOS_SIMIT_MODE = 'real';
    escenario({ nits: [NIT_A, NIT_B], municipios: ['BELLO', 'ITAGUI'] });

    await sync();

    expect(tokenMock).toHaveBeenCalledTimes(1);
    // Y viaja envuelto hasta el adapter: descifrarlo por NIT multiplicaría las oportunidades de que
    // el valor acabe en un objeto que alguien loguee.
    expect(simitMock.mock.calls[0][1].token).toBeInstanceOf(Redacted);
  });

  it('en modo simulado no se pide el token: un entorno sin credenciales puede sincronizar', async () => {
    escenario();

    await sync();

    expect(tokenMock).not.toHaveBeenCalled();
  });

  it('sin municipios activos la corrida es solo SIMIT (no es un error)', async () => {
    escenario({ municipios: [] });

    const r = await sync();

    expect(r.status).toBe(200);
    expect(municipalMock).not.toHaveBeenCalled();
    expect(r.body.steps).toHaveLength(1);
  });
});

// ─────────────────────────── AC1 · Paralelismo acotado (ADR-0001 §7) ────────────────────────────

describe('POST /sync — pool de llamadas municipales', () => {
  /** Instrumenta el adapter municipal para medir cuántas llamadas hay EN VUELO a la vez. */
  function medirConcurrencia(): { maximo: () => number } {
    let enVuelo = 0;
    let maximo = 0;
    municipalMock.mockImplementation(async (_nit: string, fuente: string) => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo--;
      return respuestaMunicipal(fuente, []);
    });
    return { maximo: () => maximo };
  }

  it('nunca hay más llamadas en vuelo que `COMPARENDOS_SYNC_CONCURRENCIA`', async () => {
    entorno.COMPARENDOS_SYNC_CONCURRENCIA = 2;
    escenario({ municipios: ['BELLO', 'ITAGUI', 'MEDELLIN', 'CALI', 'ENVIGADO', 'SABANETA'] });
    const medida = medirConcurrencia();

    const r = await sync();

    expect(r.status).toBe(200);
    expect(medida.maximo()).toBe(2);
    expect(municipalMock).toHaveBeenCalledTimes(6);
  });

  it('con menos municipios que el pool, se lanzan todas a la vez y no se abren trabajadores de más', async () => {
    entorno.COMPARENDOS_SYNC_CONCURRENCIA = 5;
    escenario({ municipios: ['BELLO', 'ITAGUI', 'MEDELLIN'] });
    const medida = medirConcurrencia();

    await sync();

    // El paralelismo es lo que hace que la matriz NIT × municipios quepa bajo el techo de ~120 s del
    // nginx: si esto cayera a 1, el endpoint síncrono dejaría de ser viable sin que nada «fallara».
    expect(medida.maximo()).toBe(3);
  });

  it('los pasos salen en el orden del catálogo aunque las respuestas lleguen desordenadas', async () => {
    escenario({ municipios: ['BELLO', 'ITAGUI', 'MEDELLIN'] });
    entorno.COMPARENDOS_SYNC_CONCURRENCIA = 3;
    // El primero tarda más que los otros dos: sin conservar el orden de entrada, los pasos saldrían
    // al revés y el detalle de la corrida bailaría entre ejecuciones.
    const demoras: Record<string, number> = { BELLO: 15, ITAGUI: 5, MEDELLIN: 1 };
    municipalMock.mockImplementation(async (_nit: string, fuente: string) => {
      await new Promise((r) => setTimeout(r, demoras[fuente] ?? 1));
      return respuestaMunicipal(fuente, []);
    });

    const r = await sync();

    expect(r.body.steps.map((s: { fuente: string }) => s.fuente))
      .toEqual(['simit', 'BELLO', 'ITAGUI', 'MEDELLIN']);
  });
});

/**
 * Registra las PROYECCIONES de los `select` que se hagan a partir de aquí.
 *
 * El mock keyed responde por tabla y **ignora la proyección**, así que ninguna aserción sobre las
 * filas devueltas puede distinguir «la consulta pidió esta columna» de «el mock la trajo igual».
 * Para las columnas cuyo valor se USA para decidir —las de resolución, de las que sale el tercer
 * escalón de RN-13— esa diferencia es la que separa un test que vigila de uno que acompaña.
 *
 * Se instala dentro del `it` y después de `escenario()`, porque el `beforeEach` reinstala el mock.
 */
function espiarProyecciones(): string[][] {
  const proyecciones: string[][] = [];
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    if (args[0] !== null && typeof args[0] === 'object') proyecciones.push(Object.keys(args[0] as object));
    return base(...args);
  });
  return proyecciones;
}

/** El MAPA de arriba + los candidatos de resolución que siembra la v3 (0160, HU #11712). */
const MAPA_CON_RESOLUCION = [
  ...MAPA,
  { version: 1, origen: 'simit', sourcePath: 'numeroResolucion', targetField: 'numeroResolucion', prioridad: 1, provisional: true },
  { version: 1, origen: 'simit', sourcePath: 'idResolucion', targetField: 'idResolucion', prioridad: 1, provisional: true },
  { version: 1, origen: 'municipal', sourcePath: 'nroResolucion', targetField: 'numeroResolucion', prioridad: 1, provisional: true },
];

// ─────────────────────────── AC2 · Merge y unicidad ─────────────────────────────────────────────

describe('POST /sync — merge SIMIT > municipal (AC2/CF-08)', () => {
  it('el comparendo que ven las dos fuentes es UNA fila: SIMIT manda y el municipio rellena el hueco', async () => {
    escenario();

    await sync();

    const insertados = insertsEn('flito_comparendos_registros');
    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({
      numeroComparendo: 'C-0001',
      nitMonitoreado: NIT_A,
      // De SIMIT, que es la fuente autorizada: el municipio decía 999 y «Notificado».
      monto: '604100.00',
      estadoFuente: 'Pendiente de pago',
      organismo: 'Secretaría de Medellín',
      // Del municipio, porque SIMIT no lo trajo: el hueco del CF-08.
      descripcionInfraccion: 'Estacionar en sitio prohibido',
      origenMerge: 'ambos',
      vistoEnSimit: true,
      vistoEnMunicipal: true,
      municipioFuente: 'BELLO',
      estado: 'activo',
      ultimoSyncRunId: RUN_ID,
    });
  });

  it('guarda los dos payloads crudos, que son la red del spike de homologación', async () => {
    escenario();

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(insertado.payloadSimit).toEqual(ITEM_SIMIT);
    expect(insertado.payloadMunicipal).toEqual(ITEM_MUNICIPAL);
  });

  it('**lo que se persiste va podado: los datos del infractor no llegan a la base** (HU #11511)', async () => {
    escenario();
    // Lo que devuelve Verifik de verdad: el comparendo y QUIÉN lo tiene encima. El infractor es una
    // persona natural y no la empresa monitoreada — datos personales de un tercero (Ley 1581).
    simitMock.mockImplementation(async () => respuestaSimit([{
      ...ITEM_SIMIT,
      nombreInfractor: 'JUAN CARLOS PEREZ GOMEZ',
      documentoInfractor: '1036640908',
      correoInfractor: 'juan.perez@example.com',
    }]));

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    // La poda ocurre en el acumulador, antes de que el payload exista como cosa persistible: lo que
    // llega al INSERT es exactamente la lista blanca del `field_map`, ni un campo más.
    expect(insertado.payloadSimit).toEqual(ITEM_SIMIT);
    const escrito = JSON.stringify(insertado.payloadSimit);
    expect(escrito).not.toContain('JUAN CARLOS');
    expect(escrito).not.toContain('1036640908');
    expect(escrito).not.toContain('juan.perez@example.com');
  });

  it('sobre una fila existente actualiza sin insertar y sin tocar lo que nadie reportó', async () => {
    escenario({
      existentes: [filaRegistro({ vistoEnMunicipal: false, descripcionInfraccion: null })],
    });
    // Esta corrida SIMIT no trae organismo; el municipal tampoco. Lo guardado debe sobrevivir.
    simitMock.mockImplementation(async () => respuestaSimit([
      { numeroComparendo: 'C-0001', estado: 'Pagado' },
    ]));
    municipalMock.mockImplementation(async (_n: string, fuente: string) =>
      respuestaMunicipal(fuente, [{ numero: 'C-0001' }]));

    await sync();

    expect(insertsEn('flito_comparendos_registros')).toHaveLength(0);
    const actualizado = updatesEn('flito_comparendos_registros')[0];
    expect(actualizado).toMatchObject({
      estadoFuente: 'Pagado',                       // lo nuevo entra
      organismo: 'Secretaría de Medellín',          // lo viejo se conserva
      placa: 'ABC123',
      vistoEnMunicipal: true,
      origenMerge: 'ambos',
    });
  });

  /**
   * El payload de la fuente que HOY no reportó no se pisa — y la forma de no pisarlo es OMITIR la
   * clave del `set()`, no mandarla en `null` (TC #11522).
   *
   * La distinción parece nimia y no lo es: `payload_simit: null` en el UPDATE borraría en cada
   * corrida la materia prima del spike de homologación de la otra fuente, en silencio y sin que
   * ninguna aserción existente se enterase — el test de UPDATE de arriba usa `toMatchObject`, que
   * por definición no falla ante claves de MÁS.
   *
   * Y la rama es rutinaria, no defensiva: `acumularMunicipal` construye el consolidado con
   * `payloadSimit: null`, así que la recorre CADA comparendo visto por una sola fuente en CADA
   * corrida. Por eso se afirma sobre el objeto que de verdad llega a `.set()` (el espía guarda la
   * referencia, no una copia) y con `not.toHaveProperty`, que distingue «ausente» de «vale null».
   */
  it('cuando solo reporta el municipio, el UPDATE OMITE la clave payloadSimit (no la manda en null)', async () => {
    escenario({ existentes: [filaRegistro({ vistoEnSimit: true, vistoEnMunicipal: false })] });
    // SIMIT no ve este comparendo en esta corrida: el consolidado llega con `payloadSimit: null`.
    simitMock.mockImplementation(async () => respuestaSimit([]));

    await sync();

    const actualizado = updatesEn('flito_comparendos_registros')
      .find((d) => d.estado !== 'inactivo') as Record<string, unknown>;

    expect(actualizado).not.toHaveProperty('payloadSimit');
    expect(Object.keys(actualizado)).not.toContain('payloadSimit');
    // Y el que sí se reportó viaja, o el UPDATE no estaría conservando nada sino ignorando todo.
    expect(actualizado.payloadMunicipal).toEqual(ITEM_MUNICIPAL);
  });

  it('cuando solo reporta SIMIT, el UPDATE OMITE la clave payloadMunicipal (no la manda en null)', async () => {
    // Sin municipios no hay consulta municipal: el consolidado llega con `payloadMunicipal: null`.
    escenario({
      municipios: [],
      existentes: [filaRegistro({ vistoEnSimit: true, vistoEnMunicipal: true, municipioFuente: 'BELLO' })],
    });

    await sync();

    const actualizado = updatesEn('flito_comparendos_registros')
      .find((d) => d.estado !== 'inactivo') as Record<string, unknown>;

    expect(actualizado).not.toHaveProperty('payloadMunicipal');
    expect(Object.keys(actualizado)).not.toContain('payloadMunicipal');
    expect(actualizado.payloadSimit).toEqual(ITEM_SIMIT);
  });

  it('un ítem sin número reconocible se descarta y se cuenta, no se escribe a medias', async () => {
    escenario({ municipios: [] });
    simitMock.mockImplementation(async () => respuestaSimit([
      ITEM_SIMIT, { placa: 'XYZ789', estado: 'Sin número' },
    ]));

    const r = await sync();

    expect(r.body.resumen.itemsIgnorados).toBe(1);
    expect(insertsEn('flito_comparendos_registros')).toHaveLength(1);
  });
});

// ─────────────── Comparendo o multa: lo que de verdad llega a la base (HU #11712) ────────────────
//
// El merge lo decide y estos tests miran el otro extremo: lo que viaja al INSERT y al UPDATE. Es lo
// que ningún test de `resolverCampos` puede afirmar, porque entre una cosa y la otra están la
// proyección de `FilaExistente` y el `set()` del UPDATE — y es justo ahí donde una columna que no se
// LEE convierte la regla monótona en una regresión silenciosa.

describe('POST /sync — tipo de registro y resolución (HU #11712)', () => {
  it('un comparendo sin resolución se inserta como `comparendo`, no como `null`', async () => {
    escenario({ mapa: MAPA_CON_RESOLUCION });

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(insertado.tipoRegistro).toBe('comparendo');
    expect(insertado.numeroResolucion).toBeNull();
    expect(insertado.idResolucion).toBeNull();
  });

  it('**el que SÍ trae resolución se inserta como `multa`, con su número**', async () => {
    escenario({ mapa: MAPA_CON_RESOLUCION });
    simitMock.mockImplementation(async () => respuestaSimit([{
      ...ITEM_SIMIT, numeroResolucion: 'RES-2026-4471', idResolucion: '115697134',
    }]));

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(insertado.tipoRegistro).toBe('multa');
    expect(insertado.numeroResolucion).toBe('RES-2026-4471');
    expect(insertado.idResolucion).toBe('115697134');
  });

  it('**la que solo la trae el MUNICIPAL también sube a multa**: el silencio de SIMIT no la niega', async () => {
    escenario({ mapa: MAPA_CON_RESOLUCION });
    municipalMock.mockImplementation(async (_n: string, fuente: string) =>
      respuestaMunicipal(fuente, [{ ...ITEM_MUNICIPAL, nroResolucion: 'RES-UTS-9' }]));

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(insertado.tipoRegistro).toBe('multa');
    expect(insertado.numeroResolucion).toBe('RES-UTS-9');
  });

  it('**una fila que ya era multa NO regresa a comparendo porque hoy nadie mande el campo**', async () => {
    // La regresión que este diseño existe para impedir, mirada desde el UPDATE.
    escenario({
      mapa: MAPA_CON_RESOLUCION,
      existentes: [filaRegistro({ numeroResolucion: 'RES-VIEJA', vistoEnMunicipal: true })],
    });
    const proyecciones = espiarProyecciones();

    await sync();

    expect(insertsEn('flito_comparendos_registros')).toHaveLength(0);
    const actualizado = updatesEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(actualizado.numeroResolucion).toBe('RES-VIEJA');
    expect(actualizado.tipoRegistro).toBe('multa');

    // Y la mitad que el mock no puede demostrar por sí sola: la lectura previa PIDE las dos columnas
    // de resolución. El mock devuelve la fila registrada haya o no proyección, así que sin esta
    // aserción se podría borrar `numero_resolucion` del `select` y el test seguiría verde mientras
    // producción degrada cada multa a comparendo en la primera corrida. Comprobado: es exactamente
    // el mutante que sobrevivía.
    expect(proyecciones.some((p) => p.includes('numeroResolucion'))).toBe(true);
    expect(proyecciones.some((p) => p.includes('idResolucion'))).toBe(true);
    // Y NO pide `tipo_registro`: se deriva, y leerlo dejaría que el valor viejo pesara sobre el nuevo.
    expect(proyecciones.some((p) => p.includes('tipoRegistro'))).toBe(false);
  });

  it('con el mapa SIN candidatos de resolución la fila nace comparendo y sin resolución', async () => {
    // El mapa v2 (el que había antes de la 0160). Es coherente con el CHECK —sin resolución, el tipo
    // solo puede ser `comparendo`— y es la razón por la que la v3 se siembra en la MISMA migración
    // que crea las columnas: una base capaz de guardar `tipo_registro` es una base cuyo mapa máximo
    // pregunta por la resolución.
    escenario();

    await sync();

    const insertado = insertsEn('flito_comparendos_registros')[0] as Record<string, unknown>;
    expect(insertado.tipoRegistro).toBe('comparendo');
    expect(insertado.numeroResolucion).toBeNull();
  });
});

// ─────────────────────────── AC3 · Inactivación conservadora ────────────────────────────────────

describe('POST /sync — inactivación (AC3/CF-10/RN-18)', () => {
  it('con cobertura completa apaga lo que no volvió a verse y deja el evento', async () => {
    escenario({ inactivados: [{ id: 'reg-viejo' }] });

    const r = await sync();

    const inactivacion = updatesEn('flito_comparendos_registros')
      .find((d) => d.estado === 'inactivo');
    expect(inactivacion).toMatchObject({ estado: 'inactivo', ultimoSyncRunId: RUN_ID });
    expect(inactivacion?.inactivadoEn).toBeInstanceOf(Date);
    expect(r.body.resumen.inactivados).toBe(1);
    expect(eventosEscritos()).toContainEqual(expect.objectContaining({
      registroId: 'reg-viejo', tipo: 'inactivacion', syncRunId: RUN_ID,
    }));
  });

  it('**un municipio caído NO inactiva nada de ese NIT** (el fallo más caro del módulo)', async () => {
    escenario({ municipios: ['BELLO', 'ITAGUI'], inactivados: [{ id: 'reg-viejo' }] });
    municipalMock.mockImplementation(async (_nit: string, fuente: string) => {
      if (fuente === 'ITAGUI') throw new ComparendosFuenteTimeoutError('municipal', 'ITAGUI', 8000);
      return respuestaMunicipal(fuente, [ITEM_MUNICIPAL]);
    });

    const r = await sync();

    // Un timeout no significa «este comparendo ya no existe», significa «hoy no sabemos». Ni un solo
    // UPDATE de inactivación puede haber salido.
    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(false);
    expect(r.body.resumen.inactivados).toBe(0);
    expect(r.body.resumen.nitsSinInactivacion).toBe(1);
    expect(r.body.estado).toBe('partial');
    // Y lo que sí se pudo leer se guarda igual: el fallo parcial no tira los datos buenos.
    expect(insertsEn('flito_comparendos_registros')).toHaveLength(1);
  });

  it('SIMIT caído tampoco autoriza a inactivar, aunque todos los municipios respondan', async () => {
    escenario({ inactivados: [{ id: 'reg-viejo' }] });
    simitMock.mockImplementation(async () => {
      throw new ComparendosFuenteHttpError('simit', 'simit', 503);
    });

    const r = await sync();

    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(false);
    expect(r.body.resumen.nitsSinInactivacion).toBe(1);
    expect(r.body.estado).toBe('partial');
  });

  it('el NIT con cobertura completa sí inactiva aunque OTRO del mismo run haya fallado', async () => {
    escenario({ nits: [NIT_A, NIT_B], inactivados: [{ id: 'reg-viejo' }] });
    simitMock.mockImplementation(async (nit: string) => {
      if (nit === NIT_B) throw new ComparendosFuenteHttpError('simit', 'simit', 500);
      return respuestaSimit([ITEM_SIMIT]);
    });

    const r = await sync();

    // La cobertura se evalúa POR NIT: castigar a todos porque uno falló dejaría el módulo sin
    // inactivar nunca en cuanto el catálogo creciera.
    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(true);
    expect(r.body.resumen.nitsSinInactivacion).toBe(1);
  });

  it('el que reaparece vuelve a activo, se le limpia la fecha de apagado y deja evento', async () => {
    escenario({ existentes: [filaRegistro({ estado: 'inactivo' })] });

    const r = await sync();

    expect(updatesEn('flito_comparendos_registros')[0]).toMatchObject({
      estado: 'activo', inactivadoEn: null,
    });
    expect(r.body.resumen.reactivados).toBe(1);
    expect(eventosEscritos()).toContainEqual(expect.objectContaining({
      registroId: 'reg-existente', tipo: 'reaparicion', syncRunId: RUN_ID,
    }));
  });

  it('el alta deja `primera_llegada` una sola vez', async () => {
    escenario();

    const r = await sync();

    expect(r.body.resumen.primeraLlegada).toBe(1);
    expect(eventosEscritos()).toEqual([expect.objectContaining({
      registroId: 'reg-1', tipo: 'primera_llegada', syncRunId: RUN_ID,
    })]);
  });

  it('los eventos van con `onConflictDoNothing`: el índice único es el anti-spam (RN-19)', async () => {
    escenario();

    await sync();

    // La regla «sin eventos redundantes» aplicada solo en el servicio se rompe con el primer
    // reintento de una corrida; el candado real es el único (registro, tipo, run) de la 0150.
    expect(kdb.insert).toHaveBeenCalled();
    const chain = kdb.insert.mock.results
      .map((r) => r.value as Record<string, unknown>)
      .find((c) => typeof c.onConflictDoNothing === 'function');
    expect(chain).toBeDefined();
  });

  it('el timeline NO se toca cuando el registro sigue activo y solo cambia la fecha de visto', async () => {
    escenario({ existentes: [filaRegistro()] });

    const r = await sync();

    // Idempotencia del timeline: un comparendo que lleva meses ahí no genera un evento por corrida.
    expect(eventosEscritos()).toHaveLength(0);
    expect(r.body.resumen.primeraLlegada).toBe(0);
    expect(r.body.resumen.reactivados).toBe(0);
  });
});

// ───────── Bloqueante 1 · La corrida no puede sobrevivir a su lock (RN-21) ──────────────────────
//
// El TTL fijo de 10 min era una SUPOSICIÓN sobre la duración, no un invariante: los NITs van en
// serie y cada uno cuesta `timeout + ceil(municipios/concurrencia) × timeout`. Cuando el alcance la
// desborda, el lock expira con la corrida viva y el reintento del operador —que llegará, porque el
// nginx le devolvió 504— arranca una SEGUNDA corrida sobre las mismas tablas: cada una ve como
// ausentes los comparendos que la otra todavía no ha escrito.

describe('POST /sync — deadline y TTL derivado del alcance (RN-21)', () => {
  /** Reloj virtual: el sync mide el deadline con `Date.now()`, así que el test lo controla. */
  function relojControlado() {
    const inicio = Date.now();
    let ahora = inicio;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    return {
      avanzar: (ms: number) => { ahora += ms; },
      /** Tiempo virtual consumido por la corrida. */
      transcurrido: () => ahora - inicio,
      restaurar: () => spy.mockRestore(),
    };
  }

  const nitsDe = (n: number) => Array.from({ length: n }, (_, i) => String(900000000 + i));

  it('el TTL del lock sale del tamaño del alcance, no de una constante', async () => {
    escenario({ nits: nitsDe(30), municipios: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] });
    entorno.COMPARENDOS_SYNC_CONCURRENCIA = 5;

    await sync();

    // 30 NITs × (1 SIMIT + 2 tandas de 5 municipales) × 8 000 ms de timeout = 720 s, más el margen
    // de cierre. Con el TTL fijo de 10 min esta corrida terminaría DESPUÉS de que su lock expirase
    // —y el reintento del operador arrancaría una segunda corrida sobre las mismas tablas—.
    const ttl = withLockMock.mock.calls[0][1];
    expect(ttl).toBe(30 * 3 * 8000 + 60_000);
    expect(ttl).toBeGreaterThan(10 * 60_000);
  });

  it('una corrida que se pasa de tiempo se corta, cierra `partial` y NO inactiva nada', async () => {
    escenario({ nits: nitsDe(30), municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    const reloj = relojControlado();
    // Cada NIT tarda mucho más de lo presupuestado (base lenta, reintentos): es exactamente el caso
    // en el que el TTL fijo se agotaba a mitad de corrida.
    simitMock.mockImplementation(async () => { reloj.avanzar(30_000); return respuestaSimit([]); });

    let r;
    try {
      r = await sync();
    } finally {
      reloj.restaurar();
    }

    // TTL = max(10 min, 30 × 8 s + 60 s) = 10 min; deadline = 9 min. A 30 s por NIT, el 19.º ya no
    // cabe. Y la propiedad que de verdad importa, la que hace imposible el solapamiento: la corrida
    // TERMINÓ antes de que su propio lock pudiera expirar, así que nadie más pudo entrar mientras.
    const ttl = withLockMock.mock.calls[0][1] as number;
    expect(reloj.transcurrido()).toBeLessThan(ttl);

    expect(r!.body.resumen.abortadaPorTiempo).toBe(true);
    expect(r!.body.resumen.nitsProcesados).toBe(18);
    expect(r!.body.estado).toBe('partial');

    // Cortada por tiempo no se apaga nada, ni siquiera de los NITs que sí se completaron: el margen
    // que queda está reservado para cerrar, y el barrido es lo menos reversible de la corrida.
    expect(r!.body.resumen.inactivacionOmitida).toBe('deadline');
    expect(r!.body.resumen.inactivados).toBe(0);
    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(false);
  });

  it('un alcance que no cabe en una corrida se rechaza antes de llamar a nadie', async () => {
    escenario({ nits: nitsDe(200), municipios: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] });

    const r = await sync();

    // 200 NITs × 24 s = 80 min: no hay TTL sano que lo cubra (el lock es también el tiempo que el
    // módulo queda bloqueado si el proceso muere). Mejor decirlo antes que gastar cuota del
    // proveedor en una corrida condenada a cortarse por la mitad.
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('scope_demasiado_grande');
    expect(r.body.error).toContain('147');
    expect(withLockMock).not.toHaveBeenCalled();
    expect(simitMock).not.toHaveBeenCalled();
    expect(insertsEn('flito_comparendos_sync_runs')).toHaveLength(0);
  });
});

// ───────── Bloqueante 2 · Cobertura ≠ «respondió» (RN-22) ───────────────────────────────────────

describe('POST /sync — homologación ilegible y cobertura (RN-22)', () => {
  /** Lo que devuelve una fuente cuyo campo del número NO es el que dice el `field_map`. */
  const ITEMS_SIN_NUMERO = [
    { numeroDelComparendo: 'C-0001', placa: 'ABC123', estado: 'Pendiente de pago' },
    { numeroDelComparendo: 'C-0002', placa: 'ABC124', estado: 'Pendiente de pago' },
    { numeroDelComparendo: 'C-0003', placa: 'ABC125', estado: 'Pendiente de pago' },
  ];

  it('**una fuente que responde con ítems y ninguno se puede identificar NO autoriza a inactivar**', async () => {
    escenario({ municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    // Un `source_path` equivocado en el `field_map` —o un proveedor que renombra el campo— pasa la
    // validación de RN-12, que solo exige que EXISTA algún candidato para el número, no que acierte.
    // Sin esta regla el NIT saldría con cobertura completa y su histórico entero se apagaría.
    simitMock.mockImplementation(async () => respuestaSimit(ITEMS_SIN_NUMERO, 200));

    const r = await sync();

    expect(r.body.resumen.itemsIgnorados).toBe(3);
    expect(insertsEn('flito_comparendos_registros')).toHaveLength(0);
    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(false);
    expect(r.body.resumen.inactivados).toBe(0);
    expect(r.body.resumen.nitsSinInactivacion).toBe(1);
    // Y se ve POR QUÉ: el paso queda fallido con su código, no como un «completada, 0 comparendos»
    // que nadie ataría al mapa de homologación.
    expect(r.body.steps[0]).toMatchObject({
      ok: false, errorCode: 'homologacion_ilegible', httpStatus: 200, itemsLeidos: 3,
    });
    expect(r.body.steps[0].mensaje).toContain('field_map');
    expect(r.body.estado).toBe('failed');
  });

  it('un municipio ilegible tampoco: la cobertura del NIT es de todas sus fuentes', async () => {
    escenario({ municipios: ['BELLO'], inactivados: [{ id: 'reg-viejo' }] });
    municipalMock.mockImplementation(async (_n: string, fuente: string) =>
      respuestaMunicipal(fuente, [{ numeroMunicipal: 'C-9', placa: 'XYZ789' }]));

    const r = await sync();

    expect(r.body.steps[1]).toMatchObject({ fuente: 'BELLO', ok: false, errorCode: 'homologacion_ilegible' });
    expect(r.body.resumen.inactivados).toBe(0);
    expect(r.body.estado).toBe('partial');
    // Lo que SÍ se entendió se escribe igual: un fallo parcial no tira los datos buenos.
    expect(insertsEn('flito_comparendos_registros')).toHaveLength(1);
  });

  it('un ítem raro suelto no quita la cobertura: el umbral es la MAYORÍA, no «alguno»', async () => {
    escenario({ municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    simitMock.mockImplementation(async () => respuestaSimit([
      ITEM_SIMIT,
      { numeroComparendo: 'C-0002', placa: 'ABC124' },
      { placa: 'XYZ789', estado: 'fila de relleno del proveedor' },
    ]));

    const r = await sync();

    // Los proveedores mandan filas raras de vez en cuando; castigar la cobertura por una sola
    // dejaría el módulo sin inactivar nunca, que es el otro extremo del mismo error.
    expect(r.body.steps[0].ok).toBe(true);
    expect(r.body.resumen.itemsIgnorados).toBe(1);
    expect(r.body.resumen.inactivados).toBe(1);
  });
});

// ───────── Bloqueante 3 · Solo se apaga lo que se pudo volver a ver (RN-23) ─────────────────────

describe('POST /sync — la inactivación respeta a quién se le preguntó (RN-23)', () => {
  it('**un municipio desactivado entre corridas NO apaga su histórico**', async () => {
    escenario({
      // ITAGUÍ estaba activo la corrida pasada y hoy no: alguien le puso `activo=false` con el PATCH
      // del catálogo (HU #11497), que no avisa de nada. Sus comparendos siguen existiendo.
      municipios: ['BELLO'],
      inactivados: [
        { id: 'reg-bello', municipioFuente: 'BELLO' },
        { id: 'reg-itagui', municipioFuente: 'ITAGUI' },
        { id: 'reg-simit', municipioFuente: null },
      ],
    });

    const r = await sync();

    // Al UTS de Itagüí no se le preguntó, así que sus comparendos no están «ausentes»: no sabemos
    // nada de ellos. SIMIT sigue respondiendo `ok`, la cobertura sale completa y sin esta condición
    // el barrido los leería como desaparecidos.
    const apagados = eventosEscritos()
      .filter((e) => e.tipo === 'inactivacion').map((e) => e.registroId);
    expect(apagados).toEqual(['reg-bello', 'reg-simit']);
    expect(apagados).not.toContain('reg-itagui');
    expect(r.body.resumen.inactivados).toBe(2);
  });

  it('**con CERO municipios activos, el sync solo-SIMIT no apaga nada de origen municipal**', async () => {
    escenario({
      municipios: [],
      inactivados: [
        { id: 'reg-bello', municipioFuente: 'BELLO' },
        { id: 'reg-simit', municipioFuente: null },
      ],
    });

    const r = await sync();

    // El caso extremo, y no es teórico: `municipales.every(...)` sobre una lista VACÍA es `true`, así
    // que todos los NITs salen con cobertura completa y una sola corrida se llevaría por delante
    // todo lo que solo reportan los UTS.
    expect(r.body.resumen.inactivados).toBe(1);
    expect(eventosEscritos().filter((e) => e.tipo === 'inactivacion').map((e) => e.registroId))
      .toEqual(['reg-simit']);

    // Y el WHERE lo dice explícitamente, no por casualidad de los datos del mock.
    const barrido = espia.updatesEn('flito_comparendos_registros').find((m) => m.datos.estado === 'inactivo');
    expect(sqlDe(barrido!).sql).toContain('"municipio_fuente" is null');
  });

  it('el WHERE del barrido nombra los municipios consultados', async () => {
    escenario({ municipios: ['BELLO', 'ITAGUI'], inactivados: [{ id: 'reg-viejo' }] });

    await sync();

    const barrido = espia.updatesEn('flito_comparendos_registros').find((m) => m.datos.estado === 'inactivo');
    expect(sqlDe(barrido!).params).toEqual(expect.arrayContaining(['BELLO', 'ITAGUI']));
    // Y sigue estando lo de antes: solo se apaga lo que esta corrida no volvió a escribir.
    expect(sqlDe(barrido!).sql).toContain('IS DISTINCT FROM');
  });
});

// ───────── Freno de inactivación masiva (RN-24) ─────────────────────────────────────────────────

describe('POST /sync — freno de inactivación masiva (RN-24)', () => {
  /**
   * El barrido cuenta antes de escribir. Como no se escribe nada, `escribirRegistros` ni siquiera
   * lee, así que el conteo es el PRIMER select sobre `flito_comparendos_registros` de la corrida.
   */
  function conteoDelBarrido(candidatos: number, activos: number): void {
    kdb.when.selectOnce('flito_comparendos_registros', [{ candidatos, activos }]);
  }

  it('una corrida que apagaría casi todo el histórico no apaga NADA y se cierra `partial`', async () => {
    escenario({ municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    // El escenario real: un token vencido cuyo proveedor contesta 200 con lista vacía. Pasa todos
    // los filtros sin ruido —cobertura completa, cero ítems ignorados— y el barrido se llevaría por
    // delante el histórico entero.
    simitMock.mockImplementation(async () => respuestaSimit([]));
    conteoDelBarrido(900, 1000);

    const r = await sync();

    expect(r.body.resumen.inactivados).toBe(0);
    expect(r.body.resumen.inactivacionOmitida).toBe('umbral');
    expect(r.body.estado).toBe('partial');
    // Ni un UPDATE de apagado: se decide ANTES de escribir. El daño sería reversible en los
    // registros (`reaparicion` los restaura) pero NO en el timeline, que deduplica por corrida.
    expect(updatesEn('flito_comparendos_registros').some((d) => d.estado === 'inactivo')).toBe(false);
    expect(eventosEscritos()).toHaveLength(0);
  });

  it('por debajo del umbral el barrido se ejecuta con normalidad', async () => {
    escenario({ municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    simitMock.mockImplementation(async () => respuestaSimit([]));
    conteoDelBarrido(3, 1000);

    const r = await sync();

    expect(r.body.resumen.inactivados).toBe(1);
    expect(r.body.resumen.inactivacionOmitida).toBeNull();
    expect(r.body.estado).toBe('completed');
  });

  it('sobre pocos activos manda el tope de filas, no el porcentaje', async () => {
    escenario({ municipios: [], inactivados: [{ id: 'reg-viejo' }] });
    simitMock.mockImplementation(async () => respuestaSimit([]));
    // 3 de 3 es el 100 %, y aun así se apaga: sobre una muestra diminuta un porcentaje no significa
    // nada — un NIT con tres comparendos que paga los tres es una corrida correcta.
    conteoDelBarrido(3, 3);

    const r = await sync();

    expect(r.body.resumen.inactivacionOmitida).toBeNull();
    expect(r.body.resumen.inactivados).toBe(1);
  });
});

describe('POST /sync — idempotencia', () => {
  it('re-sincronizar los mismos datos no duplica filas ni eventos', async () => {
    escenario({ existentes: [filaRegistro({ vistoEnMunicipal: true, descripcionInfraccion: 'Estacionar en sitio prohibido' })] });

    const r = await sync();

    expect(insertsEn('flito_comparendos_registros')).toHaveLength(0);
    expect(eventosEscritos()).toHaveLength(0);
    // Un solo UPDATE de datos. El otro que sale es el barrido de inactivación, que se lanza igual
    // —el NIT tuvo cobertura completa— y no encuentra nada porque todo se volvió a ver.
    const deDatos = updatesEn('flito_comparendos_registros').filter((d) => d.estado !== 'inactivo');
    expect(deDatos).toHaveLength(1);
    expect(r.body.resumen).toMatchObject({ upserts: 1, primeraLlegada: 0, reactivados: 0, inactivados: 0 });
  });
});

// ─────────────────────────── AC4 · Precondiciones ───────────────────────────────────────────────

describe('POST /sync — precondiciones (AC4)', () => {
  it('sin NITs activos → 400 sin crear corrida', async () => {
    escenario({ nits: [] });

    const r = await sync();

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('sin_nits_activos');
    // Nada de corridas fantasma: las precondiciones se comprueban ANTES del INSERT del sync_run.
    expect(insertsEn('flito_comparendos_sync_runs')).toHaveLength(0);
    expect(simitMock).not.toHaveBeenCalled();
  });

  it('filtro con un NIT que no está activo → 400 nombrando cuál', async () => {
    escenario({ nits: [NIT_A] });

    const r = await sync({ nits: [NIT_A, '700111222'] });

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('nits_filtro_invalido');
    // Ignorarlo devolvería un 200 con una corrida que no hizo lo que se pidió, y eso se descubre
    // tarde: alguien ve ceros y concluye que la empresa no debe nada.
    expect(r.body.error).toContain('700111222');
    expect(simitMock).not.toHaveBeenCalled();
  });

  it.each([
    ['con metacaracteres de URL', '900123456&fuente=x'],
    ['con letras', '900ABC456'],
    ['demasiado corto', '123'],
  ])('filtro %s → 400 de validación antes de tocar la base', async (_caso, nit) => {
    escenario();

    const r = await sync({ nits: [nit] });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('sin token configurado en modo real → 503 token_no_configurado y ninguna llamada al proveedor', async () => {
    entorno.COMPARENDOS_SIMIT_MODE = 'real';
    escenario();
    tokenMock.mockImplementation(async () => { throw new ComparendosTokenNoConfiguradoError(); });

    const r = await sync();

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('token_no_configurado');
    expect(simitMock).not.toHaveBeenCalled();
    expect(insertsEn('flito_comparendos_sync_runs')).toHaveLength(0);
  });

  it('un segundo sync en paralelo → 409 sync_en_curso', async () => {
    escenario();
    // Es lo que devuelve `withLock` cuando otro proceso tiene el lock vigente.
    withLockMock.mockImplementation(async () => null);

    const r = await sync();

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('sync_en_curso');
    expect(simitMock).not.toHaveBeenCalled();
  });

  it('el mapa de homologación vacío → 503 y ni una llamada (RN-12)', async () => {
    escenario({ mapa: [] });

    const r = await sync();

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('mapa_homologacion_vacio');
    expect(simitMock).not.toHaveBeenCalled();
  });
});

describe('POST /sync — modo simulado en producción (RN-16)', () => {
  it('aborta con 503 sin tocar la base ni a los proveedores', async () => {
    entorno.NODE_ENV = 'production';
    entorno.COMPARENDOS_SIMIT_MODE = 'mock';
    escenario();

    const r = await sync();

    // `COMPARENDOS_SIMIT_MODE` vale `mock` POR DEFECTO: si nadie la provisiona en PDN, sin este
    // guard el sync escribiría comparendos `MOCK-…` fabricados en la base productiva y acto seguido
    // inactivaría el histórico verdadero por «ausencia».
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('modo_simulado_en_produccion');
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();
    expect(simitMock).not.toHaveBeenCalled();
  });

  it('en producción con modo real la corrida sigue su curso', async () => {
    entorno.NODE_ENV = 'production';
    entorno.COMPARENDOS_SIMIT_MODE = 'real';
    escenario();

    const r = await sync();

    expect(r.status).toBe(200);
  });
});

// ─────────────────────────── Pasos: el detalle del fallo parcial ────────────────────────────────

describe('POST /sync — sync_run_steps', () => {
  it('persiste un paso por (NIT, fuente) con conteo y duración', async () => {
    escenario({ municipios: ['BELLO'] });

    await sync();

    const pasos = insertsEn('flito_comparendos_sync_steps').flatMap((d) => (Array.isArray(d) ? d : [d]));
    expect(pasos).toHaveLength(2);
    expect(pasos[0]).toMatchObject({ runId: RUN_ID, nit: NIT_A, fuente: 'simit', ok: true, itemsLeidos: 1 });
    expect(pasos[1]).toMatchObject({ fuente: 'BELLO', ok: true, itemsLeidos: 1 });
    expect(typeof pasos[0].duracionMs).toBe('number');
  });

  it('un error de fuente deja su `codigo` y el HTTP del PROVEEDOR en el paso', async () => {
    escenario({ municipios: [] });
    simitMock.mockImplementation(async () => { throw new ComparendosFuenteHttpError('simit', 'simit', 401); });

    const r = await sync();

    expect(r.body.steps[0]).toMatchObject({
      ok: false, errorCode: 'fuente_http', httpStatus: 401, itemsLeidos: null,
    });
    expect(r.body.estado).toBe('failed');
  });

  it('**los tres errores del token NO son ComparendosFuenteError y aun así llevan su código**', async () => {
    escenario({ municipios: [] });
    // El gate de la HU #11499 lo dejó escrito en el `@throws` del adapter: discriminar por
    // `instanceof ComparendosFuenteError` al escribir el paso se salta `llave_maestra`,
    // `token_no_configurado` y `token_descifrado`, y el operador vería «fallo inesperado» donde lo
    // que pasa es que falta provisionar una variable.
    simitMock.mockImplementation(async () => { throw new ComparendosTokenNoConfiguradoError(); });

    const r = await sync();

    expect(r.body.steps[0]).toMatchObject({ ok: false, errorCode: 'token_no_configurado', httpStatus: null });
    expect(r.body.steps[0].mensaje).toContain('token SIMIT');
  });

  it('un error inesperado NO copia su mensaje al paso, que se persiste', async () => {
    escenario({ municipios: [] });
    simitMock.mockImplementation(async () => {
      throw new Error('ECONNRESET https://verifik.test/v2?token=SECRETO-EN-LA-URL');
    });

    const r = await sync();

    // `sync_steps.mensaje` se conserva y se muestra: un `err.message` de librería es texto
    // arbitrario que puede arrastrar la URL, el cuerpo o datos del infractor (RN-20).
    expect(r.body.steps[0].errorCode).toBe('error_inesperado');
    expect(JSON.stringify(r.body.steps[0])).not.toContain('SECRETO-EN-LA-URL');
    expect(JSON.stringify(r.body.steps[0])).not.toContain('verifik.test');
  });

  it('estado `partial` cuando hubo de todo y `completed` cuando no falló nada', async () => {
    escenario({ municipios: ['BELLO', 'ITAGUI'] });
    municipalMock.mockImplementation(async (_n: string, fuente: string) => {
      if (fuente === 'ITAGUI') throw new ComparendosFuenteTimeoutError('municipal', 'ITAGUI', 8000);
      return respuestaMunicipal(fuente, []);
    });

    const r = await sync();

    expect(r.body.estado).toBe('partial');
    expect(r.body.resumen).toMatchObject({
      llamadasSimitOk: 1, llamadasSimitError: 0, llamadasMunicipalOk: 1, llamadasMunicipalError: 1,
    });
  });

  it('cierra la corrida con estado y resumen en la propia fila', async () => {
    escenario();

    await sync();

    const cierre = updatesEn('flito_comparendos_sync_runs')[0];
    expect(cierre).toMatchObject({ estado: 'completed' });
    expect(cierre.finalizadoEn).toBeInstanceOf(Date);
    expect(cierre.resumen).toMatchObject({ modo: 'mock', nitsProcesados: 1 });
  });
});

// ─────────────────────────── AC4 · Lectura de corridas ──────────────────────────────────────────

describe('GET /sync/runs', () => {
  const filaRun = (over: Record<string, unknown> = {}) => ({
    id: RUN_ID,
    estado: 'completed',
    scopeNits: [NIT_A],
    resumen: { modo: 'mock', nitsProcesados: 1 },
    iniciadoPor: 7,
    iniciadoEn: new Date('2026-08-13T10:00:00Z'),
    finalizadoEn: new Date('2026-08-13T10:00:42Z'),
    ...over,
  });

  it('lista las últimas corridas sin sus pasos', async () => {
    kdb.when.select('flito_comparendos_sync_runs', [filaRun()]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toEqual([{
      runId: RUN_ID,
      estado: 'completed',
      iniciadoEn: '2026-08-13T10:00:00.000Z',
      finalizadoEn: '2026-08-13T10:00:42.000Z',
      scopeNits: [NIT_A],
      resumen: { modo: 'mock', nitsProcesados: 1 },
      iniciadoPor: 7,
    }]);
  });

  it('una corrida que murió sin cerrarse se lee sin inventarse el final', async () => {
    kdb.when.select('flito_comparendos_sync_runs', [filaRun({ estado: 'running', resumen: null, finalizadoEn: null })]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs`).set('Authorization', await auth());

    expect(r.body[0]).toMatchObject({ estado: 'running', finalizadoEn: null, resumen: null });
  });

  it.each(['0', '101', 'muchas'])('limit inválido (%s) → 400', async (limit) => {
    const r = await request(await buildApp()).get(`${BASE}/sync/runs?limit=${limit}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(400);
  });

  it('el detalle trae los pasos de la corrida', async () => {
    kdb.when
      .select('flito_comparendos_sync_runs', [filaRun()])
      .select('flito_comparendos_sync_steps', [{
        nit: NIT_A, fuente: 'BELLO', ok: false, httpStatus: 502,
        errorCode: 'fuente_http', mensaje: 'el UTS municipal (fuente BELLO) respondió HTTP 502.',
        itemsLeidos: null, duracionMs: 812,
      }]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.steps).toEqual([{
      nit: NIT_A, fuente: 'BELLO', ok: false, httpStatus: 502,
      errorCode: 'fuente_http', mensaje: 'el UTS municipal (fuente BELLO) respondió HTTP 502.',
      itemsLeidos: null, duracionMs: 812,
    }]);
  });

  it('corrida inexistente → 404', async () => {
    kdb.when.select('flito_comparendos_sync_runs', []);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(404);
  });

  it('un id que no es UUID → 400 y no un 500 de PostgreSQL', async () => {
    const r = await request(await buildApp()).get(`${BASE}/sync/runs/no-soy-uuid`)
      .set('Authorization', await auth());

    expect(r.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Guardas y rastro ───────────────────────────────────────────────────

describe('sync — acceso y auditoría', () => {
  it('sin token no se sincroniza', async () => {
    const r = await request(await buildApp()).post(`${BASE}/sync`);

    expect(r.status).toBe(401);
    expect(simitMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'gestor_impuestos', 'conductor'])('rol %s → 403', async (rol) => {
    const r = await sync({}, rol);

    expect(r.status).toBe(403);
    expect(simitMock).not.toHaveBeenCalled();
  });

  it('GET /sync/runs con rol auditor → 403 (CF-12: solo admin)', async () => {
    const r = await request(await buildApp()).get(`${BASE}/sync/runs`)
      .set('Authorization', await auth('auditor'));

    expect(r.status).toBe(403);
  });

  it('la ráfaga de corridas se corta con 429', async () => {
    escenario();
    const app = await buildApp();
    // Usuario propio: el limitador cuenta por `sub` y así este caso no le gasta la cuota a los demás
    // tests del archivo ni depende de en qué orden corran.
    const cabecera = await auth('admin', 4242);

    let ultimo = 0;
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post(`${BASE}/sync`).set('Authorization', cabecera);
      ultimo = r.status;
    }

    // Solo se afirma sobre la última: si Vitest reintenta el test, el contador ya viene gastado y
    // las primeras responderían 429 también. Lo que importa es que el corte exista — el 409 de
    // `sync_en_curso` impide el solapamiento, pero no encadenar corridas seguidas.
    expect(ultimo).toBe(429);
  });

  it('deja en la bitácora la corrida y sus contadores, no la lista de NITs', async () => {
    escenario({ nits: [NIT_A, NIT_B] });

    await sync();

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1];
    expect(entrada).toMatchObject({
      action: 'update', resource: 'flito_comparendos_sync', resourceId: RUN_ID,
    });
    // El detalle de qué NITs entraron vive en `sync_runs.scope_nits`, al que se llega por el
    // `resourceId`: repetirlos aquí solo duplica el dato.
    expect(entrada.detail).not.toContain(NIT_A);
    expect(entrada.detail).toContain('2 NIT(s)');
  });

  it('el NIT no sale en claro en ninguna línea de log (Ley 1581, RN-20)', async () => {
    escenario();
    simitMock.mockImplementation(async () => { throw new Error('boom'); });

    await sync();

    const logueado = JSON.stringify(registros);
    expect(logueado).not.toContain(NIT_A);
    // Y sí sale enmascarado, que es lo que permite diagnosticar sin exponer el dato.
    expect(logueado).toContain('90****456');
  });
});
