// FLITO SOAT — export a Excel de la cola filtrada (Feature #11908, HU #11909).
//
// `POST /api/flito/soat/export` es la única ruta del módulo que entrega un ARCHIVO, y eso cambia qué
// puede salir mal: una respuesta binaria no se equivoca «un poco», o es un `.xlsx` abrible con los
// datos correctos o es basura que alguien abre y no entiende. Y a diferencia del de comparendos,
// este archivo lleva la CÉDULA, el CORREO y la DIRECCIÓN del propietario del vehículo.
//
// Lo que se demuestra aquí, por orden de lo que costaría más caro si dejara de ser verdad:
//
//   1. **Las once columnas, en su orden, afirmadas sobre el WORKBOOK REAL** (AC1). El aserto NO se
//      hace contra la constante `COLUMNAS_COLA_EXPORT`: si se hiciera, renombrar la constante movería
//      el test y el código a la vez y el test dejaría de probar nada. Se escriben los once literales
//      a mano. Mata: una columna `MUNICIPIO`, una columna de más, el orden alterado.
//   2. **«Creado» es `created_at` y no `enviado_en`** (el filtro nuevo). Las dos columnas existen y
//      el defecto probable es implementar el rango nuevo como alias del de «Solicitado», que ya está
//      en pantalla: devolvería filas, así que nadie lo notaría. Se afirma sobre el SQL real del
//      `WHERE`, serializado con `PgDialect`.
//   3. **El export y la pantalla comparten predicado.** El `WHERE` del `POST /export` y el del
//      `GET /` con los mismos filtros tienen que serializar IGUAL. Un predicado paralelo empezaría
//      idéntico y divergiría en el primer filtro que se añada a uno y no al otro — sin que se note,
//      porque los dos devuelven filas.
//   4. **El 422 sale ANTES de que exista una cabecera de adjunto.** El fallo que se caza no es «no
//      responde 422», es «responde 422 con el `Content-Disposition` ya puesto»: eso produce un
//      archivo de 300 bytes con un JSON dentro que el navegador guarda igual.
//   5. **El propietario del canal Cliente sale.** `flito_compradores` cuelga de dos padres; leer solo
//      la vía del trámite dejaría las filas del canal sin cédula, correo ni dirección, y el `.xlsx`
//      se abriría sin quejarse.
//   6. **Ni `auditor` ni `cliente` descargan esto** — el `cliente` es una empresa TERCERA.
//   7. **El rastro dice la verdad sobre lo que se llevó**, y va escrito antes del primer byte.
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
const TRAMITE_A = '33333333-3333-3333-3333-333333333333';
const TRAMITE_B = '44444444-4444-4444-4444-444444444444';

const PLACA = 'JNH38H';
const VIN = '9FKRG2222T2042405';
const CEDULA = '1020304050';

/**
 * Datos que la fila CRUDA lleva y que ninguna celda del archivo puede contener.
 *
 * `nombreCompleto` es el caso que importa: el propietario existe y su nombre está en la tabla, pero
 * la hoja tiene once columnas y ninguna es el nombre. Si la consulta lo pidiera «por si acaso» o las
 * filas se construyeran con un `spread`, aparecería en cuanto alguien añadiera la columna — y la
 * lectura ya lo habría traído al proceso.
 */
const CENTINELA_NOMBRE = 'CENTINELA-NOMBRE-PROPIETARIO';
const CENTINELA_PROVEEDOR = 'CENTINELA-PROVEEDOR-SOAT';
const CENTINELA_MOTIVO = 'CENTINELA-MOTIVO-RECHAZO';

/** Fila de `flito_soat` × joins, tal como la traería la base SIN proyectar. */
const filaSoat = (over: Record<string, unknown> = {}) => ({
  id: SOAT_A,
  origen: 'tramite',
  vin: VIN,
  placa: PLACA,
  carroceria: 'CAMIONETA',
  tipoServicio: 'Particular',
  cilindraje: '1598',
  organismoAlias: 'FUNZA',
  organismoCodigo: '25286',
  // Lo que la proyección del export NO pide. El mock keyed devuelve la fila entera aunque el
  // `select` pidiera menos, así que estas tres viajan igual y sirven de centinela.
  proveedorSoatId: CENTINELA_PROVEEDOR,
  valorPagado: '350000.00',
  motivoRechazo: CENTINELA_MOTIVO,
  ...over,
});

const tramite = (over: Record<string, unknown> = {}) => ({
  id: TRAMITE_A, soatId: SOAT_A, ciudad: 'FUNZA', ...over,
});

const comprador = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tramiteId: TRAMITE_A, soatId: null,
  numeroDocumento: CEDULA,
  correo: 'juana@empresa.co', celular: '3001234567', direccion: 'CALLE 1 # 2-3',
  orden: 0,
  nombreCompleto: CENTINELA_NOMBRE,
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
  limit: number | null;
  offset: number | null;
  where: unknown;
}[] = [];

function instalarEspias(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const consulta = {
      tabla: '__sin_from__', columnas,
      limit: null as number | null, offset: null as number | null, where: null as unknown,
    };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { consulta.tabla = nombre(tbl); consultas.push(consulta); return from(tbl); };
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
 * Las once cabeceras ESCRITAS A MANO.
 *
 * No se importan de `COLUMNAS_COLA_EXPORT` a propósito: comparar el archivo contra la constante que
 * lo generó es una tautología —cambiar la constante movería las dos cosas a la vez—. Estos once
 * literales son el AC1, y romperlos tiene que costar editar este archivo.
 */
const CABECERAS = [
  'PLACA', 'CEDULA', 'CORREO', 'TELEFONO', 'DIRECCION', 'VIN', 'CIUDAD',
  'CARROCERIA', 'TIPO DE SERVICIO', 'CILINDRAJE', 'ORGANISMO DE TRANSITO',
];

const cabecerasDe = (hoja: ExcelJS.Worksheet): string[] =>
  (hoja.getRow(1).values as unknown[]).slice(1).map(String);

/** El valor de una celda por el TEXTO de su cabecera (que es el contrato de lectura del archivo). */
function celda(hoja: ExcelJS.Worksheet, nFila: number, cabecera: string): unknown {
  const indice = CABECERAS.indexOf(cabecera);
  expect(indice, `la cabecera «${cabecera}» no está en la lista del AC1`).toBeGreaterThanOrEqual(0);
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

describe('AC1 — el archivo tiene EXACTAMENTE once columnas, en su orden', () => {
  it('las once cabeceras, en MAYÚSCULAS y sin tildes, y `columnCount === 11`', async () => {
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
    // número es lo que obliga a mirar el AC.
    expect(hoja.columnCount).toBe(11);
  });

  it('NO existe una columna `MUNICIPIO`, ni `NOMBRE`, ni ninguna de fecha de creación', async () => {
    kdb.when.scenario({
      flito_soat: filas(1), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const cabeceras = cabecerasDe(hoja);

    // `MUNICIPIO` es la tentación importada del export de comparendos; `NOMBRE`, la de «ya que
    // leemos al comprador»; una columna de fecha, la de «el filtro nuevo es por creación». El AC1
    // dice «las columnas son exactamente» y manda sobre las tres.
    expect(cabeceras).not.toContain('MUNICIPIO');
    expect(cabeceras).not.toContain('NOMBRE');
    expect(cabeceras.filter((h) => /CREAD|FECHA/.test(h))).toEqual([]);
  });

  it('el encabezado va con el estilo del resto de exports del repo', async () => {
    kdb.when.scenario({ flito_soat: filas(1), flito_tramites: [], flito_compradores: [] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    const encabezado = hoja.getRow(1);

    expect(encabezado.font?.bold).toBe(true);
    expect((encabezado.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FF1F2937');
  });
});

// ─────────────────────────── Lista blanca ────────────────────────────────────────────────────────

describe('lista blanca — el archivo lleva lo que la lista dice y la consulta no pide más', () => {
  it('el nombre del propietario ni se consulta ni aparece en el buffer', async () => {
    // `filaSoat()` y no `filas(1)`: el id tiene que ser el mismo que el `soatId` del trámite para
    // que el propietario llegue a cruzarse — si no, la CEDULA saldría vacía y el aserto de abajo
    // pasaría por no haber traído nada, que es exactamente el falso verde que este bloque persigue.
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    // Dos asertos y no uno, porque protegen cosas distintas y el segundo solo no bastaría:
    //   · la PROYECCIÓN — el nombre no se llega a leer de la base. Mata `db.select()` sin lista de
    //     columnas, que es el atajo que traería la fila entera al proceso;
    //   · el BUFFER — no acaba en ninguna celda.
    const lecturaCompradores = lecturasDe('flito_compradores');
    expect(lecturaCompradores.length).toBeGreaterThan(0);
    for (const l of lecturaCompradores) {
      expect(l.columnas.length, 'el select de compradores tiene que ir proyectado').toBeGreaterThan(0);
      expect(l.columnas).not.toContain('nombreCompleto');
    }
    expect(textoDe(hoja)).not.toContain(CENTINELA_NOMBRE);
    // Y la fila sí está: el test no pasa por no haber traído nada.
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
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
  it('sin correo, sin cilindraje y sin ciudad: tres celdas vacías y el resto con su valor', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat({ cilindraje: null })],
      flito_tramites: [tramite({ ciudad: null })],
      flito_compradores: [comprador({ correo: null })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    // Vacías de verdad: ni `—`, ni `null`, ni `N/A`. Una celda vacía se filtra en Excel; un texto de
    // relleno no, y en la columna CEDULA sería además un dato inventado con aspecto de cierto.
    expect(celda(hoja, 2, 'CORREO') ?? null).toBeNull();
    expect(celda(hoja, 2, 'CILINDRAJE') ?? null).toBeNull();
    expect(celda(hoja, 2, 'CIUDAD') ?? null).toBeNull();
    // Y las demás columnas de esa misma fila siguen completas.
    expect(celda(hoja, 2, 'PLACA')).toBe(PLACA);
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
    expect(celda(hoja, 2, 'TELEFONO')).toBe('3001234567');
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('FUNZA');

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
    expect(celda(hoja, 2, 'PLACA')).toBe(PLACA);
    expect(celda(hoja, 2, 'VIN')).toBe(VIN);
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('FUNZA');
    expect(celda(hoja, 2, 'CEDULA') ?? null).toBeNull();
    expect(celda(hoja, 2, 'DIRECCION') ?? null).toBeNull();
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
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
    expect(textoDe(hoja)).not.toContain('9999999999');
  });

  it('con el `orden` EMPATADO, el principal se decide por `id` y no por el azar de la consulta', async () => {
    // `flito_compradores.orden` es `notNull().default(0)` y NO es único por trámite: sin el
    // desempate por `id`, dos exports del mismo filtro podrían traer cédulas distintas en la misma
    // fila sin que nada hubiera cambiado en la base.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite()],
      flito_compradores: [
        comprador({ id: 'c-zzz', orden: 0, numeroDocumento: '8888888888' }),
        comprador({ id: 'c-aaa', orden: 0, numeroDocumento: CEDULA }),
      ],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
  });

  it('un organismo sin alias cae a su CÓDIGO, nunca a la cadena «null»', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat({ organismoAlias: null })],
      flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('25286');
  });

  it('CIUDAD queda VACÍA cuando los trámites del mismo SOAT discrepan', async () => {
    // Un SOAT es por VIN y puede servir a varios trámites (RN-01): elegir la ciudad del primero
    // pondría en el archivo un dato con aspecto de cierto que depende del orden de la consulta.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_tramites: [tramite(), tramite({ id: TRAMITE_B, ciudad: 'MOSQUERA' })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(hoja.rowCount).toBe(2); // y sigue siendo UNA fila, no una por trámite
    expect(celda(hoja, 2, 'CIUDAD') ?? null).toBeNull();
    expect(textoDe(hoja)).not.toContain('MOSQUERA');
  });
});

// ─────────────────────────── Canal Cliente ───────────────────────────────────────────────────────

describe('canal Cliente — el propietario cuelga del OTRO padre y tiene que salir', () => {
  it('una fila con `origen = cliente` trae cédula, correo y dirección', async () => {
    // Sin la segunda vía (`soat_id`), estas cuatro celdas saldrían vacías, el `.xlsx` se abriría sin
    // quejarse y ningún aserto de columnas se enteraría. `flito_compradores` cuelga de dos padres
    // desde la 0167 con un CHECK de «uno y solo uno».
    kdb.when.scenario({
      flito_soat: [filaSoat({ id: SOAT_CANAL, origen: 'cliente' })],
      flito_tramites: [], // una solicitud del canal no tiene trámite
      flito_compradores: [comprador({ tramiteId: null, soatId: SOAT_CANAL })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
    expect(celda(hoja, 2, 'CORREO')).toBe('juana@empresa.co');
    expect(celda(hoja, 2, 'DIRECCION')).toBe('CALLE 1 # 2-3');
    // Y su CIUDAD va vacía, que es lo esperado: sin trámite no hay ciudad que reconciliar.
    expect(celda(hoja, 2, 'CIUDAD') ?? null).toBeNull();
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

  it('`campos_accedidos` declara el correo, el celular y la dirección — y NO el nombre', async () => {
    kdb.when.scenario({
      flito_soat: filas(1), flito_tramites: [tramite()], flito_compradores: [comprador()],
    });

    await exportar(await sesion());
    const campos = ultimoAcceso().camposAccedidos as string[];

    // Sin esto, `pii_access_log` mentiría POR OMISIÓN justo en lo que esta HU añade: la cola declara
    // cuatro campos y el archivo entrega siete.
    expect(campos).toContain('correo');
    expect(campos).toContain('celular');
    expect(campos).toContain('direccion');
    expect(campos).toContain('ciudad');
    expect(campos).toContain('numero_documento');
    // El nombre NO se entrega (once columnas, ninguna es el nombre): declararlo haría que
    // `campos_accedidos` dejara de decir la verdad, que es lo único que ese registro tiene que hacer.
    expect(campos).not.toContain('nombre_completo');
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

  it('el limitador del export tiene bolsa PROPIA, distinta de la de la cola', () => {
    // Con una cuota compartida, gastar los cinco exports dejaría a la pantalla sin poder paginar y,
    // al revés, un visor abierto le comería la cuota al export. No se observa desde una petición.
    const fuente = fuenteDelRouter();
    expect(fuente).toContain("userOrIpKey('flito-soat-export')");
    expect(fuente).toContain("makeStore('rl:flito-soat-export:')");
  });
});
