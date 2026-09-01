// FLITO SOAT — export a Excel de la cola filtrada (Feature #11908, HU #11909, HU #11934).
//
// `POST /api/flito/soat/export` es la única ruta del módulo que entrega un ARCHIVO, y eso cambia qué
// puede salir mal: una respuesta binaria no se equivoca «un poco», o es un `.xlsx` abrible con los
// datos correctos o es basura que alguien abre y no entiende. Y a diferencia del de comparendos,
// este archivo lleva el NOMBRE, el documento, el CORREO y la DIRECCIÓN del titular del vehículo.
//
// Lo que se demuestra aquí, por orden de lo que costaría más caro si dejara de ser verdad:
//
//   1. **Las veinticinco columnas, en su orden, afirmadas sobre el WORKBOOK REAL.** El aserto NO se
//      hace contra la constante `COLUMNAS_COLA_EXPORT`: si se hiciera, renombrar la constante movería
//      el test y el código a la vez y el test dejaría de probar nada. Se escriben los 25 literales a
//      mano, en CamelCase — es la plantilla del CLIENTE, no una convención nuestra.
//   2. **Cada valor bajo SU cabecera, con 25 centinelas distinguibles.** ExcelJS empareja por `key`,
//      así que permutar dos `header` sin permutar sus `key` deja el archivo con las cabeceras
//      correctas y los VALORES cruzados: el caso 1 sigue verde. Este es el único que lo ve.
//   3. **`Modelo` es el AÑO y `Linea` la línea.** Lo que FLIT llama `modelo` es la línea comercial,
//      y todo el repo usa «modelo = año»: el mapeo obvio mete `ONIX` en una columna de años y pasa
//      cualquier aserto de cabeceras. (El cruce clave→campo se afirma sobre el SQL renderizado en
//      `cola-flito-derivados.test.ts`; aquí se ve el efecto en la celda.)
//   4. **El bloque del titular tiene TRES estados.** Sin `flit_raw` —el canal Cliente— las cinco
//      columnas van vacías; no `PJUR` + `NIT` con la razón social en blanco.
//   5. **«Creado» es `created_at` y no `enviado_en`** (el filtro nuevo). Las dos columnas existen y
//      el defecto probable es implementar el rango nuevo como alias del de «Solicitado», que ya está
//      en pantalla: devolvería filas, así que nadie lo notaría. Se afirma sobre el SQL real del
//      `WHERE`, serializado con `PgDialect`.
//   6. **El export y la pantalla comparten predicado**, y la lectura principal NO gana un join a
//      `flito_tramites`: un SOAT sirve a varios trámites y ese join multiplicaría las filas del
//      archivo y falsearía el conteo contra el tope.
//   7. **El 422 sale ANTES de que exista una cabecera de adjunto.** El fallo que se caza no es «no
//      responde 422», es «responde 422 con el `Content-Disposition` ya puesto»: eso produce un
//      archivo de 300 bytes con un JSON dentro que el navegador guarda igual.
//   8. **El propietario del canal Cliente sale.** `flito_compradores` cuelga de dos padres; leer solo
//      la vía del trámite dejaría las filas del canal sin documento, correo ni dirección, y el
//      `.xlsx` se abriría sin quejarse.
//   9. **Ni `auditor` ni `cliente` descargan esto** — el `cliente` es una empresa TERCERA.
//  10. **El rastro dice la verdad sobre lo que se llevó**, y va escrito antes del primer byte. Desde
//      la HU #11934 eso incluye `nombre_completo`: el archivo publica el nombre del titular.
//
// **Lo que estas suites NO pueden probar, y dónde se prueba:** `__tests__/helpers/keyed-db.ts` no
// evalúa la proyección (`resolve(reg, name)`, línea 49) — devuelve las filas que el escenario
// registró—, así que una expresión `sql\`… ->> 'clase'\`` no se ejecuta nunca aquí. El tramo «clave
// de FLIT → campo» se afirma sobre el SQL RENDERIZADO en `cola-flito-derivados.test.ts`, junto con
// las funciones puras que deciden el bloque del titular y la ciudad del organismo.
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

/**
 * Orden observado de los dos efectos que tienen que ocurrir en ESE orden: primero el rastro, después
 * el primer byte del archivo. Ninguno de los dos se ve desde la respuesta.
 */
const orden: string[] = [];

/** El rastro se espía en el contrato con `logPiiAccess`, no en la fila que acaba en la tabla. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => { orden.push('pii'); return logPiiAccessMock(...args); },
}));

/**
 * `sendExcel` se ENVUELVE, no se sustituye: el archivo que se afirma es el de verdad, generado por
 * `exceljs`. Lo único que añade el envoltorio es dejar constancia de CUÁNDO se llamó, que es la
 * mitad del aserto del rastro —va antes del primer byte— y no se puede observar desde la respuesta.
 */
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

const BASE = '/api/flito/soat';
const RUTA = `${BASE}/export`;
const TABLA = 'flito_soat';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const SOAT_A = '11111111-1111-1111-1111-111111111111';
const SOAT_CANAL = '22222222-2222-2222-2222-222222222222';
const SOAT_JUR = '55555555-5555-5555-5555-555555555555';
const TRAMITE_A = '33333333-3333-3333-3333-333333333333';
const TRAMITE_B = '44444444-4444-4444-4444-444444444444';
const TRAMITE_JUR = '66666666-6666-6666-6666-666666666666';

const PLACA = 'JNH38H';
const VIN = '9FKRG2222T2042405';
const CEDULA = '1020304050';

/**
 * Los DOS organismos de la fixture, y son distintos a propósito.
 *
 * `Municipio` sale del TRÁMITE (`flito_tramites.ciudad`, aquí Funza) y `OrganismoDettoCiudad` del
 * CATÁLOGO por el código del SOAT (aquí Palmira). Con la misma ciudad en los dos, el atajo «la
 * ciudad ya la tengo, la copio» pasaría todos los asertos.
 */
const ORGANISMO = '76520';        // STRIA TTEyTTO PALMIRA
const CIUDAD_ORGANISMO = 'Palmira';
const MUNICIPIO = 'FUNZA';

/**
 * **El nombre del titular, que desde la HU #11934 SÍ sale en el archivo.**
 *
 * Hasta la hoja de once columnas este centinela era una prohibición: la hoja llevaba la cédula y no
 * el nombre. La de veinticinco publica `NombrePila`, `Apellidos` y `RazonSocial`, así que aquí se
 * invierte a valor ESPERADO. Viene de `flit_raw`, que es donde FLIT manda `nombres` y `apellidos`
 * ya separados.
 */
const CENTINELA_NOMBRE = 'CENTINELA-NOMBRE-TITULAR';
const CENTINELA_APELLIDOS = 'CENTINELA-APELLIDOS';
const CENTINELA_RAZON = 'CENTINELA-RAZON-SOCIAL SAS';

/**
 * `flito_compradores.nombre_completo`: los dos nombres FUNDIDOS por `flit-http.adapter.ts:74`.
 *
 * Este sigue siendo una PROHIBICIÓN, y es la mitad que no se invierte: el archivo publica el nombre,
 * pero lo saca del par separado del payload y **no** partiendo esta cadena por el espacio. Si
 * alguien resolviera `NombrePila`/`Apellidos` con un `split(' ')` sobre esta columna, aparecería en
 * el buffer — y además fallaría en cada nombre compuesto y en cada razón social.
 */
const CENTINELA_CONCATENADO = 'CENTINELA CONCATENADO';
const CENTINELA_PROVEEDOR = 'CENTINELA-PROVEEDOR-SOAT';
const CENTINELA_MOTIVO = 'CENTINELA-MOTIVO-RECHAZO';

/** Fila de `flito_soat` × joins, tal como la traería la base SIN proyectar. */
const filaSoat = (over: Record<string, unknown> = {}) => ({
  id: SOAT_A,
  origen: 'tramite',
  vin: VIN,
  placa: PLACA,
  carroceria: 'CAMIONETA',
  servicio: 'Particular',
  cilindraje: '1598',
  organismoCodigo: ORGANISMO,
  // Lo que la proyección del export NO pide. El mock keyed devuelve la fila entera aunque el
  // `select` pidiera menos, así que estas tres viajan igual y sirven de centinela.
  proveedorSoatId: CENTINELA_PROVEEDOR,
  valorPagado: '350000.00',
  motivoRechazo: CENTINELA_MOTIVO,
  ...over,
});

/**
 * Fila de `flito_tramites` tal como la devuelve `tramitesDe()`: las tres columnas propias y las
 * NUEVE claves de `flit_raw` **ya extraídas**, con el nombre del CAMPO y no el de la clave de FLIT.
 *
 * Que aquí se llame `linea` y no `modelo` no es una comodidad: `keyed-db` no evalúa la proyección,
 * así que estas claves son las del `select({...})` del servicio. El cruce clave→campo —el que
 * convierte `modelo` de FLIT en `Linea` y `modeloAno` en `Modelo`— vive un escalón más abajo y se
 * afirma sobre el SQL renderizado en `cola-flito-derivados.test.ts`.
 *
 * `tipo: 'cc'` por defecto (HU #11947): es el valor que decide las CINCO columnas del titular, y se
 * pone explícito en cada escenario que quiera otra clase. `cc` es el segundo más frecuente del
 * parque medido (2 393 de 7 052) y el que produce la fila natural que el resto de casos usa.
 */
const tramite = (over: Record<string, unknown> = {}) => ({
  id: TRAMITE_A,
  soatId: SOAT_A,
  municipio: MUNICIPIO,
  organismoDetto: 'STRIA TTOyTTE MCPAL FUNZA',
  marca: 'CHEVROLET',
  linea: 'ONIX',        // `flit_raw->>'modelo'` — la LÍNEA
  modelo: '2021',       // `flit_raw->>'modeloAno'` — el AÑO
  clase: 'AUTOMOVIL',
  capacidad: '5',
  departamento: 'CUNDINAMARCA',
  nombres: CENTINELA_NOMBRE,
  apellidos: CENTINELA_APELLIDOS,
  tipo: 'cc',           // `flit_raw->>'tipo'` — QUÉ es el titular
  ...over,
});

const comprador = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tramiteId: TRAMITE_A, soatId: null,
  numeroDocumento: CEDULA,
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  orden: 0,
  nombreCompleto: CENTINELA_CONCATENADO,
  ...over,
});

/** N filas de SOAT distinguibles por id y placa. */
const filas = (n: number) => Array.from({ length: n }, (_, i) => filaSoat({
  id: `${i}1111111-1111-1111-1111-11111111111${i}`,
  placa: `AAA00${i}`,
}));

// ── App y sesiones ───────────────────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use(BASE, router);
  return app;
}

/**
 * Los DOS routers en la misma app.
 *
 * Es la única forma de observar que la cuota del export es UNA para las dos colas: con una app por
 * módulo, dos bolsas y una bolsa se ven exactamente igual en verde.
 */
async function buildAppAmbas() {
  const app = express();
  app.use(express.json());
  const { default: soat } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  const { default: impuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use(BASE, soat);
  app.use('/api/flito/impuestos', impuestos);
  return app;
}

/**
 * Una sesión con `sub` nuevo cada vez.
 *
 * El limitador del export cuenta 5 por minuto y usuario, y su ventana no se reinicia entre tests:
 * con un `sub` compartido, el tercer caso del archivo empezaría a ver 429 que no tienen nada que ver
 * con lo que se prueba.
 */
let siguienteSub = 9100;
const sesion = async (role: TestRole = 'admin'): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const exportar = async (cabecera: string, cuerpo: unknown = {}) =>
  request(await buildApp())
    .post(RUTA)
    .set('Authorization', cabecera)
    .responseType('blob')
    .send(cuerpo as object);

// ── Espías de la consulta ────────────────────────────────────────────────────────────────────────

/**
 * Proyección, `limit`, `offset` y `WHERE` de cada SELECT, por tabla.
 *
 * El `where` se guarda en crudo y se serializa con `PgDialect` al afirmarlo: es la única forma de
 * ver QUÉ columnas y qué operadores entraron en la consulta. El mock ignora el filtro y devuelve lo
 * que el test registró, así que sin esto un export que se dejara filtros por el camino devolvería
 * las mismas filas y ningún aserto se enteraría.
 */
const consultas: {
  tabla: string;
  columnas: string[];
  /**
   * El objeto de proyección TAL CUAL, no solo sus claves.
   *
   * Hace falta porque `keyed-db` devuelve las filas del escenario sin mirar la proyección: con una
   * fixture que trae `organismoCodigo`, el archivo sale igual venga esa clave de la columna
   * normalizada o de `flit_raw->>'codigoSecretaria'` —que llega SIN el cero de relleno en 3 650 de
   * 7 052 filas y dejaría la ciudad vacía en la mitad del parque—. Guardando el objeto se puede
   * mirar de QUÉ está hecho cada campo: una columna de drizzle o una expresión `sql`.
   */
  proyeccion: Record<string, unknown>;
  /** Las tablas UNIDAS a esta lectura, por el orden en que se declararon. */
  joins: string[];
  limit: number | null;
  offset: number | null;
  where: unknown;
}[] = [];

/**
 * De qué está hecho un campo de la proyección: `col:<tabla>.<columna>` o `sql:<SQL renderizado>`.
 *
 * Es lo que convierte «la celda trae el valor correcto» —que la fixture regala— en «el valor sale de
 * la columna correcta», que es lo que de verdad decide si el archivo dice la verdad en producción.
 */
function origenDe(valor: unknown): string {
  const col = valor as { name?: unknown; table?: unknown };
  if (col && typeof col.name === 'string' && col.table) return `col:${nombre(col.table)}.${col.name}`;
  // Los PARÁMETROS entran en la cadena, y no es un adorno: `sql\`… ->> ${'x'}\`` deja la clave en
  // `params` y fuera del texto del SQL, así que un aserto que solo mirara `q.sql` no vería la clave
  // que la expresión extrae — que es justo lo que hay que poder leer.
  const q = new PgDialect().sqlToQuery(valor as never);
  return `sql:${q.sql}|${(q.params as unknown[]).map(String).join(',')}`;
}

/** Los cuatro tipos de join, para poder afirmar que una tabla NO entra en una lectura. */
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
    // Los joins se anotan porque hay un hecho de esta HU que NO se ve de otra forma: que la lectura
    // principal del export siga SIN unir `flito_tramites`. Añadir ese join haría que el archivo
    // trajera una fila por trámite —más filas de las que hay, con las columnas correctas— y
    // falsearía además el conteo contra el tope.
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

/** El `WHERE` de la lectura principal del export, ya en SQL y con sus parámetros. */
function whereDelExport(): { sql: string; params: unknown[] } {
  const lecturas = lecturasDe(TABLA);
  expect(lecturas.length, 'el export lee `flito_soat` exactamente una vez').toBe(1);
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
 * Las VEINTICINCO cabeceras ESCRITAS A MANO, en CamelCase literal.
 *
 * No se importan de `COLUMNAS_COLA_EXPORT` a propósito: comparar el archivo contra la constante que
 * lo generó es una tautología —cambiar la constante movería las dos cosas a la vez—. Estos 25
 * literales son el contrato con el CLIENTE, y romperlos tiene que costar editar este archivo.
 *
 * Van tal cual, sin «normalizar»: `N_I` con guion bajo, `CapacidadCargaOPasajeros` y
 * `OrganismoDettoCiudad` sin separador. La regla de «MAYÚSCULAS y sin tildes» era de las once
 * columnas de la HU #11909 y NO aplica a esta hoja — quien la aplique rompe la carga en el sistema
 * del cliente, que empareja por el texto exacto.
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
 * El valor de una celda por el TEXTO de su cabecera, leído del ARCHIVO y no de la lista de arriba.
 *
 * El índice se busca en las cabeceras REALES del workbook (no en `CABECERAS`) a propósito: así este
 * ayudante sigue diciendo la verdad aunque el orden del archivo se mueva, y es el caso de los 25
 * centinelas —«cada valor bajo su cabecera»— el que decide si el emparejamiento `header`/`key` está
 * bien. Con el índice sacado de la lista escrita a mano, una permutación de `header` sin permutar
 * `key` se leería «corregida» por el propio test.
 */
function celda(hoja: ExcelJS.Worksheet, nFila: number, cabecera: string): unknown {
  const indice = cabecerasDe(hoja).indexOf(cabecera);
  expect(indice, `la cabecera «${cabecera}» no está en el archivo`).toBeGreaterThanOrEqual(0);
  return hoja.getRow(nFila).getCell(indice + 1).value;
}

/** Todo el texto del workbook, para buscar lo que NO puede estar. */
function textoDe(hoja: ExcelJS.Worksheet): string {
  const partes: string[] = [];
  hoja.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (c) => partes.push(String(c.value ?? '')));
  });
  return partes.join('|');
}

const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

/** El código del router, leído de disco: hay hechos que no se observan desde una petición. */
function fuenteDelRouter(): string {
  return readFileSync(
    fileURLToPath(new URL('../../src/modules/flito-soat/flito-soat.routes.ts', import.meta.url)),
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
    kdb.when.scenario({
      flito_soat: filas(2),
      flito_tramites: [tramite()],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);
    const hoja = await libro(r.body as Buffer);

    expect(cabecerasDe(hoja)).toEqual(CABECERAS);
    // El conteo se afirma aparte del `toEqual`: una columna de más CON su cabecera pasaría el
    // `toEqual` si alguien la insertara al final y actualizara la lista de arriba a la vez; el
    // número es lo que obliga a mirar el contrato.
    expect(hoja.columnCount).toBe(25);
  });

  it('NO hay columna de fecha de creación, ni de valor pagado, ni de proveedor', async () => {
    kdb.when.scenario({
      flito_soat: filas(1), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const cabeceras = cabecerasDe(hoja);

    // Las tres tentaciones que quedan vivas después de la HU #11934, que son las de la OPERACIÓN de
    // FLITO: una fecha porque el filtro nuevo es por creación, el importe porque está en la fila, el
    // proveedor porque está en la pantalla. El archivo describe el vehículo y a su titular; ninguna
    // de las tres es del cliente que lo carga. (`Municipio` y el nombre del titular SÍ existen ahora
    // —esta HU los añadió a propósito—, así que ya no son parte de esta prohibición.)
    expect(cabeceras.filter((h) => /Cread|Fecha/i.test(h))).toEqual([]);
    expect(cabeceras.filter((h) => /Valor|Pagad/i.test(h))).toEqual([]);
    expect(cabeceras.filter((h) => /Proveedor/i.test(h))).toEqual([]);
  });

  it('el encabezado va con el estilo del resto de exports del repo', async () => {
    kdb.when.scenario({ flito_soat: filas(1), flito_tramites: [], flito_compradores: [] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const encabezado = hoja.getRow(1);

    expect(encabezado.font?.bold).toBe(true);
    expect((encabezado.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FF1F2937');
  });
});

// ─────────────────────────── Cada valor bajo SU cabecera ─────────────────────────────────────────

describe('cada valor cae bajo la cabecera que le toca — 25 centinelas distinguibles', () => {
  /**
   * Dos filas porque el bloque del titular tiene formas EXCLUYENTES: una natural (con `NombrePila`
   * y `Apellidos`, sin `RazonSocial`) y una jurídica (al revés). Con una sola fila, tres de las 25
   * columnas no tendrían nunca un centinela que comprobar.
   */
  const escenarioDeDosFormas = () => kdb.when.scenario({
    flito_soat: [filaSoat(), filaSoat({ id: SOAT_JUR, placa: 'ZZZ999', vin: 'VINJURIDICA00001' })],
    flito_tramites: [
      tramite(),
      tramite({
        id: TRAMITE_JUR, soatId: SOAT_JUR,
        // Lo que la hace jurídica es el `tipo`, no la falta de apellido (HU #11947).
        tipo: 'n',
        nombres: CENTINELA_RAZON,
        // El apellido «solo espacios» es la forma REAL en la que llega la ausencia (3 510 de 7 052
        // filas medidas): ni vacío ni nulo.
        apellidos: ' ',
      }),
    ],
    flito_compradores: [comprador(), comprador({ id: 'c2', tramiteId: TRAMITE_JUR, numeroDocumento: '9001234561' })],
  });

  it('**las 25 celdas de la fila natural, una por una**', async () => {
    // El mutante que SOLO este caso mata: permutar dos `header` de `COLUMNAS_COLA_EXPORT` sin
    // permutar sus `key`. ExcelJS escribe cada fila buscando `fila[col.key]`, así que el archivo
    // saldría con las cabeceras en el orden nuevo y los VALORES en el viejo: el aserto de cabeceras
    // de arriba sigue verde y el `.xlsx` se abre sin quejarse.
    escenarioDeDosFormas();

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const c = (cabecera: string) => celda(hoja, 2, cabecera) ?? null;

    expect(c('Vin')).toBe(VIN);
    expect(c('Placa')).toBe(PLACA);
    // `Modelo` es el AÑO. El mapeo obvio `Modelo ← modelo` metería `ONIX` aquí.
    expect(c('Modelo')).toBe('2021');
    expect(c('Servicio')).toBe('Particular');
    expect(c('Marca')).toBe('CHEVROLET');
    // `Linea` es la LÍNEA comercial, que FLIT manda bajo la clave `modelo`.
    expect(c('Linea')).toBe('ONIX');
    expect(c('Clase')).toBe('AUTOMOVIL');
    expect(c('Carroceria')).toBe('CAMIONETA');
    expect(c('Cilindraje')).toBe('1598');
    expect(c('CapacidadCargaOPasajeros')).toBe('5');
    expect(c('Puertas')).toBe('4');
    expect(c('OrganismoDetto')).toBe('STRIA TTOyTTE MCPAL FUNZA');
    expect(c('N_I')).toBe('IMPORTADO');
    expect(c('ClaseDeInterlocutor')).toBe('PNAT');
    expect(c('NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(c('Apellidos')).toBe(CENTINELA_APELLIDOS);
    // Excluyente con las dos de arriba: una fila natural con razón social diría dos cosas a la vez.
    expect(c('RazonSocial')).toBeNull();
    expect(c('ClaseId')).toBe('CC');
    expect(c('NumeroId')).toBe(CEDULA);
    expect(c('Direccion')).toBe('CALLE 1 # 2-3');
    expect(c('Municipio')).toBe(MUNICIPIO);
    expect(c('Departamento')).toBe('CUNDINAMARCA');
    expect(c('Celular')).toBe('3001234567');
    expect(c('Correo')).toBe('juana@empresa.co');
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
    // Y el resto de la fila sigue completo: la clasificación no vacía lo demás.
    expect(c('NumeroId')).toBe('9001234561');
    expect(c('Placa')).toBe('ZZZ999');
  });

  it('**`Municipio` y `OrganismoDettoCiudad` son datos DISTINTOS**', async () => {
    // El atajo que esto mata es «la ciudad ya la tengo»: copiar `flito_tramites.ciudad` en las dos
    // columnas. Con una fixture donde el trámite y el organismo coincidieran, ese atajo pasaría
    // todos los asertos. Aquí el trámite es de Funza y el organismo, de Palmira.
    escenarioDeDosFormas();

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'Municipio')).toBe('FUNZA');
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe('Palmira');
    expect(celda(hoja, 2, 'Municipio')).not.toBe(celda(hoja, 2, 'OrganismoDettoCiudad'));
  });

  it('un organismo FUERA del catálogo deja la ciudad vacía, no un 500', async () => {
    // Un organismo nuevo en la base llega antes que su entrada en el catálogo compilado de
    // `shared-types`. Un export de 2 000 filas no puede caerse entero por una fila así.
    kdb.when.scenario({
      flito_soat: [filaSoat({ organismoCodigo: '99999' })],
      flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(celda(hoja, 2, 'OrganismoDettoCiudad') ?? null).toBeNull();
    // Y la fila sale igual, con todo lo demás.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
  });

  it('**`modeloAno` como NÚMERO del jsonb no tumba el export**', async () => {
    // `flit_raw` es `jsonb` de un tercero y el tipo `string | null` de la expresión es una promesa
    // de TypeScript que nadie comprueba en ejecución. Un `.trim()` sobre ese número sería un
    // TypeError dentro del `map` de las filas: **500 para el archivo entero por UNA fila**, y las
    // otras 1 999 legítimas se perderían con ella.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ modelo: 2021, capacidad: 5 })],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(String(celda(hoja, 2, 'Modelo'))).toBe('2021');
    expect(String(celda(hoja, 2, 'CapacidadCargaOPasajeros'))).toBe('5');
  });

  it('**una clave ANIDADA no se publica**: celda vacía y la fila sin clasificar', async () => {
    // Corrección del gate de seguridad (Medium sobre `dcd57ea`). `->>` no falla ante un objeto: lo
    // SERIALIZA —medido en Postgres 16, `'{"n":{"a":1,"b":"ANA"}}'::jsonb ->> 'n'` devuelve
    // `{"a": 1, "b": "ANA"}` como `text`—, así que el día que FLIT anide algo bajo una de las nueve
    // claves el blob acabaría en una celda de un archivo que sale del perímetro, con datos dentro que
    // `pii_access_log` no declara.
    //
    // En SOAT hay un escalón más que en Impuestos: los tres campos del titular pasan por
    // `claveTitular` —que los reconcilia como TRIPLA `[tipo, nombres, apellidos]` (HU #11947)— antes
    // de que `comun()` los compare. El descarte tiene que ocurrir ANTES de que el valor se convierta
    // en clave de reconciliación, y eso vale para los tres: si no, dos trámites con el mismo blob
    // «coincidirían» y lo publicarían.
    //
    // La fixture usa la CADENA que Postgres produce, no un objeto JS: es lo que de verdad llega al
    // servicio. Este caso muerde la guarda de JS; la del SQL, que es la de verdad, se afirma sobre el
    // SQL renderizado en `cola-flito-derivados.test.ts`.
    const CEDULA_ANIDADA = '99887766554';
    const BLOB = `{"primer": "ANA", "segundo": "MARIA", "cedula": "${CEDULA_ANIDADA}"}`;
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [
        tramite({ tipo: 'n', nombres: BLOB, apellidos: ' ', marca: '["CHEVROLET", "SA"]' }),
        tramite({ id: TRAMITE_B, tipo: 'n', nombres: BLOB, apellidos: ' ', marca: '["CHEVROLET", "SA"]' }),
      ],
      flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);
    const hoja = await libro(r.body as Buffer);

    expect(hoja.rowCount).toBe(2); // una fila, y sale
    const texto = textoDe(hoja);
    expect(texto).not.toContain('primer');
    expect(texto).not.toContain('segundo');
    expect(texto).not.toContain(CEDULA_ANIDADA);
    expect(celda(hoja, 2, 'Marca') ?? null).toBeNull();

    // Las TRES columnas de nombre, vacías: el blob no se publica por ninguna vía.
    for (const c of ['NombrePila', 'Apellidos', 'RazonSocial']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía`).toBeNull();
    }
    // Y la clase SÍ sale, porque la afirma el `tipo` —que es escalar y llegó bien— y no el nombre
    // (HU #11947). Son dos decisiones independientes: descartar el blob no descalifica al titular, y
    // clasificar al titular no rescata el blob.
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });

  it('**un `tipo` ANIDADO no clasifica**: las cinco del titular vacías', async () => {
    // La otra mitad del mismo descarte, y la que importa desde la HU #11947: si `tipo` llegara como
    // objeto, `->>` lo serializaría a `{"documento": "cc"}` y ese texto entraría al lookup como
    // cualquier otro token. Hoy caería en la rama por defecto de todos modos, pero la garantía que
    // hace falta es que un valor NO ESCALAR no pueda clasificar nada — no que hoy no coincida por
    // casualidad. La fixture usa la CADENA que Postgres produce.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ tipo: '{"documento": "cc"}' })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía`).toBeNull();
    }
    // El nombre del titular tampoco se publica: sin clase no hay bloque.
    expect(textoDe(hoja)).not.toContain(CENTINELA_NOMBRE);
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
  });

  it('**`Clase` está mapeada aunque FLIT no la mande hoy**', async () => {
    // Es lo que sostiene la decisión de leer de `flit_raw` en vez de hacer crecer el sync: el día que
    // FLIT empiece a mandar la clase, la columna se llena sola, sin migración y sin despliegue.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ clase: 'CAMPERO' })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'Clase')).toBe('CAMPERO');

    // Y sin ella, la celda va vacía y la fila sale igual (que es el estado de HOY).
    kdb.reset(); instalarEspias(); consultas.length = 0;
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ clase: undefined })],
      flito_compradores: [comprador()],
    });
    const sinClase = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(sinClase, 2, 'Clase') ?? null).toBeNull();
    expect(celda(sinClase, 2, 'Marca')).toBe('CHEVROLET');
  });
});

// ─────────────────────────── El titular lo decide el `tipo` (HU #11947) ─────────────────────────

describe('el bloque del titular sale del `tipo` que afirma FLIT, no del apellido', () => {
  const CINCO = ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId'] as const;

  /** Un export de una sola fila con el `tipo` (y lo que haga falta) puesto. */
  const conTipo = async (over: Record<string, unknown>) => {
    kdb.reset(); instalarEspias(); consultas.length = 0;
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite(over)],
      flito_compradores: [comprador()],
    });
    return libro((await exportar(await sesion())).body as Buffer);
  };

  it('**`n` CON apellido → `PJUR` + `NIT`**: es el caso que la regla vieja resolvía al revés', async () => {
    // Hay que leerlo con cuidado, porque es el aserto que de verdad separa esta HU de la #11934: con
    // el apellido VACÍO, la regla vieja también decía `PJUR`/`NIT` y un caso escrito así pasaría sin
    // el cambio. Con el apellido LLENO decía `PNAT`/`CC` y metía una empresa en la columna de las
    // personas.
    const hoja = await conTipo({ tipo: 'n', nombres: CENTINELA_RAZON, apellidos: CENTINELA_APELLIDOS });

    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'RazonSocial')).toBe(CENTINELA_RAZON);
    expect(celda(hoja, 2, 'NombrePila') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Apellidos') ?? null).toBeNull();
    // El apellido que SÍ venía no se publica en ninguna celda: una jurídica no tiene apellido.
    expect(textoDe(hoja)).not.toContain(CENTINELA_APELLIDOS);
  });

  it('**`cc` con el apellido en BLANCO sigue siendo `PNAT` + `CC`** — la regresión de la #11934', async () => {
    // Medido: `apellidos` llega como «solo espacios» en 3 510 de 7 052 filas. Con la heurística
    // vieja esas filas salían `PJUR` + `NIT` con el NOMBRE DE UNA PERSONA en `RazonSocial`, el
    // archivo se abría y ningún aserto de cabeceras se enteraba.
    for (const blanco of [' ', '  ', '\t', null]) {
      const hoja = await conTipo({ tipo: 'cc', nombres: CENTINELA_NOMBRE, apellidos: blanco });
      expect(celda(hoja, 2, 'ClaseDeInterlocutor'), `«${JSON.stringify(blanco)}»`).toBe('PNAT');
      expect(celda(hoja, 2, 'ClaseId')).toBe('CC');
      expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
      expect(celda(hoja, 2, 'Apellidos') ?? null).toBeNull();
      expect(celda(hoja, 2, 'RazonSocial') ?? null).toBeNull();
    }
  });

  it('`ps` → `PP` y `ce` → `CE`, con la clase y el documento comprobados JUNTOS', async () => {
    // Por PAR y no columna a columna: un `PP` colgado de un `PJUR` sería un registro que dice dos
    // cosas a la vez, y un aserto que solo mirase el documento no lo vería. `PP` y NUNCA `PAS`: el
    // catálogo del RUNT es otro vocabulario y el AC8 lo deja intacto.
    const pasaporte = await conTipo({ tipo: 'ps' });
    expect(celda(pasaporte, 2, 'ClaseId')).toBe('PP');
    expect(celda(pasaporte, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
    expect(textoDe(pasaporte)).not.toContain('PAS');

    const extranjeria = await conTipo({ tipo: 'ce' });
    expect(celda(extranjeria, 2, 'ClaseId')).toBe('CE');
    expect(celda(extranjeria, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
  });

  it('**`otro` → `PNAT` CON el nombre y el `ClaseId` VACÍO**, que NO es el bloque vacío del AC5', async () => {
    // Un caso que solo mirase `ClaseId` daría verde igual con AC5 —los dos lo tienen vacío— y no
    // distinguiría nada. Lo que los separa son las otras cuatro columnas.
    const hoja = await conTipo({ tipo: 'otro' });

    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
    expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(celda(hoja, 2, 'Apellidos')).toBe(CENTINELA_APELLIDOS);
    expect(celda(hoja, 2, 'RazonSocial') ?? null).toBeNull();
    expect(celda(hoja, 2, 'ClaseId') ?? null).toBeNull();
  });

  it('**`c`, `""`, `"xx"` y la clave AUSENTE dejan las CINCO vacías** (AC5)', async () => {
    // La rama por defecto, y con ella el primer mutante nombrado de la HU: devolver `{PNAT, CC}` en
    // vez de vacío marcaría con cédula cada fila sin payload —incluido el canal Cliente entero— en
    // un archivo que sale del perímetro.
    //
    // `c` está en la lista a propósito (decisión de David, 2026-09-01): la tabla acepta `cc` y NO
    // `c`, que no aparece ni una vez en las 7 052 filas medidas.
    for (const tipo of ['c', '', ' ', 'xx', 'CC1', null, undefined]) {
      const hoja = await conTipo({ tipo });
      for (const c of CINCO) {
        expect(celda(hoja, 2, c) ?? null, `«${JSON.stringify(tipo)}» → ${c}`).toBeNull();
      }
      // El nombre del titular tampoco sale: sin clase, no hay bloque que publicar.
      const texto = textoDe(hoja);
      expect(texto).not.toContain(CENTINELA_NOMBRE);
      expect(texto).not.toContain('PJUR');
      // Y la fila SALE igual, con las columnas que no dependen del titular.
      expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
      expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    }
  });

  it('**`tipo` explícito y SIN nombre: `PJUR` + `NIT` con la razón social VACÍA** (las 7 filas)', async () => {
    // Decisión de David (2026-09-01), AC1 literal. Son 7 filas de 7 052 con `tipo` y sin nombres ni
    // apellidos (1 `n`, 6 `cc`). La guarda de la #11934 —«sin ninguno de los dos, bloque vacío»—
    // ya no está: aquí la clase la AFIRMA el origen y lo que falta es solo el nombre. Es lo contrario
    // del defecto que la #11934 corrigió, donde la clase se DEDUCÍA de que no hubiera payload.
    const juridica = await conTipo({ tipo: 'n', nombres: ' ', apellidos: ' ' });
    expect(celda(juridica, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(juridica, 2, 'ClaseId')).toBe('NIT');
    expect(celda(juridica, 2, 'RazonSocial') ?? null).toBeNull();

    const natural = await conTipo({ tipo: 'cc', nombres: null, apellidos: null });
    expect(celda(natural, 2, 'ClaseDeInterlocutor')).toBe('PNAT');
    expect(celda(natural, 2, 'ClaseId')).toBe('CC');
    expect(celda(natural, 2, 'NombrePila') ?? null).toBeNull();
  });
});

// ─────────────────────────── Una sola definición de columnas ─────────────────────────────────────

describe('los DOS archivos salen de la MISMA lista de columnas', () => {
  const CENTINELA_COLUMNA = 'CentinelaColumnaCompartida';

  it('una columna inyectada en la lista compartida aparece en SOAT y en Impuestos, en la misma posición', async () => {
    // Un `toEqual` entre las cabeceras de los dos archivos pasa igual de bien con UNA lista que con
    // dos copias recién hechas —que es justo el estado del que se parte cuando alguien duplica—.
    // Inyectar una columna en la constante compartida y exigir que los dos archivos la traigan es lo
    // único que distingue las dos situaciones EN EJECUCIÓN.
    const { COLUMNAS_COLA_EXPORT } = await import('../../src/shared/export/cola-flito-excel.js');
    const original = [...COLUMNAS_COLA_EXPORT];

    const cabecera = await sesion();
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
      flito_impuestos: [],
    });
    const app = await buildAppAmbas();

    try {
      COLUMNAS_COLA_EXPORT.push({ header: CENTINELA_COLUMNA, key: 'centinela', width: 10 });

      const pedir = async (ruta: string) => {
        const r = await request(app).post(ruta)
          .set('Authorization', cabecera).responseType('blob').send({});
        expect(r.status, `${ruta} tenía que responder 200`).toBe(200);
        return cabecerasDe(await libro(r.body as Buffer));
      };

      const deSoat = await pedir(RUTA);
      const deImpuestos = await pedir('/api/flito/impuestos/export');

      expect(deSoat.indexOf(CENTINELA_COLUMNA), 'SOAT no trajo la columna compartida').toBe(25);
      expect(deImpuestos.indexOf(CENTINELA_COLUMNA), 'Impuestos no trajo la columna compartida').toBe(25);
      expect(deSoat).toEqual(deImpuestos);
    } finally {
      // Restaurar en un `finally` y no en un `afterEach`: si un aserto falla a media prueba, el
      // `afterEach` corre igual pero el resto del archivo ya habría visto la lista contaminada en
      // los casos que se ejecuten dentro de este mismo `it`.
      COLUMNAS_COLA_EXPORT.length = 0;
      COLUMNAS_COLA_EXPORT.push(...original);
    }
  });
});

// ─────────────────────────── Lista blanca ────────────────────────────────────────────────────────

describe('lista blanca — el archivo lleva lo que la lista dice y la consulta no pide más', () => {
  it('**el nombre del titular SÍ sale, y NO viene de partir `nombre_completo`**', async () => {
    // Este bloque se invierte con la HU #11934, y solo a medias — que es lo que hay que fijar:
    //
    //   · el archivo AHORA publica el nombre (`NombrePila`, `Apellidos`, `RazonSocial`), así que el
    //     centinela del nombre pasa de prohibición a valor esperado;
    //   · pero ese nombre sale de `flit_raw` —donde FLIT manda `nombres` y `apellidos` YA
    //     SEPARADOS—, y **no** de partir `flito_compradores.nombre_completo` por el espacio, que es
    //     la cadena que `flit-http.adapter.ts:74` funde. Esa columna sigue sin leerse.
    //
    // El `split(' ')` sobre la columna fundida es el atajo cómodo y es exactamente lo que este caso
    // mata: fallaría en cada nombre compuesto y en cada razón social, y para hacerlo tendría que
    // traerse al proceso un dato personal que no hace falta.
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    const lecturaCompradores = lecturasDe('flito_compradores');
    expect(lecturaCompradores.length).toBeGreaterThan(0);
    for (const l of lecturaCompradores) {
      expect(l.columnas.length, 'el select de compradores tiene que ir proyectado').toBeGreaterThan(0);
      expect(l.columnas).not.toContain('nombreCompleto');
    }
    // La cadena fundida no aparece en NINGUNA celda: ni entera ni partida.
    const texto = textoDe(hoja);
    expect(texto).not.toContain(CENTINELA_CONCATENADO);
    expect(texto).not.toContain('CONCATENADO');

    // Y el nombre que SÍ sale es el del payload, en sus dos columnas separadas.
    expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
    expect(celda(hoja, 2, 'Apellidos')).toBe(CENTINELA_APELLIDOS);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });

  it('**la clasificación no sale de `tipo_documento`**: `CC` en la tabla y aun así `NIT` en la hoja', async () => {
    // `flito_compradores.tipo_documento` existe y está a 0 de 7 052 para las filas del sync: el
    // mapeo no lo escribe (solo el canal Cliente). Un predicado sobre esa columna clasificaría el
    // parque entero como una sola cosa —y funcionaría, al revés, justo en las filas del canal, que
    // son las que no tienen el resto del bloque—. La señal es `flit_raw->>'tipo'` (HU #11947).
    //
    // La fixture pone las dos fuentes en CONTRADICCIÓN a propósito —la columna dice `CC`, el payload
    // dice `n`— porque es la única forma de ver cuál de las dos manda.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ tipo: 'n', nombres: CENTINELA_RAZON, apellidos: ' ' })],
      flito_compradores: [comprador({ tipoDocumento: 'CC' })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'ClaseId')).toBe('NIT');
    expect(celda(hoja, 2, 'ClaseDeInterlocutor')).toBe('PJUR');
    expect(celda(hoja, 2, 'RazonSocial')).toBe(CENTINELA_RAZON);
  });

  it('nada de la operación (proveedor, valor pagado, motivo) entra en la consulta ni en el archivo', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    const proyeccion = lecturasDe(TABLA)[0].columnas;
    expect(proyeccion.length, 'la lectura principal tiene que ir proyectada').toBeGreaterThan(0);
    for (const prohibida of ['proveedorSoatId', 'valorPagado', 'motivoRechazo', 'gestionOperaciones']) {
      expect(proyeccion).not.toContain(prohibida);
    }

    const texto = textoDe(hoja);
    expect(texto).not.toContain(CENTINELA_PROVEEDOR);
    expect(texto).not.toContain(CENTINELA_MOTIVO);
    expect(texto).not.toContain('350000');
  });
});

// ─────────────────────────── El conjunto, no una página ──────────────────────────────────────────

describe('un export no pagina', () => {
  it('pide `tope + 1` filas, sin `offset`, y en UNA sola lectura (sin `count(*)`)', async () => {
    kdb.when.scenario({ flito_soat: filas(2), flito_tramites: [], flito_compradores: [] });

    expect((await exportar(await sesion())).status).toBe(200);

    const lecturas = lecturasDe(TABLA);
    // Una sola: el tope se comprueba con la fila sobrante, no recorriendo el filtro dos veces.
    expect(lecturas).toHaveLength(1);
    expect(lecturas[0].limit).toBe(TOPE + 1);
    expect(lecturas[0].offset).toBeNull();
  });

  it('`page`, `pageSize` y `cursor` en el cuerpo son 400, no un parámetro ignorado', async () => {
    const cabecera = await sesion();

    // Valores DENTRO del rango que el listado aceptaría: solo pueden ser 400 si el export los
    // rechaza por su cuenta. Sin el `.omit()`, respondería 200 ignorándolos en silencio y dejando
    // creer que se descargó «la página 2» de algo.
    expect((await exportar(cabecera, { page: 2 })).status).toBe(400);
    expect((await exportar(cabecera, { pageSize: 50 })).status).toBe(400);
    expect((await exportar(cabecera, { cursor: 'abc' })).status).toBe(400);
    // Y no se llegó a mirar la base.
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('un campo desconocido es 400 y no un filtro ignorado en silencio', async () => {
    // `organismo` en singular: sin `.strict()` se ignoraría y devolvería la cola ENTERA a quien pidió
    // la de un organismo — un archivo de más, presentado como el resultado del filtro.
    const r = await exportar(await sesion(), { organismo: '25286' });
    expect(r.status).toBe(400);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('una fecha que no es yyyy-mm-dd es 400 (el valor entra en un cast a `date`)', async () => {
    expect((await exportar(await sesion(), { creadoDesde: 'ayer' })).status).toBe(400);
  });
});

// ─────────────────────────── «Creado» es created_at ──────────────────────────────────────────────

describe('el rango nuevo filtra por `created_at`, no por `enviado_en`', () => {
  it('`creadoDesde`/`creadoHasta` entran en el WHERE sobre `created_at`', async () => {
    kdb.when.scenario({ flito_soat: filas(1), flito_tramites: [], flito_compradores: [] });

    const r = await exportar(await sesion(), { creadoDesde: '2026-08-01', creadoHasta: '2026-08-31' });
    expect(r.status).toBe(200);

    const { sql, params } = whereDelExport();
    // El mutante nombrado de esta HU: `flitoSoat.createdAt` → `flitoSoat.enviadoEn` en
    // `condicionesCola`. Devolvería filas igualmente —el filtro «parece» funcionar— y solo estos dos
    // asertos lo ponen rojo.
    expect(sql).toMatch(/"created_at" >= \$\d+::date/);
    expect(sql).toMatch(/"created_at" < \(\$\d+::date \+ INTERVAL '1 day'\)/);
    // Y sin rango de «solicitado» pedido, `enviado_en` no puede aparecer en el WHERE.
    expect(sql).not.toContain('enviado_en');
    expect(params).toContain('2026-08-01');
    expect(params).toContain('2026-08-31');
  });

  it('«Solicitado» sigue siendo `enviado_en`: los dos ejes conviven sin pisarse', async () => {
    kdb.when.scenario({ flito_soat: filas(1), flito_tramites: [], flito_compradores: [] });

    await exportar(await sesion(), {
      creadoDesde: '2026-08-01', solicitadoDesde: '2026-07-01',
    });

    const { sql } = whereDelExport();
    expect(sql).toMatch(/"created_at" >= \$\d+::date/);
    expect(sql).toMatch(/"enviado_en" >= \$\d+::date/);
  });

  it('el borde superior es INCLUSIVO por día: `< hasta + 1 día`, nunca `<= hasta`', async () => {
    kdb.when.scenario({ flito_soat: filas(1), flito_tramites: [], flito_compradores: [] });

    await exportar(await sesion(), { creadoHasta: '2026-08-31' });

    const { sql } = whereDelExport();
    // Con `<= $1::date`, un registro de las 23:59 del 31 de agosto quedaría FUERA —el cast a `date`
    // lo lleva a medianoche— y el usuario que filtra «hasta el 31» perdería la última jornada sin
    // que nada se lo diga. El `+ INTERVAL '1 day'` es lo que la incluye entera.
    expect(sql).toMatch(/"created_at" < \(\$\d+::date \+ INTERVAL '1 day'\)/);
    expect(sql).not.toMatch(/"created_at" <= /);
  });

  it('el `GET /` de la cola acepta el MISMO rango: el archivo es «lo que estoy viendo»', async () => {
    kdb.when.scenario({ flito_soat: [], flito_tramites: [], flito_compradores: [] });

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
    kdb.when.scenario({ flito_soat: [], flito_tramites: [], flito_compradores: [] });

    await request(await buildApp())
      .get(`${BASE}?estado=solicitado&organismos=25286&creadoDesde=2026-08-01`)
      .set('Authorization', cabecera);
    const pantalla = new PgDialect().sqlToQuery(lecturasDe(TABLA)[0].where as never);

    consultas.length = 0;
    kdb.reset(); instalarEspias();
    kdb.when.scenario({ flito_soat: [], flito_tramites: [], flito_compradores: [] });

    await exportar(cabecera, {
      estados: ['solicitado'], organismos: ['25286'], creadoDesde: '2026-08-01',
    });
    const archivo = new PgDialect().sqlToQuery(lecturasDe(TABLA)[0].where as never);

    // Un predicado paralelo escrito en el servicio del export empezaría idéntico y divergiría en el
    // primer filtro que se añada a uno y no al otro, sin que nadie lo note: los dos devuelven filas.
    expect(archivo.sql).toBe(pantalla.sql);
    expect(archivo.params).toEqual(pantalla.params);
  });
});

// ─────────────────────────── Tope y 422 ──────────────────────────────────────────────────────────

describe('tope — 422 sin archivo, y el borde no se pasa de largo', () => {
  it('EXACTAMENTE `tope` filas es 200 con `tope` filas de datos', async () => {
    kdb.when.scenario({ flito_soat: filas(TOPE), flito_tramites: [], flito_compradores: [] });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    // El borde legítimo: con `>=` en vez de `>` en la comprobación, este caso saldría 422 y el
    // usuario no podría descargar un conjunto que sí cabe.
    expect(hoja.rowCount).toBe(TOPE + 1); // + encabezado
    expect(lecturasDe(TABLA)[0].limit).toBe(TOPE + 1);
  });

  it('`tope + 1` filas es 422, SIN `Content-Disposition` y sin haber llamado a `sendExcel`', async () => {
    kdb.when.scenario({ flito_soat: filas(TOPE + 1), flito_tramites: [], flito_compradores: [] });

    const r = await exportar(await sesion());

    expect(r.status).toBe(422);
    // Lo que se caza no es «no responde 422», es «responde 422 con el adjunto ya anunciado»: eso
    // produce un archivo con un JSON dentro que el navegador guarda igual.
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(orden).not.toContain('excel');
  });

  it('el 422 trae `codigo` y NO revela cuántas filas hay', async () => {
    kdb.when.scenario({ flito_soat: filas(TOPE + 1), flito_tramites: [], flito_compradores: [] });

    const r = await exportar(await sesion());
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;

    // La pantalla decide por `codigo`, no por el texto: si el 422 saliera por el `handleError` del
    // módulo —que responde `{ error }` a secas—, el front no podría distinguir «acota el filtro» de
    // cualquier otro rechazo.
    expect(cuerpo.codigo).toBe('export_demasiado_grande');
    expect(cuerpo.error).toContain('3'); // el TOPE, que es el dato con el que el usuario actúa
    // El conteo real ni se sabe (la comprobación es `tope + 1`) ni se publica: devolverlo
    // convertiría el 422 en un contador de registros por filtro.
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

  it('`cliente` recibe 403 — es una empresa TERCERA', async () => {
    // El `cliente` ve su cola en pantalla (Feature #11912) y aun así no descarga esto: ver una fila
    // con su propietario y llevarse el padrón entero en un fichero reenviable son dos gestos
    // distintos, y este archivo lleva cédula, correo y dirección de titulares.
    const r = await exportar(await sesion('cliente'));
    expect(r.status).toBe(403);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });

  it('el export NO está en la allowlist del canal Cliente (la capa que decide primero)', async () => {
    // El 403 de arriba llega por DOS capas independientes y conviene saber cuál: la allowlist de
    // `canal-cliente.ts` niega por defecto todo lo que no esté escrito, y `OPS_O_GESTOR` niega
    // después. El aserto de la respuesta por sí solo seguiría verde si alguien colgara el export de
    // `LECTURA`, porque la allowlist lo taparía —y quedaría un endpoint abierto al `auditor` con una
    // sola línea de distancia—. Esto fija la primera capa por su lado.
    const { RUTAS_PERMITIDAS_CLIENTE } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(RUTAS_PERMITIDAS_CLIENTE.some((r) => r.patron.includes('export'))).toBe(false);
  });

  it('el gestor arrastra su frontera al WHERE del archivo', async () => {
    kdb.when.scenario({
      users: [{ p: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
      flito_soat: filas(1), flito_tramites: [], flito_compradores: [],
    });

    expect((await exportar(await sesion('proveedor'))).status).toBe(200);

    const { sql, params } = whereDelExport();
    // Las tres fronteras de la cola, en el archivo: su proveedor, nada de lo asumido por
    // Operaciones, y solo los estados que le son visibles (nunca `pendiente`).
    expect(sql).toContain('proveedor_soat_id');
    expect(sql).toContain('gestion_operaciones');
    expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(params).toContain('solicitado');
    expect(params).not.toContain('pendiente');
  });

  it('un gestor SIN proveedor descarga un archivo VACÍO, no la tabla entera', async () => {
    // `condicionesCola` devuelve `null` cuando no hay frontera que aplicar. El defecto que esto mata
    // es tratar ese `null` como «sin filtros»: la fixture tiene filas y el archivo no puede traerlas.
    kdb.when.scenario({
      users: [{ p: null }],
      flito_soat: filas(2), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion('proveedor'));
    expect(r.status).toBe(200);

    const hoja = await libro(r.body as Buffer);
    expect(hoja.rowCount).toBe(1); // solo el encabezado
    expect(textoDe(hoja)).not.toContain(PLACA);
    expect(lecturasDe(TABLA)).toHaveLength(0);
  });
});

// ─────────────────────────── AC7 · celdas vacías y una fila por SOAT ─────────────────────────────

describe('AC7 — el dato que falta deja la celda VACÍA, y la fila sale igual', () => {
  it('sin correo, sin cilindraje y sin municipio: tres celdas vacías y el resto con su valor', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat({ cilindraje: null })],
      flito_tramites: [tramite({ municipio: null })],
      flito_compradores: [comprador({ correo: null })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    // Vacías de verdad: ni `—`, ni `null`, ni `N/A`. Una celda vacía se filtra en Excel; un texto de
    // relleno no, y en la columna `NumeroId` sería además un dato inventado con aspecto de cierto.
    expect(celda(hoja, 2, 'Correo') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Cilindraje') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Municipio') ?? null).toBeNull();
    // Y las demás columnas de esa misma fila siguen completas.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(celda(hoja, 2, 'Celular')).toBe('3001234567');
    expect(celda(hoja, 2, 'OrganismoDetto')).toBe('STRIA TTOyTTE MCPAL FUNZA');
    // El municipio ausente no arrastra a la ciudad del organismo: son datos distintos.
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);

    const texto = textoDe(hoja);
    expect(texto).not.toContain('—');
    expect(texto).not.toContain('null');
    expect(texto).not.toContain('undefined');
  });

  it('un SOAT SIN comprador registrado SALE igual, con placa, VIN y organismo', async () => {
    // Mata el `INNER JOIN` sobre `flito_compradores`, que borraría del archivo —en silencio— cada
    // SOAT al que le falte el propietario. Son justo los que hay que revisar.
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2);
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'Vin')).toBe(VIN);
    expect(celda(hoja, 2, 'OrganismoDetto')).toBe('STRIA TTOyTTE MCPAL FUNZA');
    expect(celda(hoja, 2, 'NumeroId') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Direccion') ?? null).toBeNull();
    // El bloque del titular NO depende del comprador: sale del payload del trámite y sigue lleno.
    expect(celda(hoja, 2, 'NombrePila')).toBe(CENTINELA_NOMBRE);
  });

  it('DOS compradores del mismo trámite producen UNA sola fila, la del orden menor', async () => {
    // Mata el JOIN que duplica: 500 SOAT entregando 800 filas pasan todos los asertos de columnas
    // sin despeinarse, y además falsearían el conteo contra el tope.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite()],
      flito_compradores: [
        comprador({ id: 'c9', orden: 1, numeroDocumento: '9999999999', correo: 'segundo@empresa.co' }),
        comprador({ id: 'c1', orden: 0 }),
      ],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2); // encabezado + UNA fila
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(textoDe(hoja)).not.toContain('9999999999');
  });

  it('con el `orden` EMPATADO, el principal se decide por `id` y no por el azar de la consulta', async () => {
    // `flito_compradores.orden` es `notNull().default(0)` y NO es único por trámite: sin el
    // desempate por `id`, dos exports del mismo filtro podrían traer documentos distintos en la
    // misma fila sin que nada hubiera cambiado en la base.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite()],
      flito_compradores: [
        comprador({ id: 'c-zzz', orden: 0, numeroDocumento: '8888888888' }),
        comprador({ id: 'c-aaa', orden: 0, numeroDocumento: CEDULA }),
      ],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });
});

// ─────────────────────────── SOAT: sin join nuevo, y la reconciliación ───────────────────────────

describe('un SOAT sirve a VARIOS trámites — sin join en la lectura principal y sin filas de más', () => {
  it('**la lectura principal NO une `flito_tramites`**', async () => {
    // La HU #11934 le pide al archivo nueve columnas del trámite, y el atajo es añadir el join a
    // `conJoinsCola`. Sería el defecto más caro del cambio: un SOAT es por VIN y puede servir a
    // varios trámites (RN-01), así que ese join multiplicaría la fila del SOAT una vez por trámite.
    // El `.xlsx` traería 800 filas para 500 SOAT —con las 25 columnas correctas, así que ningún
    // aserto de cabeceras se enteraría— y el conteo contra el tope contaría duplicados, de modo que
    // un filtro legítimo podría recibir un 422. Los datos del trámite se leen por LOTE, aparte.
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    await exportar(await sesion());

    const principal = lecturasDe(TABLA)[0];
    expect(principal.joins).not.toContain('flito_tramites');
    // Y los joins que sí tiene siguen ahí: el predicado compartido con la pantalla los necesita.
    expect(principal.joins).toContain('vehicles');
    expect(principal.joins).toContain('organismos_transito_config');
    // Los datos del trámite llegan por su propia lectura, una sola, y con `flito_tramites` como
    // tabla RAÍZ (no unida): es lo que garantiza una fila de archivo por SOAT.
    const deTramites = lecturasDe('flito_tramites');
    expect(deTramites).toHaveLength(1);
    expect(deTramites[0].joins).toEqual([]);
  });

  it('**`OrganismoDettoCiudad` se calcula sobre la COLUMNA normalizada, no sobre `codigoSecretaria`**', async () => {
    // El mutante que esto mata es el más silencioso de la HU y no lo ve NINGÚN aserto de celdas: leer
    // el código del organismo de `flit_raw->>'codigoSecretaria'` en vez de `flito_soat.organismo_codigo`.
    // Los dos parecen el mismo dato; el del payload llega SIN el cero de relleno en 3 650 de 7 052
    // filas (`5001` donde el catálogo tiene `05001`), así que `getOrganismoByCodigo` devolvería
    // `undefined` y **el 51,8 % de las filas saldría con la ciudad vacía sin un solo error**. Con una
    // fixture que ya trae `organismoCodigo`, el archivo sale idéntico con las dos versiones: hay que
    // mirar de qué está hecha la proyección.
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    await exportar(await sesion());

    const principal = lecturasDe(TABLA)[0];
    expect(origenDe(principal.proyeccion.organismoCodigo)).toBe('col:flito_soat.organismo_codigo');

    // Y en NINGUNA de las dos lecturas hay una expresión que toque esa clave del payload.
    for (const consulta of [principal, lecturasDe('flito_tramites')[0]]) {
      for (const [campo, valor] of Object.entries(consulta.proyeccion)) {
        expect(origenDe(valor), `${consulta.tabla}.${campo}`).not.toContain('codigoSecretaria');
      }
    }
  });

  it('dos trámites del mismo SOAT con `marca` distinta → UNA fila y `Marca` VACÍA', async () => {
    // Cada campo del trámite se reconcilia con `comun()`: el valor que comparten todos, o vacío.
    // Elegir el del primer trámite pondría en el archivo un dato con aspecto de cierto que depende
    // del orden en que PostgreSQL devuelva las filas.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [
        tramite(),
        tramite({ id: TRAMITE_B, municipio: 'MOSQUERA', marca: 'KIA', modelo: '2019' }),
      ],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2); // UNA fila, no una por trámite
    expect(celda(hoja, 2, 'Marca') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Municipio') ?? null).toBeNull();
    expect(celda(hoja, 2, 'Modelo') ?? null).toBeNull();
    expect(textoDe(hoja)).not.toContain('MOSQUERA');
    expect(textoDe(hoja)).not.toContain('KIA');
    // Y lo que SÍ comparten los dos trámites sigue saliendo: la reconciliación es campo a campo.
    expect(celda(hoja, 2, 'Linea')).toBe('ONIX');
  });

  it('**el titular se reconcilia COMO TUPLA, no campo a campo**', async () => {
    // Dos trámites que coinciden en `nombres` y difieren en `apellidos`. Con dos `comun()`
    // independientes esta fila saldría con el nombre y el apellido en blanco, y **se clasificaría
    // como JURÍDICA metiendo el nombre de pila de una persona en `RazonSocial`**, con su `ClaseId`
    // diciendo `NIT`. No lanza, no avisa, y las 25 cabeceras siguen en su sitio.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [
        tramite(),
        tramite({ id: TRAMITE_B, apellidos: 'OTRO APELLIDO' }),
      ],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    // Las CINCO del bloque vacías: la tripla no se pudo reconciliar —discrepa en `apellidos`—, así
    // que no hay titular que clasificar. Y en particular, el nombre NO acaba en `RazonSocial`.
    for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía`).toBeNull();
    }
    expect(textoDe(hoja)).not.toContain(CENTINELA_NOMBRE);
    // La fila SALE igual, con lo que no depende del titular.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
  });

  it('**la tupla es una TRIPLA: `tipo` va DENTRO** (HU #11947)', async () => {
    // El tercer mutante nombrado de la HU: reconciliar `tipo` con un `comun()` APARTE, dejando la
    // tupla en el par de nombres. Hay que mirarlo por sus DOS mitades, porque cada una cae por un
    // motivo distinto y una sola no distingue el mutante:
    //
    //   (a) mismos nombres, `tipo` distinto — el `comun()` aparte también da vacío aquí, así que
    //       esta mitad NO ve el mutante; lo que mata es el atajo «me quedo con el tipo del primer
    //       trámite», que publicaría una clase que solo afirma uno de los dos.
    //   (b) mismo `tipo`, apellidos distintos — **aquí es donde el mutante se ve**: la tupla de
    //       nombres no reconcilia y llega vacía, pero el `comun()` del tipo SÍ devuelve `cc`, así
    //       que la fila sale `PNAT` + `CC` con `NombrePila` y `Apellidos` en blanco: una clase
    //       afirmada sobre un titular que el conjunto no sabe quién es.
    //
    // Con la TRIPLA las dos mitades dan lo mismo —bloque vacío—, que es la respuesta que ya da la
    // cola con `tipoTramite` cuando los trámites de un SOAT discrepan.
    const CINCO = ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId'];

    // (a) el `tipo` es lo único que discrepa.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ tipo: 'n' }), tramite({ id: TRAMITE_B, tipo: 'cc' })],
      flito_compradores: [comprador()],
    });

    const porTipo = await libro((await exportar(await sesion())).body as Buffer);
    expect(porTipo.rowCount).toBe(2); // UNA fila, no una por trámite
    for (const c of CINCO) expect(celda(porTipo, 2, c) ?? null, `(a) ${c}`).toBeNull();
    // Ni la clase de uno ni la del otro: el conjunto no afirma ninguna.
    expect(textoDe(porTipo)).not.toContain('PJUR');
    expect(textoDe(porTipo)).not.toContain('PNAT');
    // Y lo que los dos trámites SÍ comparten sigue saliendo: la reconciliación no vacía la fila.
    expect(celda(porTipo, 2, 'Linea')).toBe('ONIX');
    expect(celda(porTipo, 2, 'Placa')).toBe(PLACA);

    // (b) el `tipo` coincide y lo que discrepa es el nombre. Es la mitad que mata el `comun()`
    // aparte: con él, la clase se publicaría igual sobre un titular en blanco.
    kdb.reset(); instalarEspias(); consultas.length = 0;
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite({ tipo: 'cc' }), tramite({ id: TRAMITE_B, tipo: 'cc', apellidos: 'OTRO APELLIDO' })],
      flito_compradores: [comprador()],
    });

    const porNombre = await libro((await exportar(await sesion())).body as Buffer);
    for (const c of CINCO) expect(celda(porNombre, 2, c) ?? null, `(b) ${c}`).toBeNull();
    // En particular, la clase NO puede salir sola: sin saber quién es el titular, no hay qué
    // clasificar. `PNAT` y `CC` son los valores que produciría el mutante.
    expect(celda(porNombre, 2, 'ClaseDeInterlocutor') ?? null).toBeNull();
    expect(celda(porNombre, 2, 'ClaseId') ?? null).toBeNull();
    expect(textoDe(porNombre)).not.toContain('PNAT');
    expect(textoDe(porNombre)).not.toContain(CENTINELA_NOMBRE);
    expect(celda(porNombre, 2, 'Placa')).toBe(PLACA);
  });
});

// ─────────────────────────── Canal Cliente ───────────────────────────────────────────────────────

describe('canal Cliente — sin trámite y sin `flit_raw`, la fila SALE igual', () => {
  it('**las CINCO del titular vacías y las DOCE que no dependen del payload, llenas**', async () => {
    // Dos defectos distintos, los dos silenciosos, y este caso los mata a la vez:
    //
    //   1. **El bloque del titular.** Sin `flit_raw` no hay `nombres` ni `apellidos`. Escribir
    //      `if (!apellidos) → PJUR/NIT` marcaría cada fila del canal como persona JURÍDICA con la
    //      razón social vacía: una afirmación falsa sobre la naturaleza de un titular, publicada en
    //      un archivo que sale del perímetro, y ningún aserto de columnas se entera.
    //   2. **El propietario.** `flito_compradores` cuelga de dos padres desde la 0167; leer solo la
    //      vía del trámite dejaría documento, correo y dirección vacíos y el `.xlsx` se abriría sin
    //      quejarse.
    //
    // Y mata además el `innerJoin` a `flito_tramites` en la lectura principal, que haría desaparecer
    // estas filas del archivo por completo.
    kdb.when.scenario({
      flito_soat: [filaSoat({ id: SOAT_CANAL, origen: 'cliente' })],
      flito_tramites: [], // una solicitud del canal no tiene trámite
      flito_compradores: [comprador({ tramiteId: null, soatId: SOAT_CANAL })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(hoja.rowCount).toBe(2); // la fila del canal está en el archivo

    // Las cinco del bloque: VACÍAS, no `PJUR` + `NIT`.
    for (const c of ['ClaseDeInterlocutor', 'NombrePila', 'Apellidos', 'RazonSocial', 'ClaseId']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía en el canal Cliente`).toBeNull();
    }
    const texto = textoDe(hoja);
    expect(texto).not.toContain('PJUR');
    expect(texto).not.toContain('NIT');

    // Las doce que NO dependen del payload del trámite, con su valor.
    expect(celda(hoja, 2, 'Placa')).toBe(PLACA);
    expect(celda(hoja, 2, 'Vin')).toBe(VIN);
    expect(celda(hoja, 2, 'Carroceria')).toBe('CAMIONETA');
    expect(celda(hoja, 2, 'Cilindraje')).toBe('1598');
    expect(celda(hoja, 2, 'Servicio')).toBe('Particular');
    expect(celda(hoja, 2, 'NumeroId')).toBe(CEDULA);
    expect(celda(hoja, 2, 'Direccion')).toBe('CALLE 1 # 2-3');
    expect(celda(hoja, 2, 'Celular')).toBe('3001234567');
    expect(celda(hoja, 2, 'Correo')).toBe('juana@empresa.co');
    expect(celda(hoja, 2, 'OrganismoDettoCiudad')).toBe(CIUDAD_ORGANISMO);
    expect(celda(hoja, 2, 'Puertas')).toBe('4');
    expect(celda(hoja, 2, 'N_I')).toBe('IMPORTADO');

    // Y las del trámite, vacías: sin trámite no hay municipio, ni organismo crudo, ni payload.
    for (const c of ['Municipio', 'OrganismoDetto', 'Marca', 'Linea', 'Modelo', 'Clase', 'Departamento']) {
      expect(celda(hoja, 2, c) ?? null, `${c} tenía que ir vacía sin trámite`).toBeNull();
    }
  });

  it('una selección de puro trámite no paga la lectura del canal', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    await exportar(await sesion());

    // Una sola lectura de `flito_compradores`: la del canal solo se hace si hay filas del canal.
    expect(lecturasDe('flito_compradores')).toHaveLength(1);
  });
});

// ─────────────────────────── Rastro PII ──────────────────────────────────────────────────────────

describe('rastro — Ley 1581 art. 17', () => {
  it('una sola línea, `accion: export`, con las filas REALES y antes del primer byte', async () => {
    kdb.when.scenario({
      flito_soat: filas(2), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    expect((await exportar(await sesion())).status).toBe(200);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('export');
    expect(acceso.resourceTipo).toBe('flito_soat');
    // Las filas ENTREGADAS, no el tope ni lo pedido: un número inflado ensucia el dato con el que se
    // recalibra el tope.
    expect(String(acceso.motivo)).toContain('filas=2');
    // Y escrito ANTES de que empiece a salir el archivo: si el proceso muere a mitad de la escritura,
    // la constancia de que alguien se llevó dos cédulas ya está puesta. Invertir las dos líneas de la
    // ruta no cambia ninguna respuesta —solo este aserto lo ve—.
    expect(orden).toEqual(['pii', 'excel']);
  });

  it('**`campos_accedidos` declara el NOMBRE del titular**, además del documento y el contacto', async () => {
    kdb.when.scenario({
      flito_soat: filas(1), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    await exportar(await sesion());
    const campos = ultimoAcceso().camposAccedidos as string[];

    // Sin esto, `pii_access_log` mentiría POR OMISIÓN justo en lo que la HU #11909 añadió: la cola
    // declara cuatro campos y el archivo entrega más.
    expect(campos).toContain('correo');
    expect(campos).toContain('celular');
    expect(campos).toContain('direccion');
    expect(campos).toContain('ciudad');
    expect(campos).toContain('numero_documento');

    // **Y aquí es donde la HU #11934 invierte el aserto.** La hoja de once columnas llevaba el
    // documento del propietario y NO su nombre, así que declararlo habría sido declarar de más —fue
    // el argumento con el que se dejó fuera—. La de veinticinco publica `NombrePila`, `Apellidos` y
    // `RazonSocial`: mantener la exclusión haría que el registro mintiera por omisión exactamente en
    // el dato que la HU añade. Que el nombre venga de `flit_raw` y no de
    // `flito_compradores.nombre_completo` no cambia nada: esto declara QUÉ dato personal salió del
    // perímetro, no de qué columna se leyó.
    expect(campos).toContain('nombre_completo');

    // **Y la HU #11947 invierte el segundo.** `tipo_documento` estaba EXCLUIDO aquí con el argumento
    // de que la lista es la del archivo y no la de la tabla; el argumento decayó: la columna
    // `ClaseId` ya salía desde la #11934, y desde esta HU es un tipo de documento AFIRMADO por el
    // origen —`CC`, `NIT`, `PP`, `CE`— y no una consecuencia de si había apellido. `CE` en un
    // archivo que sale del perímetro dice que el titular es extranjero: es un dato del titular, no
    // un formato. Declararlo es lo que impide que el registro mienta por omisión en lo que la HU
    // añade, que es exactamente el criterio con el que entró `nombre_completo`.
    expect(campos).toContain('tipo_documento');
    // Y sigue siendo la lista del ARCHIVO y no la de la tabla: lo que no se publica, no se declara.
    expect(campos).not.toContain('porcentaje_participacion');
    expect(campos).not.toContain('valor_pagado');
  });

  it('el 422 deja `accion: search`, `filas=0` y el marcador del código', async () => {
    kdb.when.scenario({ flito_soat: filas(TOPE + 1), flito_tramites: [], flito_compradores: [] });

    expect((await exportar(await sesion())).status).toBe(422);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    // `search` y no `export`: no se exportó nada, y contarlo como export estropearía los agregados
    // de `/api/privacy/pii-access/stats`. Pero la consulta CORRIÓ —`tope + 1` filas con su cédula
    // entraron en el proceso—, así que la línea tiene que existir: sin ella, la muestra con la que
    // ADR-0004 promete recalibrar el tope queda amputada justo en la cola que se quiere medir.
    expect(acceso.accion).toBe('search');
    expect(String(acceso.motivo)).toContain('resultado=export_demasiado_grande');
    expect(String(acceso.motivo)).toContain('filas=0');
  });
});

// ─────────────────────────── Nombre del archivo y forma del endpoint ─────────────────────────────

describe('el nombre del archivo no lleva datos de nadie', () => {
  it('`attachment; filename="soat_YYYYMMDD-HHmm.xlsx"`, `no-store`, y sin placa ni cédula ni VIN', async () => {
    kdb.when.scenario({
      flito_soat: filas(1), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());

    const disposition = String(r.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="soat_\d{8}-\d{4}\.xlsx"$/);
    // El filtro NO viaja en el nombre: acabaría escrito en el sistema de archivos de quien descarga
    // y en cualquier adjunto que reenvíe.
    for (const dato of [PLACA, CEDULA, VIN]) expect(disposition).not.toContain(dato);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['content-type'])
      .toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('el router NO declara ninguna variante GET del export', () => {
    // El filtro `buscar` de esta cola casa contra placa, VIN, nombre y cédula: un `router.get` aquí
    // devolvería la cédula a la URL —y a los logs de nginx, al historial y al `Referer`— sin romper
    // ningún otro test (AGENTS.md §14).
    const fuente = fuenteDelRouter();
    expect(fuente).not.toMatch(/router\.get\(\s*'[^']*export/);
    expect(fuente).toMatch(/router\.post\(\s*'\/export'/);
  });

  it('el router NO declara un limitador propio: usa el COMPARTIDO de las dos colas', () => {
    // La primera versión de esta HU le dio una bolsa a cada cola. El gate de seguridad lo tumbó: el
    // recurso que se raciona es el heap de UN proceso —`FLITO_COLA_EXPORT_MAX_FILAS` ya es una sola
    // perilla por eso mismo—, así que dos bolsas dejaban a una sesión con el doble de exports
    // simultáneos posibles y doblaban el techo de extracción de PII.
    //
    // Se afirma sobre la FUENTE porque la vuelta atrás más probable es cómoda y silenciosa: copiar
    // el bloque `rateLimit({…})` de vuelta al router. Con `makeStore` devolviendo `undefined` sin
    // Redis —CI, desarrollo—, dos `rateLimit()` con la MISMA llave tendrían contadores distintos:
    // el código se leería idéntico y el freno valdría el doble.
    const fuente = fuenteDelRouter();
    expect(fuente).toContain('exportColaLimiter');
    expect(fuente).not.toContain('rateLimit(');
    expect(fuente).not.toContain('flito-soat-export');
  });
});

// ─────────────────────────── La cuota es UNA para las dos colas ──────────────────────────────────

describe('cuota del export — una sola bolsa para SOAT e Impuestos', () => {
  it('**agotar los 5 exports en SOAT devuelve 429 en el de IMPUESTOS**, con el mismo usuario', async () => {
    // Lo que este caso defiende es el presupuesto de MEMORIA, no una cortesía entre pantallas:
    // `sendExcel` construye el workbook entero en el heap y ADR-0004 midió que cinco simultáneos al
    // tope suman +239 MB de los 262 que hay hasta el `max_memory_restart` de PM2. El limitador cuenta
    // por minuto y no en vuelo, y la cuota es por usuario sin cota global, así que una sola sesión
    // puede tenerlos todos construyéndose a la vez: con dos bolsas serían diez y el margen desaparece.
    //
    // Y es el techo de extracción de datos personales: cuota × tope. Con una bolsa, 10 000 filas por
    // minuto y usuario; con dos, 20 000 — cada una con cédula, correo, teléfono y dirección.
    const cabecera = await sesion();
    kdb.when.scenario({
      flito_soat: [], flito_tramites: [], flito_compradores: [], flito_impuestos: [],
    });
    const app = await buildAppAmbas();

    for (let i = 1; i <= 5; i += 1) {
      const r = await request(app).post(RUTA)
        .set('Authorization', cabecera).responseType('blob').send({});
      expect(r.status, `el export ${i} de SOAT tenía que caber en la cuota`).toBe(200);
    }

    const sexto = await request(app).post('/api/flito/impuestos/export')
      .set('Authorization', cabecera).responseType('blob').send({});

    // Con dos bolsas este sexto sería un 200 y nada más lo delataría.
    expect(sexto.status).toBe(429);
  });

  it('la cuota es POR USUARIO: otro `sub` no arrastra el freno del anterior', async () => {
    // Sin esto, el caso de arriba pasaría igual con una bolsa GLOBAL —que frenaría a toda la
    // operación por lo que hace una cuenta— y sería un arreglo peor que el problema.
    const gastada = await sesion();
    kdb.when.scenario({
      flito_soat: [], flito_tramites: [], flito_compradores: [], flito_impuestos: [],
    });
    const app = await buildAppAmbas();

    for (let i = 0; i < 5; i += 1) {
      await request(app).post(RUTA).set('Authorization', gastada).responseType('blob').send({});
    }
    expect((await request(app).post(RUTA).set('Authorization', gastada)
      .responseType('blob').send({})).status).toBe(429);

    const otra = await sesion();
    const r = await request(app).post('/api/flito/impuestos/export')
      .set('Authorization', otra).responseType('blob').send({});
    expect(r.status).toBe(200);
  });
});
