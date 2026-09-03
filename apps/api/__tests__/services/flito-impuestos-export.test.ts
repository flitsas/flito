// FLITO Impuestos — export a Excel de la cola filtrada (Feature #11908, HU #11909, HU #11934).
//
// Gemelo de `flito-soat-export.test.ts` y con la misma doctrina: lo que se afirma es el WORKBOOK
// REAL, no la constante que lo generó. Las diferencias con el de SOAT son las que hacen que este
// archivo exista aparte y no sea una copia:
//
//   · **Los datos del trámite salen del `innerJoin` con `flito_tramites`**, porque
//     `flito_impuestos.tramite_id` es NOT NULL y UNIQUE: un impuesto tiene un trámite y solo uno.
//     Desde la HU #11934 eso incluye las NUEVE claves de `flit_raw` —la novena, `tipo`, la sumó la
//     HU #11947—, que entran como nueve expresiones más en la proyección que ya existía: cero joins
//     nuevos y cero consultas nuevas. En SOAT no se puede: hay que leer por lote y reconciliar.
//   · **Los tres datos técnicos del vehículo (HU #11906) NO estaban en la proyección de esta cola.**
//     El DTO de Impuestos no los publica y el archivo sí los pide, así que aquí se comprueba que se
//     leen — el defecto probable es copiarse la proyección del listado y entregar `Carroceria`,
//     `Servicio` y `Cilindraje` vacías en todas las filas.
//   · **El módulo no registraba NINGÚN acceso a PII** (`grep -c logPiiAccess` daba 0 en sus ocho
//     archivos). Aquí se fija que ahora lo hacen las dos lecturas: el export y el `GET /`.
//   · **El rol que sobra es `auditor`** (aquí no hay `cliente`: el canal es de SOAT).
//
// **Lo que esta suite NO puede probar, y dónde se prueba:** `__tests__/helpers/keyed-db.ts` no evalúa
// la proyección (`resolve(reg, name)`, línea 49), así que una expresión `sql\`… ->> 'clase'\`` no se
// ejecuta nunca aquí. El tramo «clave de FLIT → campo» —y con él el cruce `Linea`/`Modelo`— se afirma
// sobre el SQL RENDERIZADO en `cola-flito-derivados.test.ts`, junto con las funciones puras del
// bloque del titular y de la ciudad del organismo.
//
// El tope se baja por entorno a un número pequeño en vez de montar 2 000 filas de fixture: lo que se
// prueba es el BORDE (tope, tope+1), y el borde no depende del número.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

/** Tope de filas del export durante esta suite. Pequeño a propósito (ver cabecera). */
const TOPE = 3;

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLITO_COLA_EXPORT_MAX_FILAS') return TOPE;
        return target[prop as string];
      },
    }),
  };
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Orden observado: primero el rastro, después el primer byte del archivo. */
const orden: string[] = [];

const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => { orden.push('pii'); return logPiiAccessMock(...args); },
}));

/** `sendExcel` se ENVUELVE, no se sustituye: el archivo que se afirma es el de verdad. */
vi.mock('../../src/shared/utils/excel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/utils/excel.js')>();
  return {
    ...actual,
    sendExcel: (...args: Parameters<typeof actual.sendExcel>) => {
      orden.push('excel');
      return actual.sendExcel(...args);
    },
  };
});

const BASE = '/api/flito/impuestos';
const RUTA = `${BASE}/export`;
const TABLA = 'flito_impuestos';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const IMPUESTO_A = '11111111-1111-1111-1111-1111111111aa';
const IMPUESTO_JUR = '22222222-2222-2222-2222-2222222222aa';
const TRAMITE_A = '33333333-3333-3333-3333-333333333333';
const TRAMITE_JUR = '44444444-4444-4444-4444-444444444444';

const PLACA = 'KLM45N';
const VIN = '9BWZZZ377VT004251';
const CEDULA = '5060708090';

/**
 * Los DOS orígenes de ciudad, distintos a propósito: el `Municipio` es del TRÁMITE (Mosquera) y la
 * `OrganismoDettoCiudad` sale del CATÁLOGO por el código del impuesto (Palmira). Con la misma ciudad
 * en los dos, el atajo «la ciudad ya la tengo, la copio» pasaría todos los asertos.
 */
const ORGANISMO = '76520';        // STRIA TTEyTTO PALMIRA
const CIUDAD_ORGANISMO = 'Palmira';
const MUNICIPIO = 'MOSQUERA';

/** El nombre del titular, que desde la HU #11934 SÍ sale en el archivo. Viene de `flit_raw`. */
const CENTINELA_NOMBRE = 'CENTINELA-NOMBRE-TITULAR';
const CENTINELA_APELLIDOS = 'CENTINELA-APELLIDOS';
const CENTINELA_RAZON = 'CENTINELA-RAZON-SOCIAL SAS';

/**
 * `flito_compradores.nombre_completo`: los dos nombres FUNDIDOS por `flit-http.adapter.ts:74`. Esto
 * sigue siendo una PROHIBICIÓN — el archivo publica el nombre, pero desde el par SEPARADO del
 * payload y no partiendo esta cadena por el espacio.
 */
const CENTINELA_CONCATENADO = 'CENTINELA CONCATENADO';
const CENTINELA_MOTIVO = 'CENTINELA-MOTIVO-RECHAZO';

/**
 * Fila de `flito_impuestos` × joins, tal como la traería la base SIN proyectar.
 *
 * Las NUEVE claves de `flit_raw` entran con el nombre del CAMPO y no con el de la clave de FLIT
 * porque `keyed-db` no evalúa la proyección: estas son las claves del `select({...})` del servicio.
 * El cruce clave→campo se afirma en `cola-flito-derivados.test.ts`.
 *
 * `tipo: 'cc'` por defecto (HU #11947): es lo que decide las CINCO columnas del titular, y se pone
 * explícito en cada escenario que quiera otra clase.
 */
const filaImpuesto = (over: Record<string, unknown> = {}) => ({
  id: IMPUESTO_A,
  tramiteId: TRAMITE_A,
  placa: PLACA,
  vin: VIN,
  municipio: MUNICIPIO,
  organismoDetto: 'STRIA TTEyTTO MOSQUERA',
  carroceria: 'FURGON',
  servicio: 'Publico',
  cilindraje: '2400',
  organismoCodigo: ORGANISMO,
  marca: 'KIA',
  linea: 'STONIC',     // `flit_raw->>'modelo'` — la LÍNEA
  modelo: '2023',      // `flit_raw->>'modeloAno'` — el AÑO
  clase: 'CAMIONETA',
  capacidad: '1500',
  departamento: 'CUNDINAMARCA',
  nombres: CENTINELA_NOMBRE,
  apellidos: CENTINELA_APELLIDOS,
  tipo: 'cc',          // `flit_raw->>'tipo'` — QUÉ es el titular
  // Lo que la proyección del export NO pide. El mock keyed devuelve la fila entera aunque el
  // `select` pidiera menos, así que estas viajan igual y sirven de centinela.
  valorLiquidado: '480000.00',
  valorPagado: '480000.00',
  motivoRechazo: CENTINELA_MOTIVO,
  ...over,
});

const comprador = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tramiteId: TRAMITE_A,
  numeroDocumento: CEDULA,
  correo: 'pedro@empresa.co', celular: '3109876543', direccion: 'CRA 7 # 45-12',
  orden: 0,
  nombreCompleto: CENTINELA_CONCATENADO,
  ...over,
});

/**
 * Fila tal como la devuelve la consulta del LISTADO (`SELECT_COLA`), que es otra proyección.
 *
 * Se escribe aparte y no se mezcla con `filaImpuesto()` a propósito: son dos lecturas con dos
 * proyecciones distintas, y una fixture común escondería justamente lo que esta HU tiene que
 * separar —el archivo pide tres columnas del vehículo que el listado no publica—. Solo la usa el
 * caso del `GET /`.
 */
const filaCola = (over: Record<string, unknown> = {}) => ({
  id: IMPUESTO_A, tramiteId: TRAMITE_A, idFlit: 'FLIT-0001',
  tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: new Date('2026-08-01T10:00:00.000Z'),
  marca: 'CHEVROLET', linea: 'NHR',
  estado: 'solicitado', organismoCodigo: '25473',
  valorLiquidado: '480000.00', valorPagado: null,
  marcadoPorDiferencia: false, facturaVentaFlitId: null,
  gestionOperaciones: false,
  enviadoEn: new Date('2026-08-02T10:00:00.000Z'), pagadoEn: null,
  motivoRechazo: null, createdAt: new Date('2026-08-01T10:00:00.000Z'),
  placa: PLACA, vin: VIN, companiaNombre: 'ACME SAS',
  organismoNombre: 'MOSQUERA', organismoSla: 48,
  enviadoPorNombre: 'Ana',
  ...over,
});

const filas = (n: number) => Array.from({ length: n }, (_, i) => filaImpuesto({
  id: `${i}1111111-1111-1111-1111-1111111111a${i}`,
  tramiteId: `${i}3333333-3333-3333-3333-333333333${i}33`,
  placa: `BBB00${i}`,
}));

// ── App y sesiones ───────────────────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use(BASE, router);
  return app;
}

/**
 * Los DOS routers en la misma app: con una app por módulo, dos bolsas de cuota y una sola bolsa se
 * ven exactamente igual en verde.
 */
async function buildAppAmbas() {
  const app = express();
  app.use(express.json());
  const { default: impuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { default: soat } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use(BASE, impuestos);
  app.use('/api/flito/soat', soat);
  return app;
}

/** `sub` nuevo por caso: el limitador cuenta 5/min y usuario, y su ventana no se reinicia. */
let siguienteSub = 9500;
const sesion = async (role: TestRole = 'admin'): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const exportar = async (cabecera: string, cuerpo: unknown = {}) =>
  request(await buildApp())
    .post(RUTA)
    .set('Authorization', cabecera)
    .responseType('blob')
    .send(cuerpo as object);

// ── Espías de la consulta ────────────────────────────────────────────────────────────────────────

const consultas: {
  tabla: string; columnas: string[]; joins: string[];
  /**
   * El objeto de proyección TAL CUAL, no solo sus claves: `keyed-db` devuelve las filas del escenario
   * sin mirar la proyección, así que la única forma de saber de QUÉ columna sale un campo es leer de
   * qué está hecho. Ver `origenDe`.
   */
  proyeccion: Record<string, unknown>;
  limit: number | null; offset: number | null; where: unknown;
}[] = [];

/** De qué está hecho un campo de la proyección: `col:<tabla>.<columna>` o `sql:<SQL>|<params>`. */
function origenDe(valor: unknown): string {
  const col = valor as { name?: unknown; table?: unknown };
  if (col && typeof col.name === 'string' && col.table) return `col:${nombre(col.table)}.${col.name}`;
  // Los parámetros entran en la cadena: `sql\`… ->> ${'x'}\`` deja la clave fuera del texto del SQL,
  // y es justo la clave lo que hay que poder leer.
  const q = new PgDialect().sqlToQuery(valor as never);
  return `sql:${q.sql}|${(q.params as unknown[]).map(String).join(',')}`;
}

/** Los cuatro tipos de join, para poder afirmar QUÉ tablas entran en una lectura y cuáles no. */
const JOINS = ['innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'] as const;

function instalarEspias(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const consulta = {
      tabla: '__sin_from__', columnas, joins: [] as string[],
      proyeccion: (args[0] ?? {}) as Record<string, unknown>,
      limit: null as number | null, offset: null as number | null, where: null as unknown,
    };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { consulta.tabla = nombre(tbl); consultas.push(consulta); return from(tbl); };
    for (const m of JOINS) {
      const orig = chain[m] as (...a: unknown[]) => unknown;
      chain[m] = (tbl: unknown, ...resto: unknown[]) => {
        consulta.joins.push(nombre(tbl));
        return orig(tbl, ...resto);
      };
    }
    const limit = chain.limit as (n: number) => unknown;
    chain.limit = (n: number) => { consulta.limit = n; return limit(n); };
    const offset = chain.offset as (n: number) => unknown;
    chain.offset = (n: number) => { consulta.offset = n; return offset(n); };
    const where = chain.where as (c: unknown) => unknown;
    chain.where = (cond: unknown) => { consulta.where = cond; return where(cond); };
    return chain;
  });
}

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

const lecturasDe = (tabla: string) => consultas.filter((c) => c.tabla === tabla);

function whereDelExport(): { sql: string; params: unknown[] } {
  const lecturas = lecturasDe(TABLA);
  expect(lecturas.length, 'el export lee `flito_impuestos` exactamente una vez').toBe(1);
  return new PgDialect().sqlToQuery(lecturas[0].where as never);
}

// ── Lectura del workbook ─────────────────────────────────────────────────────────────────────────

async function libro(cuerpo: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(cuerpo);
  const hoja = wb.worksheets[0];
  expect(hoja).toBeDefined();
  return hoja!;
}

/**
 * Las VEINTICINCO cabeceras ESCRITAS A MANO, igual que en la suite de SOAT.
 *
 * Se repiten a propósito en los dos archivos en vez de sacarlas a un helper compartido: si vivieran
 * en un solo sitio, ese sitio sería una segunda constante de producción disfrazada de test y las dos
 * suites podrían romperse a la vez con una sola edición. Cada archivo afirma por su cuenta que el
 * documento es exactamente este.
 *
 * (Que la LISTA DE PRODUCCIÓN sea una sola —y no dos copias— se comprueba en ejecución, con una
 * columna inyectada, en `flito-soat-export.test.ts`: un `toEqual` entre las cabeceras de los dos
 * archivos pasaría igual de bien con dos copias recién hechas.)
 */
const CABECERAS = [
  'Vin', 'Placa', 'Modelo', 'Servicio', 'Marca', 'Linea', 'Clase', 'Carroceria', 'Cilindraje',
  'CapacidadCargaOPasajeros', 'Puertas', 'OrganismoDetto', 'N_I', 'ClaseDeInterlocutor',
  'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId', 'NumeroId', 'Direccion', 'Municipio',
  'Departamento', 'Celular', 'Correo', 'OrganismoDettoCiudad',
];

const cabecerasDe = (hoja: ExcelJS.Worksheet): string[] =>
  (hoja.getRow(1).values as unknown[]).slice(1).map(String);

/**
 * El valor de una celda por el TEXTO de su cabecera, con el índice leído del ARCHIVO y no de
 * `CABECERAS`: con el índice sacado de la lista escrita a mano, una permutación de `header` sin
 * permutar `key` se leería «corregida» por el propio test.
 */
function celda(hoja: ExcelJS.Worksheet, nFila: number, cabecera: string): unknown {
  const indice = cabecerasDe(hoja).indexOf(cabecera);
  expect(indice, `la cabecera «${cabecera}» no está en el archivo`).toBeGreaterThanOrEqual(0);
  return hoja.getRow(nFila).getCell(indice + 1).value;
}

function textoDe(hoja: ExcelJS.Worksheet): string {
  const partes: string[] = [];
  hoja.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (c) => partes.push(String(c.value ?? '')));
  });
  return partes.join('|');
}

const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

function fuenteDelRouter(): string {
  return readFileSync(
    fileURLToPath(new URL('../../src/modules/flito-impuestos/flito-impuestos.routes.ts', import.meta.url)),
    'utf8',
  );
}

beforeEach(() => {
  kdb.reset();
  instalarEspias();
  logPiiAccessMock.mockClear();
  consultas.length = 0;
  orden.length = 0;
});

// ─────────────────────────── Las once columnas ───────────────────────────────────────────────────

describe('el archivo tiene EXACTAMENTE veinticinco columnas, en su orden', () => {
  it('las 25 cabeceras en CamelCase literal, y `columnCount === 25`', async () => {
    kdb.when.scenario({ flito_impuestos: filas(2), flito_compradores: [] });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);
    const hoja = await libro(r.body as Buffer);

    expect(cabecerasDe(hoja)).toEqual(CABECERAS);
    expect(hoja.columnCount).toBe(25);
  });

  it('NO hay columna de fecha de creación, ni de valor pagado, ni de proveedor', async () => {
    kdb.when.scenario({ flito_impuestos: filas(1), flito_compradores: [] });

    const cabeceras = cabecerasDe(await libro((await exportar(await sesion())).body as Buffer));

    // Las tres tentaciones de la OPERACIÓN de FLITO que siguen vivas: una fecha porque el filtro
    // nuevo es por creación, el importe porque está en la fila, el proveedor porque está en la
    // pantalla. (`Municipio` y el nombre del titular SÍ existen ahora: la HU #11934 los añadió.)
    expect(cabeceras.filter((h) => /Cread|Fecha/i.test(h))).toEqual([]);
    expect(cabeceras.filter((h) => /Valor|Pagad/i.test(h))).toEqual([]);
    expect(cabeceras.filter((h) => /Proveedor/i.test(h))).toEqual([]);
  });

  it('**los tres datos técnicos del vehículo salen con su valor** (HU #11906)', async () => {
    // El DTO de esta cola NO los publica, así que el defecto probable es copiarse la proyección del
    // listado: el archivo saldría con `Carroceria`, `Servicio` y `Cilindraje` vacías en TODAS las
    // filas, se abriría sin quejarse y los asertos de cabeceras pasarían igual.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'Carroceria')).toBe('FURGON');
    expect(celda(hoja, 2, 'Servicio')).toBe('Publico');
    expect(celda(hoja, 2, 'Cilindraje')).toBe('2400');
    // Y el municipio, que aquí es directo (1:1 con el trámite) y no reconciliado como en SOAT.
    expect(celda(hoja, 2, 'Municipio')).toBe(MUNICIPIO);
  });
});

// ─────────────────────────── Cada valor bajo SU cabecera ─────────────────────────────────────────

describe('cada valor cae bajo la cabecera que le toca — 25 centinelas distinguibles', () => {
  /** Dos filas: el bloque del titular tiene formas EXCLUYENTES (natural y jurídica). */
  const escenarioDeDosFormas = () => kdb.when.scenario({
    flito_impuestos: [
      filaImpuesto(),
      filaImpuesto({
        id: IMPUESTO_JUR, tramiteId: TRAMITE_JUR, placa: 'ZZZ999', vin: 'VINJURIDICA00002',
        // Lo que la hace jurídica es el `tipo`, no la falta de apellido (HU #11947).
        tipo: 'n',
        nombres: CENTINELA_RAZON,
        // «Solo espacios» es la forma REAL en la que llega la ausencia de apellido: ni vacío ni nulo
        // (3 510 de 7 052 filas medidas).
        apellidos: ' ',
      }),
    ],
    flito_compradores: [
      comprador(),
      comprador({ id: 'c2', tramiteId: TRAMITE_JUR, numeroDocumento: '9007654321' }),
    ],
  });

  it('**las 25 celdas de la fila natural, una por una**', async () => {
    // El mutante que SOLO este caso mata: permutar dos `header` de `COLUMNAS_COLA_EXPORT` sin
    // permutar sus `key`. ExcelJS escribe cada fila buscando `fila[col.key]`, así que el archivo
    // saldría con las cabeceras nuevas y los VALORES cruzados, y el aserto de cabeceras de arriba
    // seguiría verde.
    escenarioDeDosFormas();

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const c = (cabecera: string) => celda(hoja, 2, cabecera) ?? null;

    expect(c('Vin')).toBe(VIN);
    expect(c('Placa')).toBe(PLACA);
    expect(c('Modelo')).toBe('2023');       // el AÑO
    expect(c('Servicio')).toBe('Publico');
    expect(c('Marca')).toBe('KIA');
    expect(c('Linea')).toBe('STONIC');      // la LÍNEA, que FLIT manda bajo la clave `modelo`
    expect(c('Clase')).toBe('CAMIONETA');
    expect(c('Carroceria')).toBe('FURGON');
    expect(c('Cilindraje')).toBe('2400');
    expect(c('CapacidadCargaOPasajeros')).toBe('1500');
    expect(c('Puertas')).toBe('4');
    expect(c('OrganismoDetto')).toBe('STRIA TTEyTTO MOSQUERA');
    expect(c('N_I')).toBe('IMPORTADO');
    expect(c('ClaseDeInterlocutor')).toBe('PNAT');
    expect(c('NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(c('Apellidos')).toBe(CENTINELA_APELLIDOS);
    expect(c('RazonSocial')).toBeNull();    // excluyente con las dos de arriba
    expect(c('ClaseId')).toBe('CC');
    expect(c('NumeroId')).toBe(CEDULA);
    expect(c('Direccion')).toBe('CRA 7 # 45-12');
    expect(c('Municipio')).toBe(MUNICIPIO);
    expect(c('Departamento')).toBe('CUNDINAMARCA');
    expect(c('Celular')).toBe('3109876543');
    expect(c('Correo')).toBe('pedro@empresa.co');
    expect(c('OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);
  });

  it('las tres celdas que solo tiene la fila JURÍDICA, y sus dos contrarias vacías', async () => {
    escenarioDeDosFormas();

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const c = (cabecera: string) => celda(hoja, 3, cabecera) ?? null;

    expect(c('ClaseDeInterlocutor')).toBe('PJUR');
    expect(c('ClaseId')).toBe('NIT');
    expect(c('RazonSocial')).toBe(CENTINELA_RAZON);
    expect(c('NombrePila')).toBeNull();
    expect(c('Apellidos')).toBeNull();
    expect(c('NumeroId')).toBe('9007654321');
    expect(c('Placa')).toBe('ZZZ999');
  });

  it('**`Municipio` y `OrganismoDettoCiudad` son datos DISTINTOS**', async () => {
    // Mata el atajo «la ciudad ya la tengo»: copiar `flito_tramites.ciudad` en las dos columnas.
    // Aquí el trámite es de Mosquera y el organismo del impuesto, de Palmira.
    escenarioDeDosFormas();

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'Municipio')).toBe('MOSQUERA');
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe('Palmira');
    expect(celda(hoja, 2, 'Municipio')).not.toBe(celda(hoja, 2, 'OrganismoDettoCiudad'));
  });

  it('un organismo FUERA del catálogo deja la ciudad vacía, no un 500', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ organismoCodigo: '99999' })],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(celda(hoja, 2, 'OrganismoDettoCiudad') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
  });

  it('**`modeloAno` como NÚMERO del jsonb no tumba el export**', async () => {
    // `flit_raw` es `jsonb` de un tercero: un `.trim()` sobre ese número sería un TypeError dentro
    // del `map` de las filas y el archivo entero respondería 500 por UNA fila.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ modelo: 2023, capacidad: 1500 })],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(String(celda(hoja, 2, 'Modelo'))).toBe('2023');
    expect(String(celda(hoja, 2, 'CapacidadCargaOPasajeros'))).toBe('1500');
  });

  it('**`Clase` está mapeada aunque FLIT no la mande hoy**', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ clase: 'AUTOMOVIL' })],
      flito_compradores: [comprador()],
    });
    const conClase = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(conClase, 2, 'Clase')).toBe('AUTOMOVIL');

    // Y sin ella —el estado de hoy— la celda va vacía y la fila sale igual.
    kdb.reset(); instalarEspias(); consultas.length = 0;
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ clase: undefined })],
      flito_compradores: [comprador()],
    });
    const sinClase = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(sinClase, 2, 'Clase') ?? null).toBeNull();
    expect(celda(sinClase, 2, 'Marca')).toBe('KIA');
  });

  it('**un trámite SIN `flit_raw` deja las cinco del titular vacías**, no `PJUR` + `NIT`', async () => {
    // `flito_tramites.flit_raw` es nullable, y un trámite anterior al sync actual (o cargado a mano)
    // lo tiene a NULL: las NUEVE expresiones `->>` devuelven NULL y aquí llegan las nueve claves
    // vacías —`tipo` incluido, que es lo que decide el bloque desde la HU #11947—. Es el gemelo,
    // dentro de Impuestos, de lo que en SOAT es el canal Cliente, y el sitio donde tanto la regla de
    // dos estados de la #11934 (`if (!apellidos) → PJUR/NIT`) como una rama por defecto que
    // clasificara se verían de punta a punta: la fila saldría marcada persona JURÍDICA, con `NIT`, y
    // la razón social VACÍA. Ningún aserto de cabeceras se enteraría.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({
        nombres: null, apellidos: null, tipo: null,
        marca: null, linea: null, modelo: null, clase: null, capacidad: null, departamento: null,
      })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(hoja.rowCount).toBe(2); // la fila SALE igual

    for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía sin payload`).toBeNull();
    }
    const texto = textoDe(hoja);
    expect(texto).not.toContain('PJUR');
    expect(texto).not.toContain('NIT');

    // Y lo que no depende del payload sigue lleno: la fila no se vacía entera.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(celda(hoja, 2, 'Municipio')).toBe(MUNICIPIO);
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);
    expect(celda(hoja, 2, 'Puertas')).toBe('4');
  });

  it('**una clave ANIDADA no se publica**: celda vacía y la fila sin clasificar', async () => {
    // Corrección del gate de seguridad (Medium sobre `dcd57ea`). `->>` no falla ante un objeto: lo
    // SERIALIZA —medido en Postgres 16, `'{"n":{"a":1,"b":"ANA"}}'::jsonb ->> 'n'` devuelve
    // `{"a": 1, "b": "ANA"}` como `text`—, así que el día que FLIT anide algo bajo una de las nueve
    // claves el blob entero acabaría en una celda de un archivo que sale del perímetro, sin error y
    // sin log, y con datos que `pii_access_log` no declara.
    //
    // La fixture usa la CADENA que Postgres produce, no un objeto JS: es lo que de verdad llega al
    // servicio. (Un objeto JS aquí ejercitaría una rama que no ocurre nunca — exactamente el error
    // que el gate encontró en el test unitario.) Este caso muerde la guarda de JS; la del SQL, que
    // es la de verdad, se afirma en `cola-flito-derivados.test.ts` sobre el SQL renderizado.
    const CEDULA_ANIDADA = '99887766554';
    const BLOB = `{"primer": "ANA", "segundo": "MARIA", "cedula": "${CEDULA_ANIDADA}"}`;
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: 'n', nombres: BLOB, apellidos: ' ', marca: '["KIA", "SA"]' })],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);
    const hoja = await libro(r.body as Buffer);

    // Ni entero ni troceado: nada del blob aparece en ninguna celda —incluida la cédula que venía
    // DENTRO y que nadie declaró.
    const texto = textoDe(hoja);
    expect(texto).not.toContain('primer');
    expect(texto).not.toContain('segundo');
    expect(texto).not.toContain(CEDULA_ANIDADA);
    expect(celda(hoja, 2, 'Marca') ?? null).toBeNull();

    // Las TRES columnas de nombre, vacías: el blob no se publica por ninguna vía.
    for (const c of ['NombrePila', 'Apellidos', 'RazonSocial']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía`).toBeNull();
    }
    // Y la clase SÍ sale, porque la afirma el `tipo` —escalar y bien formado— y no el nombre
    // (HU #11947): descartar el blob no descalifica al titular, y clasificar al titular no rescata
    // el blob. Son dos decisiones independientes.
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    // La fila SALE igual, con lo que no viene del payload.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'Municipio')).toBe(MUNICIPIO);
  });

  it('**un `tipo` ANIDADO no clasifica**: las cinco del titular vacías', async () => {
    // La mitad que importa desde la HU #11947: si `tipo` llegara como objeto, `->>` lo serializaría
    // y ese texto entraría al lookup como cualquier token. La garantía que hace falta es que un
    // valor NO ESCALAR no pueda clasificar nada, no que hoy no coincida por casualidad.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: '{"documento": "cc"}' })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía`).toBeNull();
    }
    expect(textoDe(hoja)).not.toContain(CENTINELA_NOMBRE);
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
  });

  it('**el espacio en `apellidos` YA NO clasifica como jurídica**: manda el `tipo` (HU #11947)', async () => {
    // La regresión que prueba que la heurística de la #11934 murió. Con ella —«sin apellido =
    // empresa»— la MITAD del parque medido (3 510 de 7 052 filas de «solo espacios», cero vacías y
    // cero nulas) salía `PJUR` + `NIT` con el NOMBRE DE UNA PERSONA en `RazonSocial`. Aquí el origen
    // dice `cc`: lo que falta es el apellido, no la clase.
    for (const blanco of [' ', '  ', '\t', null]) {
      kdb.reset(); instalarEspias(); consultas.length = 0;
      kdb.when.scenario({
        flito_impuestos: [filaImpuesto({ tipo: 'cc', nombres: CENTINELA_NOMBRE, apellidos: blanco })],
        flito_compradores: [comprador()],
      });

      const hoja = await libro((await exportar(await sesion())).body as Buffer);
      expect(celda(hoja, 2, 'ClaseDeInterlocutor'), `«${JSON.stringify(blanco)}»`).toBe('PNAT');
      expect(celda(hoja, 2, 'ClaseId')).toBe('CC');
      expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
      expect(celda(hoja, 2, 'Apellidos') ?? null).toBeNull();
      expect(celda(hoja, 2, 'RazonSocial') ?? null).toBeNull();
    }
  });

  it('**`n` CON apellido → `PJUR` + `NIT`**: el caso que la regla vieja resolvía al revés', async () => {
    // Con el apellido VACÍO la regla de la #11934 también decía `PJUR`/`NIT`, así que un caso escrito
    // así pasaría sin el cambio. Con el apellido LLENO decía `PNAT`/`CC`.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: 'n', nombres: CENTINELA_RAZON, apellidos: CENTINELA_APELLIDOS })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'RazonSocial')).toBe(CENTINELA_RAZON);
    expect(celda(hoja, 2, 'NombrePila') ?? null).toBeNull();
    expect(textoDe(hoja)).not.toContain(CENTINELA_APELLIDOS);
  });

  it('`ps` → `PP` (NUNCA `PAS`), `ce` → `CE`, y `otro` → `PNAT` sin documento', async () => {
    // Los tres asertos van por PAR: clase y documento juntos. `PP` es el vocabulario de la plantilla
    // del CLIENTE; `TIPOS_DOCUMENTO_RUNT` usa `PAS` y es otro catálogo, que el AC8 deja intacto.
    for (const [tipo, claseId] of [['ps', 'PP'], ['ce', 'CE']] as const) {
      kdb.reset(); instalarEspias(); consultas.length = 0;
      kdb.when.scenario({
        flito_impuestos: [filaImpuesto({ tipo })], flito_compradores: [comprador()],
      });
      const hoja = await libro((await exportar(await sesion())).body as Buffer);
      expect(celda(hoja, 2, 'ClaseId'), tipo).toBe(claseId);
      expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
      expect(textoDe(hoja)).not.toContain('PAS');
    }

    // `otro`: clase conocida, documento NO. Es distinto del AC5 —donde no hay ni clase— y un aserto
    // que solo mirase `ClaseId` daría verde en los dos y no distinguiría nada.
    kdb.reset(); instalarEspias(); consultas.length = 0;
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: 'otro' })], flito_compradores: [comprador()],
    });
    const otro = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(otro, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
    expect(celda(otro, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(celda(otro, 2, 'Apellidos')).toBe(CENTINELA_APELLIDOS);
    expect(celda(otro, 2, 'ClaseId') ?? null).toBeNull();
  });

  it('**`c`, `""`, `"xx"` y la clave ausente dejan las CINCO vacías** (AC5)', async () => {
    // La rama por defecto, y el primer mutante nombrado de la HU: devolver `{PNAT, CC}` en vez de
    // vacío marcaría con cédula cada fila sin payload en un archivo que sale del perímetro.
    // `c` está en la lista a propósito: la tabla acepta `cc` y NO `c` —que no aparece ni una vez en
    // las 7 052 filas medidas— (decisión de David, 2026-09-01).
    for (const tipo of ['c', '', ' ', 'xx', null, undefined]) {
      kdb.reset(); instalarEspias(); consultas.length = 0;
      kdb.when.scenario({
        flito_impuestos: [filaImpuesto({ tipo })], flito_compradores: [comprador()],
      });

      const hoja = await libro((await exportar(await sesion())).body as Buffer);
      for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
        expect(celda(hoja, 2, c) ?? null, `«${JSON.stringify(tipo)}» → ${c}`).toBeNull();
      }
      const texto = textoDe(hoja);
      expect(texto).not.toContain(CENTINELA_NOMBRE);
      expect(texto).not.toContain('PJUR');
      // Y la fila SALE igual con lo que no depende del titular.
      expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
      expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    }
  });

  it('**`tipo` explícito y SIN nombre sigue clasificando**: son las 7 filas medidas', async () => {
    // Decisión de David (2026-09-01), AC1 literal: 7 filas de 7 052 con `tipo` y sin nombres ni
    // apellidos (1 `n`, 6 `cc`). La guarda de la #11934 —«sin ninguno de los dos, bloque vacío»— ya
    // no está: aquí la clase la AFIRMA el origen y lo que falta es solo el nombre.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: 'n', nombres: ' ', apellidos: ' ' })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'RazonSocial') ?? null).toBeNull();
  });
});

// ─────────────────────────── Lista blanca ────────────────────────────────────────────────────────

describe('lista blanca — el archivo lleva lo que la lista dice y la consulta no pide más', () => {
  it('**el nombre del titular SÍ sale, y NO viene de partir `nombre_completo`**', async () => {
    // Este bloque se invierte a medias con la HU #11934: el archivo AHORA publica el nombre, pero lo
    // saca del par SEPARADO de `flit_raw` y **no** partiendo `flito_compradores.nombre_completo`,
    // que es la cadena que `flit-http.adapter.ts:74` funde. Esa columna sigue sin leerse: el
    // `split(' ')` es el atajo cómodo y fallaría en cada nombre compuesto y en cada razón social.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    const lecturaCompradores = lecturasDe('flito_compradores');
    expect(lecturaCompradores.length).toBeGreaterThan(0);
    for (const l of lecturaCompradores) {
      expect(l.columnas.length, 'el select de compradores tiene que ir proyectado').toBeGreaterThan(0);
      expect(l.columnas).not.toContain('nombreCompleto');
    }
    const texto = textoDe(hoja);
    expect(texto).not.toContain(CENTINELA_CONCATENADO);
    expect(texto).not.toContain('CONCATENADO');

    expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(celda(hoja, 2, 'Apellidos')).toBe(CENTINELA_APELLIDOS);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });

  it('**la clasificación no sale de `tipo_documento`**: `CC` en la tabla y aun así `NIT` en la hoja', async () => {
    // `flito_compradores.tipo_documento` existe y está a 0 de 7 052 para las filas del sync: solo lo
    // escribe el canal Cliente, que en Impuestos ni siquiera existe. Un predicado sobre esa columna
    // clasificaría el parque entero como una sola cosa. La señal es `flit_raw->>'tipo'` (HU #11947),
    // y la fixture pone las dos fuentes en CONTRADICCIÓN —la columna dice `CC`, el payload dice
    // `n`— porque es la única forma de ver cuál manda.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ tipo: 'n', nombres: CENTINELA_RAZON, apellidos: ' ' })],
      flito_compradores: [comprador({ tipoDocumento: 'CC' })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'RazonSocial')).toBe(CENTINELA_RAZON);
  });

  it('**`OrganismoDettoCiudad` se calcula sobre la COLUMNA normalizada, no sobre `codigoSecretaria`**', async () => {
    // El mutante más silencioso de la HU, y no lo ve NINGÚN aserto de celdas: leer el código del
    // organismo de `flit_raw->>'codigoSecretaria'` en vez de `flito_impuestos.organismo_codigo`. Los
    // dos parecen el mismo dato; el del payload llega SIN el cero de relleno en 3 650 de 7 052 filas
    // (`5001` donde el catálogo tiene `05001`), así que `getOrganismoByCodigo` devolvería `undefined`
    // y **el 51,8 % de las filas saldría con la ciudad vacía sin un solo error**. Con una fixture que
    // ya trae `organismoCodigo`, el archivo sale idéntico con las dos versiones.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    await exportar(await sesion());

    const principal = lecturasDe(TABLA)[0];
    expect(origenDe(principal.proyeccion.organismoCodigo)).toBe('col:flito_impuestos.organismo_codigo');

    // Y ninguna expresión de la proyección toca esa clave del payload.
    for (const [campo, valor] of Object.entries(principal.proyeccion)) {
      expect(origenDe(valor), campo).not.toContain('codigoSecretaria');
    }
  });

  it('la lectura principal NO gana joins nuevos: las nueve claves salen del que ya había', async () => {
    // `conJoinsColaImpuestos` ya une `flito_tramites` 1:1 (`tramite_id` NOT NULL UNIQUE), así que las
    // nueve expresiones `->>` entran en la proyección sin un join más y sin una consulta más. Un join
    // añadido «para leer el payload» sería un duplicador de filas esperando a que alguien lo suelte.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    await exportar(await sesion());

    const principal = lecturasDe(TABLA)[0];
    expect(principal.joins).toEqual(['flito_tramites', 'vehicles', 'clients', 'organismos_transito_config', 'users']);
    // Y una sola lectura de la tabla principal: el payload no cuesta una segunda pasada.
    expect(lecturasDe(TABLA)).toHaveLength(1);
    expect(lecturasDe('flito_tramites')).toHaveLength(0);
  });

  it('los importes y el motivo de rechazo no entran en la consulta ni en el archivo', async () => {
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    const proyeccion = lecturasDe(TABLA)[0].columnas;
    expect(proyeccion.length, 'la lectura principal tiene que ir proyectada').toBeGreaterThan(0);
    for (const prohibida of ['valorLiquidado', 'valorPagado', 'motivoRechazo', 'gestionOperaciones']) {
      expect(proyeccion).not.toContain(prohibida);
    }

    const texto = textoDe(hoja);
    expect(texto).not.toContain(CENTINELA_MOTIVO);
    expect(texto).not.toContain('480000');
  });
});

// ─────────────────────────── El conjunto, no una página ──────────────────────────────────────────

describe('un export no pagina', () => {
  it('pide `tope + 1` filas, sin `offset`, y en UNA sola lectura (sin `count(*)`)', async () => {
    kdb.when.scenario({ flito_impuestos: filas(2), flito_compradores: [] });

    expect((await exportar(await sesion())).status).toBe(200);

    const lecturas = lecturasDe(TABLA);
    expect(lecturas).toHaveLength(1);
    expect(lecturas[0].limit).toBe(TOPE + 1);
    expect(lecturas[0].offset).toBeNull();
  });

  it('`page`, `pageSize` y `cursor` en el cuerpo son 400', async () => {
    const cabecera = await sesion();

    expect((await exportar(cabecera, { page: 2 })).status).toBe(400);
    expect((await exportar(cabecera, { pageSize: 50 })).status).toBe(400);
    expect((await exportar(cabecera, { cursor: 'abc' })).status).toBe(400);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('un campo desconocido es 400 y no un filtro ignorado en silencio', async () => {
    // `proveedores` NO es un filtro de esta cola —el equivalente aquí es el organismo— y sin
    // `.strict()` se ignoraría, devolviendo la cola entera como si el filtro se hubiera aplicado.
    const r = await exportar(await sesion(), { proveedores: ['x'] });
    expect(r.status).toBe(400);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('`gestion` solo admite el vocabulario de esta cola', async () => {
    // `proveedor` es el de SOAT: aceptarlo aquí sería copiar el esquema del otro módulo y producir un
    // filtro que no acota nada.
    expect((await exportar(await sesion(), { gestion: 'proveedor' })).status).toBe(400);
    expect((await exportar(await sesion(), { gestion: 'organismo' })).status).toBe(200);
  });
});

// ─────────────────────────── «Creado» es created_at ──────────────────────────────────────────────

describe('el rango nuevo filtra por `created_at`, no por `enviado_en`', () => {
  it('`creadoDesde`/`creadoHasta` entran en el WHERE sobre `created_at`', async () => {
    kdb.when.scenario({ flito_impuestos: filas(1), flito_compradores: [] });

    const r = await exportar(await sesion(), { creadoDesde: '2026-08-01', creadoHasta: '2026-08-31' });
    expect(r.status).toBe(200);

    const { sql, params } = whereDelExport();
    // El mutante nombrado: `flitoImpuestos.createdAt` → `flitoImpuestos.enviadoEn` en
    // `condicionesColaImpuestos`. Devolvería filas igualmente y solo estos asertos lo ponen rojo.
    expect(sql).toMatch(/"created_at" >= \$\d+::date/);
    expect(sql).toMatch(/"created_at" < \(\$\d+::date \+ INTERVAL '1 day'\)/);
    expect(sql).not.toContain('enviado_en');
    expect(params).toContain('2026-08-01');
    expect(params).toContain('2026-08-31');
  });

  it('el borde superior es INCLUSIVO por día: `< hasta + 1 día`, nunca `<= hasta`', async () => {
    kdb.when.scenario({ flito_impuestos: filas(1), flito_compradores: [] });

    await exportar(await sesion(), { creadoHasta: '2026-08-31' });

    const { sql } = whereDelExport();
    // Con `<= $1::date`, un registro de las 23:59 del 31 quedaría FUERA —el cast a `date` lo lleva a
    // medianoche— y quien filtra «hasta el 31» perdería la última jornada sin que nada se lo diga.
    expect(sql).toMatch(/"created_at" < \(\$\d+::date \+ INTERVAL '1 day'\)/);
    expect(sql).not.toMatch(/"created_at" <= /);
  });

  it('el `GET /` de la cola acepta el MISMO rango', async () => {
    kdb.when.scenario({ flito_impuestos: [], flito_compradores: [] });

    const r = await request(await buildApp())
      .get(`${BASE}?creadoDesde=2026-08-01&creadoHasta=2026-08-31`)
      .set('Authorization', await sesion());

    expect(r.status).toBe(200);
    const { sql } = new PgDialect().sqlToQuery(lecturasDe(TABLA)[0].where as never);
    expect(sql).toMatch(/"created_at" >= \$\d+::date/);
    expect(sql).toMatch(/"created_at" < \(\$\d+::date \+ INTERVAL '1 day'\)/);
  });
});

// ─────────────────────────── Paridad de predicado ────────────────────────────────────────────────

describe('paridad — el archivo y la pantalla filtran con el MISMO predicado', () => {
  it('el WHERE del export y el del `GET /` serializan idénticos para los mismos filtros', async () => {
    const cabecera = await sesion();
    kdb.when.scenario({ flito_impuestos: [], flito_compradores: [] });

    await request(await buildApp())
      .get(`${BASE}?estado=solicitado&organismos=25473&creadoDesde=2026-08-01`)
      .set('Authorization', cabecera);
    const pantalla = new PgDialect().sqlToQuery(lecturasDe(TABLA)[0].where as never);

    consultas.length = 0;
    kdb.reset(); instalarEspias();
    kdb.when.scenario({ flito_impuestos: [], flito_compradores: [] });

    await exportar(cabecera, {
      estados: ['solicitado'], organismos: ['25473'], creadoDesde: '2026-08-01',
    });
    const archivo = new PgDialect().sqlToQuery(lecturasDe(TABLA)[0].where as never);

    expect(archivo.sql).toBe(pantalla.sql);
    expect(archivo.params).toEqual(pantalla.params);
  });
});

// ─────────────────────────── Tope y 422 ──────────────────────────────────────────────────────────

describe('tope — 422 sin archivo, y el borde no se pasa de largo', () => {
  it('EXACTAMENTE `tope` filas es 200 con `tope` filas de datos', async () => {
    kdb.when.scenario({ flito_impuestos: filas(TOPE), flito_compradores: [] });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(hoja.rowCount).toBe(TOPE + 1); // + encabezado
    expect(lecturasDe(TABLA)[0].limit).toBe(TOPE + 1);
  });

  it('`tope + 1` filas es 422, SIN `Content-Disposition` y sin haber llamado a `sendExcel`', async () => {
    kdb.when.scenario({ flito_impuestos: filas(TOPE + 1), flito_compradores: [] });

    const r = await exportar(await sesion());

    expect(r.status).toBe(422);
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(orden).not.toContain('excel');
  });

  it('el 422 trae `codigo` y NO revela cuántas filas hay', async () => {
    kdb.when.scenario({ flito_impuestos: filas(TOPE + 1), flito_compradores: [] });

    const r = await exportar(await sesion());
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;

    expect(cuerpo.codigo).toBe('export_demasiado_grande');
    expect(cuerpo.error).toContain('3');
    expect(cuerpo.error).not.toContain('4');
  });
});

// ─────────────────────────── Fronteras y roles ───────────────────────────────────────────────────

describe('fronteras — quién puede descargar y qué', () => {
  it('`auditor` recibe 403', async () => {
    const r = await exportar(await sesion('auditor'));
    expect(r.status).toBe(403);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('el gestor de impuestos arrastra su frontera al WHERE del archivo', async () => {
    kdb.when.scenario({
      // La atadura CA-10 vive en `flito_gestor_organismos` desde la HU #12053: una fila por
      // organismo, no una columna de `users`.
      flito_gestor_organismos: [{ codigo: '25473' }],
      flito_impuestos: filas(1), flito_compradores: [],
    });

    expect((await exportar(await sesion('gestor_impuestos'))).status).toBe(200);

    const { sql, params } = whereDelExport();
    // Las dos fronteras de esta cola: su organismo (CA-10) y nada de lo asumido por Operaciones.
    // Y solo los estados que le son visibles: `pendiente` NUNCA.
    expect(sql).toContain('organismo_codigo');
    expect(sql).toContain('gestion_operaciones');
    expect(params).toContain('25473');
    expect(params).toContain('solicitado');
    expect(params).not.toContain('pendiente');
  });

  /**
   * TC-12053-24 — paridad pantalla ↔ archivo con la lista COMPLETA.
   *
   * El de arriba pasaría igual con un `eq(organismo_codigo, ctx.organismos[0])`: con un organismo,
   * «el primero» y «todos» son el mismo SQL. Este exige los DOS códigos en los parámetros, que es
   * lo único que distingue el `inArray` del atajo — y el atajo le entregaría al gestor un archivo
   * más corto que la pantalla, sin error y sin que nadie lo note.
   */
  it('TC-12053-24: el .xlsx del gestor con DOS organismos arrastra los DOS al WHERE', async () => {
    kdb.when.scenario({
      flito_gestor_organismos: [{ codigo: '25473' }, { codigo: '05001' }],
      flito_impuestos: filas(1), flito_compradores: [],
    });

    expect((await exportar(await sesion('gestor_impuestos'))).status).toBe(200);

    const { sql, params } = whereDelExport();
    expect(sql).toContain('organismo_codigo');
    expect(params).toContain('25473');
    expect(params).toContain('05001');
    // Y sigue sin poder descargar lo asumido por Operaciones ni los `pendiente`.
    expect(sql).toContain('gestion_operaciones');
    expect(params).not.toContain('pendiente');
  });

  it('un gestor SIN NINGÚN organismo descarga un archivo VACÍO, no la tabla entera', async () => {
    // `condicionesColaImpuestos` devuelve `null` cuando no hay frontera que aplicar. El defecto que
    // esto mata es tratar ese `null` como «sin filtros»: la fixture tiene filas y no pueden salir.
    kdb.when.scenario({
      flito_gestor_organismos: [],
      flito_impuestos: filas(2), flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion('gestor_impuestos'));
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(hoja.rowCount).toBe(1); // solo el encabezado
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });
});

// ─────────────────────────── AC7 · celdas vacías y una fila por impuesto ─────────────────────────

describe('AC7 — el dato que falta deja la celda VACÍA, y la fila sale igual', () => {
  it('sin correo, sin cilindraje y sin municipio: tres celdas vacías y el resto con su valor', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ cilindraje: null, municipio: null })],
      flito_compradores: [comprador({ correo: null })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'Correo') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Cilindraje') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Municipio') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(celda(hoja, 2, 'Celular')).toBe('3109876543');
    expect(celda(hoja, 2, 'OrganismoDetto')).toBe('STRIA TTEyTTO MOSQUERA');
    // El municipio ausente no arrastra a la ciudad del organismo: son datos distintos.
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);

    const texto = textoDe(hoja);
    expect(texto).not.toContain('—');
    expect(texto).not.toContain('null');
    expect(texto).not.toContain('undefined');
  });

  it('un impuesto SIN comprador registrado SALE igual, con placa, VIN y organismo', async () => {
    // Mata el `INNER JOIN` sobre `flito_compradores`, que borraría del archivo —en silencio— cada
    // impuesto al que le falte el propietario.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2);
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'Vin')).toBe(VIN);
    expect(celda(hoja, 2, 'OrganismoDetto')).toBe('STRIA TTEyTTO MOSQUERA');
    expect(celda(hoja, 2, 'NumeroId') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Direccion') ?? null).toBeNull();
    // El bloque del titular NO depende del comprador: sale del payload del trámite y sigue lleno.
    expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
  });

  it('DOS compradores del mismo trámite producen UNA sola fila, la del orden menor', async () => {
    // Mata el JOIN que duplica: 500 impuestos entregando 800 filas pasan todos los asertos de
    // columnas sin despeinarse, y además falsearían el conteo contra el tope.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_compradores: [
        comprador({ id: 'c9', orden: 1, numeroDocumento: '9999999999' }),
        comprador({ id: 'c1', orden: 0 }),
      ],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(textoDe(hoja)).not.toContain('9999999999');
  });

  it('con el `orden` EMPATADO, el principal se decide por `id` y no por el azar de la consulta', async () => {
    // `orden` es `notNull().default(0)` y NO es único por trámite: sin el desempate, dos exports del
    // mismo filtro podrían traer documentos distintos en la misma fila.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_compradores: [
        comprador({ id: 'c-zzz', orden: 0, numeroDocumento: '8888888888' }),
        comprador({ id: 'c-aaa', orden: 0, numeroDocumento: CEDULA }),
      ],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });

  it('el organismo CRUDO de FLIT ausente deja la celda vacía — no cae al alias ni al código', async () => {
    // `OrganismoDetto` es `flito_tramites.transito_nombre_flit`, el nombre tal como lo manda FLIT, y
    // no el alias configurado en FLITO ni el código: la plantilla del cliente pide el crudo. La
    // tentación es rellenar el hueco con `organismoParaExport()`, que es lo que hacía la hoja de
    // once columnas — pondría en la celda un valor de otra procedencia con aspecto de ser el mismo.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ organismoDetto: null })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'OrganismoDetto') ?? null).toBeNull();
    expect(textoDe(hoja)).not.toContain(ORGANISMO);
    // Y la ciudad del catálogo sí sale: son dos columnas con dos orígenes distintos.
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);
  });
});

// ─────────────────────────── Rastro PII ──────────────────────────────────────────────────────────

describe('rastro — Ley 1581 art. 17 (el módulo no registraba NADA hasta esta HU)', () => {
  it('una sola línea, `accion: export`, con las filas REALES y antes del primer byte', async () => {
    kdb.when.scenario({ flito_impuestos: filas(2), flito_compradores: [] });

    expect((await exportar(await sesion())).status).toBe(200);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('export');
    expect(acceso.resourceTipo).toBe('flito_impuesto');
    expect(String(acceso.motivo)).toContain('filas=2');
    // Invertir las dos líneas de la ruta no cambia ninguna respuesta: solo este aserto lo ve.
    expect(orden).toEqual(['pii', 'excel']);
  });

  it('**`campos_accedidos` declara el NOMBRE del titular**, además del documento y el contacto', async () => {
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    await exportar(await sesion());
    const campos = ultimoAcceso().camposAccedidos as string[];

    expect(campos).toContain('correo');
    expect(campos).toContain('celular');
    expect(campos).toContain('direccion');
    expect(campos).toContain('ciudad');
    expect(campos).toContain('numero_documento');

    // **Aquí es donde la HU #11934 invierte el aserto.** La hoja de once columnas llevaba el
    // documento del titular y NO su nombre, así que declararlo habría sido declarar de más. La de
    // veinticinco lo publica en `NombrePila`/`Apellidos`/`RazonSocial`: mantener la exclusión haría
    // que el registro mintiera por omisión justo en el dato que la HU añade. Que el nombre venga de
    // `flit_raw` y no de `flito_compradores.nombre_completo` no cambia nada — esto declara QUÉ dato
    // personal salió del perímetro, no de qué columna se leyó.
    expect(campos).toContain('nombre_completo');

    // **Y la HU #11947 invierte el segundo.** `tipo_documento` estaba excluido porque `ClaseId` se
    // DEDUCÍA de si había apellido; desde esta HU es un tipo afirmado por el origen —`CC`, `NIT`,
    // `PP`, `CE`— y sale también en el DTO de la cola. `CE` en un archivo que cruza el perímetro dice
    // que el titular es extranjero: es un dato del titular, no un formato.
    expect(campos).toContain('tipo_documento');
    // Y sigue siendo la lista del ARCHIVO, no la de la tabla: lo que no se publica, no se declara.
    expect(campos).not.toContain('valor_liquidado');
    expect(campos).not.toContain('motivo_rechazo');
  });

  it('el 422 deja `accion: search`, `filas=0` y el marcador del código', async () => {
    kdb.when.scenario({ flito_impuestos: filas(TOPE + 1), flito_compradores: [] });

    expect((await exportar(await sesion())).status).toBe(422);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('search');
    expect(String(acceso.motivo)).toContain('resultado=export_demasiado_grande');
    expect(String(acceso.motivo)).toContain('filas=0');
  });

  it('**el `GET /` de la cola también registra**, con los campos que ESA ruta entrega', async () => {
    // La deuda que esta HU destapa: el módulo entero tenía 0 llamadas a `logPiiAccess` mientras la
    // cola devolvía nombre y cédula del propietario en cada fila. Registrar solo el export habría
    // dejado la lectura interactiva —la que más se usa— sin rastro.
    kdb.when.scenario({
      flito_impuestos: [filaCola()],
      flito_compradores: [comprador()],
      flito_impuesto_certificaciones: [],
    });

    const r = await request(await buildApp()).get(BASE).set('Authorization', await sesion());
    expect(r.status).toBe(200);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('search');
    expect(acceso.resourceTipo).toBe('flito_impuesto');
    // La cola SÍ devuelve el nombre (`compradorNombre`), así que aquí sí se declara: cada acción
    // declara lo suyo.
    expect(acceso.camposAccedidos as string[]).toContain('nombre_completo');
    expect(acceso.camposAccedidos as string[]).not.toContain('direccion');
  });
});

// ─────────────────────────── Nombre del archivo y forma del endpoint ─────────────────────────────

describe('el nombre del archivo no lleva datos de nadie', () => {
  it('`attachment; filename="impuestos_YYYYMMDD-HHmm.xlsx"`, `no-store`, y sin placa ni cédula ni VIN', async () => {
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const r = await exportar(await sesion());

    const disposition = String(r.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="impuestos_\d{8}-\d{4}\.xlsx"$/);
    for (const dato of [PLACA, CEDULA, VIN]) expect(disposition).not.toContain(dato);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['content-type'])
      .toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('el router NO declara ninguna variante GET del export', () => {
    const fuente = fuenteDelRouter();
    expect(fuente).not.toMatch(/router\.get\(\s*'[^']*export/);
    expect(fuente).toMatch(/router\.post\(\s*'\/export'/);
  });

  it('el router NO declara un limitador propio: usa el COMPARTIDO de las dos colas', () => {
    // Este router llegó a documentar la decisión CONTRARIA («separada también de la del export de
    // SOAT»), que es lo que tumbó el gate de seguridad. Se afirma sobre la fuente porque la vuelta
    // atrás más probable es copiar el bloque `rateLimit({…})` de vuelta aquí: sin Redis, dos
    // `rateLimit()` con la misma llave llevan contadores distintos, así que el código se leería
    // idéntico y el freno valdría el doble.
    const fuente = fuenteDelRouter();
    expect(fuente).toContain('exportColaLimiter');
    expect(fuente).not.toContain('rateLimit(');
    expect(fuente).not.toContain('flito-impuestos-export');
  });
});

// ─────────────────────────── La cuota es UNA para las dos colas ──────────────────────────────────

describe('cuota del export — una sola bolsa para SOAT e Impuestos', () => {
  it('**agotar los 5 exports en IMPUESTOS devuelve 429 en el de SOAT**, con el mismo usuario', async () => {
    // El sentido inverso del caso gemelo de `flito-soat-export.test.ts`, y se escribe aquí en vez de
    // dejarlo en un solo sitio porque el freno tiene DOS puertas: un limitador colgado solo del
    // router de SOAT frenaría en una dirección y no en la otra, y ese medio arreglo pasaría con un
    // único test. Lo que se defiende es el heap de UN proceso —`sendExcel` lo llena entero— y el
    // techo de extracción de PII (cuota × tope), y las dos colas lo comparten.
    const cabecera = await sesion();
    kdb.when.scenario({
      flito_impuestos: [], flito_compradores: [], flito_soat: [], flito_tramites: [],
    });
    const app = await buildAppAmbas();

    for (let i = 1; i <= 5; i += 1) {
      const r = await request(app).post(RUTA)
        .set('Authorization', cabecera).responseType('blob').send({});
      expect(r.status, `el export ${i} de Impuestos tenía que caber en la cuota`).toBe(200);
    }

    const sexto = await request(app).post('/api/flito/soat/export')
      .set('Authorization', cabecera).responseType('blob').send({});

    expect(sexto.status).toBe(429);
  });
});
