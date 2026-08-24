// FLITO comparendos — export a Excel del consolidado filtrado (HU #11558, AC1..AC7, CF-07, ADR-0004).
//
// `POST /api/flito/comparendos/registros/export` es la única ruta del módulo que entrega un ARCHIVO,
// y eso cambia qué puede salir mal: una respuesta binaria no se equivoca «un poco», o es un `.xlsx`
// abrible con los datos correctos o es basura que el usuario abre y no entiende. Lo que se demuestra
// aquí, por orden de lo que costaría más caro si dejara de ser verdad:
//
//   1. **El 422 sale ANTES de que exista una cabecera de adjunto** (AC3 + AC4). El fallo que este
//      bloque caza no es «no responde 422», es «responde 422 con el `Content-Disposition` ya puesto»:
//      eso produce un archivo de 300 bytes con un JSON dentro, que el navegador guarda igual y el
//      usuario abre creyendo que se le corrompió la descarga. Se afirma por ausencia de la cabecera y
//      por que `sendExcel` no llegó a llamarse.
//   2. **El tope se comprueba con `tope + 1` y una sola lectura** (AC3). Un `count(*)` sobre el
//      filtro recorre 24 meses de histórico para decidir si se puede escribir un archivo, y además
//      obliga a consultar dos veces lo mismo. Se afirma sobre el `limit` real que recibió drizzle y
//      sobre cuántos SELECT tocaron la tabla.
//   3. **El archivo no lleva `payload_simit` ni `payload_municipal`** (AC2, RN-31/RN-42). La fila de
//      la fixture lleva una cédula centinela dentro de los payloads: se busca en el workbook entero,
//      así que cualquier proyección que se relaje —un `select()` sin lista blanca, un `Object.keys`
//      de la fila— se lee sola en el fallo.
//   4. **El rastro dice la verdad sobre lo que se llevó** (AC6): `accion='export'`, las filas
//      REALES, y `campos_accedidos` con la observación incluida. Registrar solo NIT y placa dejaría
//      un export de miles de observaciones de texto libre anotado como si no hubiera salido ninguna
//      —y los siete AC pasarían igual—.
//   5. **El export tiene su propio presupuesto** (AC5): 5/min, independiente de los 60/min de la
//      lectura, y un 422 también lo gasta (sondear el tamaño de un filtro no puede ser gratis).
//   6. **Nada de esto lo hace quien no es admin** (AC7, CF-12).
//
// El tope se baja por entorno a un número pequeño en vez de montar 5 000 filas de fixture: lo que se
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
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';

/** Tope de filas del export durante esta suite. Pequeño a propósito (ver cabecera). */
const TOPE = 3;

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'COMPARENDOS_EXPORT_MAX_FILAS') return TOPE;
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
 * El rastro se espía en el helper compartido, como en el resto de suites del módulo: lo que se fija
 * es el CONTRATO con `logPiiAccess`, no la fila que acaba en la tabla.
 */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

/**
 * `sendExcel` se envuelve, **no se sustituye**: el archivo que se afirma en el AC2 es el de verdad,
 * generado por `exceljs` con el estilo de cabecera de `shared/utils/excel.ts`. Lo único que añade el
 * envoltorio es dejar constancia de CUÁNDO se llamó, que es la mitad del AC4 —el registro de acceso
 * va antes de escribir el primer byte— y no se puede observar desde la respuesta.
 */
const orden: string[] = [];
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

const espia = crearEspia(kdb);

/**
 * Las columnas del archivo, importadas DESPUÉS de los mocks (el servicio lee `env` y `db`).
 *
 * Se traen de producción y no se copian aquí: una lista duplicada en el test acabaría afirmando
 * contra sí misma el día que alguien cambie una y no la otra.
 */
const { COLUMNAS_EXPORT: COLUMNAS } = await import(
  '../../src/modules/flito-comparendos/flito-comparendos.export.service.js'
);

const BASE = '/api/flito/comparendos';
const RUTA = `${BASE}/registros/export`;
const REGISTROS = `${BASE}/registros`;
const TABLA = 'flito_comparendos_registros';

const AHORA = new Date('2026-08-19T14:00:00.000Z');
const ANTES = new Date('2026-08-12T09:00:00.000Z');

const NIT = '900123456';
const PLACA = 'ABC123';
/**
 * Observación de la fixture. **No contiene el nombre de la causal, y es deliberado**: con un texto
 * como «Acuerdo de pago con el propietario…», un `expect(texto).toContain('Acuerdo de pago')` sobre
 * el workbook entero queda satisfecho por la columna Observación y sigue verde aunque la columna
 * Causal salga vacía. Las dos se afirman por CELDA, además, para que ninguna se apoye en la otra.
 */
const OBSERVACION = 'Se pactó abono del 50% con el titular, primera cuota el 30 de agosto';
/** Nombre de la causal en el catálogo. Ninguna otra celda de la fila lo repite. */
const CAUSAL_NOMBRE = 'Retención en la fuente';
/** Dato personal que vive en los payloads crudos y que NINGUNA celda del archivo puede llevar. */
const CEDULA_EN_PAYLOAD = 'cedula-del-propietario-1032456789';

/**
 * Fila tal como la traería la base **sin proyectar**: con los dos payloads dentro y con el nombre de
 * la causal que aporta el `LEFT JOIN`. Los payloads están aquí a propósito (punto 3 de la cabecera).
 */
const fila = (over: Record<string, unknown> = {}) => ({
  numeroComparendo: '05001000000012345678',
  placa: PLACA,
  nitMonitoreado: NIT,
  fechaComparendo: '2026-06-02',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en sitio prohibido',
  municipioFuente: 'BELLO',
  organismo: 'Secretaría de Movilidad de Bello',
  monto: '604100.00',
  estado: 'activo',
  estadoFuente: 'PENDIENTE',
  // HU #11712. La fixture base es una MULTA (tipo y resolución puestos) para que el caso del `null`
  // —el histórico— tenga que pedirse explícitamente y no se cuele por descuido de la fixture.
  tipoRegistro: 'multa',
  numeroResolucion: 'RES-2026-4471',
  origenMerge: 'ambos',
  causalNombre: CAUSAL_NOMBRE,
  observacion: OBSERVACION,
  gestionActualizadaEn: AHORA,
  gestionActualizadaPor: 42,
  primeraVistoEn: ANTES,
  ultimoVistoEn: AHORA,
  inactivadoEn: null,
  payloadSimit: { propietario: { documento: CEDULA_EN_PAYLOAD } },
  payloadMunicipal: { deudor: CEDULA_EN_PAYLOAD },
  ...over,
});

/** N filas distinguibles por su número de comparendo. */
const filas = (n: number) => Array.from({ length: n }, (_, i) => fila({
  numeroComparendo: `0500100000001234567${i}`,
}));

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

/**
 * Una sesión con `sub` nuevo cada vez.
 *
 * El limitador del export cuenta **5 por minuto y usuario** y su ventana no se reinicia entre tests:
 * con un `sub` compartido, el tercer caso del archivo empezaría a ver 429 que no tienen nada que ver
 * con lo que se está probando. Cada `it` pide el suyo; los que hacen varias peticiones con el mismo
 * usuario guardan la cabecera y la reutilizan.
 */
let siguienteSub = 7500;
const sesion = async (role: TestRole = 'admin'): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const exportar = async (cabecera: string, query = '', cuerpo: unknown = {}) =>
  request(await buildApp())
    .post(`${RUTA}${query}`)
    .set('Authorization', cabecera)
    .responseType('blob')
    .send(cuerpo as object);

// ── Espías de la consulta ────────────────────────────────────────────────────────────────────────

/**
 * Proyección, `limit` y `WHERE` de cada SELECT, por tabla.
 *
 * El `where` se guarda en crudo y se serializa con `PgDialect` al afirmarlo. Es la única forma de
 * ver QUÉ columnas y qué operadores entraron en la consulta: el mock ignora el filtro y devuelve lo
 * que el test registró, así que sin esto un export que se dejara filtros por el camino devolvería
 * las mismas filas de la fixture y ningún aserto se enteraría. `espia.filtrosUsados()` no alcanza
 * —solo recoge valores enlazados de tipo texto, y ni el `like` ni los booleanos aparecen ahí—.
 */
const consultas: {
  tabla: string;
  columnas: string[];
  limit: number | null;
  where: unknown;
}[] = [];

function instalarEspias(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const consulta = { tabla: '__sin_from__', columnas, limit: null as number | null, where: null as unknown };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => {
      consulta.tabla = nombre(tbl);
      consultas.push(consulta);
      return from(tbl);
    };
    const limit = chain.limit as (n: number) => unknown;
    chain.limit = (n: number) => { consulta.limit = n; return limit(n); };
    const where = chain.where as (c: unknown) => unknown;
    chain.where = (cond: unknown) => { consulta.where = cond; return where(cond); };
    return chain;
  });
}

/** El `WHERE` de la única lectura del consolidado, ya en SQL y con sus parámetros. */
function whereDelExport(): { sql: string; params: unknown[] } {
  const lecturas = consultasDelConsolidado();
  expect(lecturas).toHaveLength(1);
  expect(lecturas[0].where).not.toBeNull();
  return new PgDialect().sqlToQuery(lecturas[0].where as never);
}

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

const consultasDelConsolidado = () => consultas.filter((c) => c.tabla === TABLA);

/** El workbook de la respuesta, ya parseado. */
async function libro(cuerpo: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(cuerpo);
  const hoja = wb.worksheets[0];
  expect(hoja).toBeDefined();
  return hoja!;
}

/**
 * El valor de una celda por CLAVE de columna.
 *
 * Afirmar sobre `textoDe(hoja)` sirve para lo que no puede estar en ninguna parte (un payload), pero
 * no para lo que tiene que estar EN SU SITIO: una columna vacía pasa desapercibida en cuanto otra
 * celda de la fila contiene un texto parecido.
 */
function celda(hoja: ExcelJS.Worksheet, nFila: number, clave: string): unknown {
  const indice = COLUMNAS.findIndex((c) => c.key === clave);
  expect(indice, `la columna \`${clave}\` ya no existe en COLUMNAS_EXPORT`).toBeGreaterThanOrEqual(0);
  return hoja.getRow(nFila).getCell(indice + 1).value;
}

/** Todo el texto del workbook, para buscar lo que NO puede estar. */
function textoDe(hoja: ExcelJS.Worksheet): string {
  const partes: string[] = [];
  hoja.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (celda) => partes.push(String(celda.value ?? '')));
  });
  return partes.join('');
}

const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

/**
 * El código del router, leído de disco.
 *
 * Dos hechos de esta HU no se pueden observar desde una petición —que no exista un `GET` del export
 * y que cada limitador tenga su propio namespace de cuota— y los dos importan en producción. Se lee
 * el archivo en vez de importarlo: importarlo arrastraría media API y sus efectos de arranque.
 */
function fuenteDelRouter(): string {
  return readFileSync(
    fileURLToPath(new URL('../../src/modules/flito-comparendos/flito-comparendos.routes.ts', import.meta.url)),
    'utf8',
  );
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  instalarEspias();
  logPiiAccessMock.mockClear();
  consultas.length = 0;
  orden.length = 0;
});

// ─────────────────────────── AC1 · POST, nunca GET ──────────────────────────────────────────────

describe('AC1 — el export es un POST con los filtros de identidad en el cuerpo', () => {
  it('responde 200 con el content-type de xlsx y un adjunto con nombre', async () => {
    kdb.when.select(TABLA, filas(2));

    const r = await exportar(await sesion(), '?estado=activo', { nit: NIT });

    expect(r.status).toBe(200);
    expect(r.headers['content-type'])
      .toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Adjunto, y con marca de tiempo en el nombre: tres descargas seguidas no se llaman igual.
    expect(r.headers['content-disposition'])
      .toMatch(/^attachment; filename="comparendos_\d{8}-\d{4}\.xlsx"$/);
  });

  it('el NIT del cuerpo llega a la consulta normalizado, sin pasar por la URL', async () => {
    kdb.when.select(TABLA, filas(1));

    const r = await exportar(await sesion(), '', { nit: '900.123.456', placa: 'abc-123' });

    expect(r.status).toBe(200);
    // El mismo normalizador con el que se guardó (RN-33): sin esto, «900.123.456» no encontraría
    // nada y el archivo saldría vacío sin que nadie lo notara.
    expect(espia.filtrosUsados()).toContain(NIT);
    expect(espia.filtrosUsados()).toContain(PLACA);
  });

  it('un NIT en la QUERY es 400 y no una consulta que funciona (AGENTS.md §14)', async () => {
    const r = await exportar(await sesion(), `?nit=${NIT}`);

    expect(r.status).toBe(400);
    // Y no se llegó a mirar la base: el 400 lo pone el `.strict()` del esquema.
    expect(consultasDelConsolidado()).toHaveLength(0);
  });

  it('`limit` y `cursor` son 400: un export no pagina', async () => {
    const cabecera = await sesion();

    // **`limit=25` es el caso que prueba algo.** `?limit=200` sería 400 aunque el `.omit()`
    // desapareciera —200 excede el `.max(50)` del esquema base— y `?cursor=abc` lo sería por no
    // decodificar: los dos pasan sin el `.omit()`. Un valor DENTRO del rango del listado solo puede
    // ser 400 si el export lo rechaza por su cuenta; sin el `.omit()` respondería 200 ignorando el
    // parámetro en silencio, que es justo lo que el contrato promete que no ocurre.
    expect((await exportar(cabecera, '?limit=25')).status).toBe(400);
    expect((await exportar(cabecera, '?limit=200')).status).toBe(400);
    expect((await exportar(cabecera, '?cursor=abc')).status).toBe(400);
  });

  it('el router no declara ninguna variante GET del export', () => {
    const fuente = fuenteDelRouter();

    // Cualquier `router.get('…export…')` volvería a poner el NIT y la placa en la URL —que es lo
    // único que este endpoint existe para evitar— y lo haría sin romper ningún otro test.
    expect(fuente).not.toMatch(/router\.get\(\s*'[^']*export/);
    expect(fuente).toMatch(/router\.post\(\s*'\/registros\/export'/);
  });
});

// ─────────────────────────── AC2 · Contenido del archivo ────────────────────────────────────────

describe('AC2 — una fila por registro, las columnas del visor, sin payloads', () => {
  it('trae encabezado con estilo, una fila por registro y las columnas de gestión', async () => {
    kdb.when.select(TABLA, filas(2));

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    // Encabezado en la primera fila, con el estilo de `shared/utils/excel.ts` (negrita + relleno).
    const encabezado = hoja.getRow(1);
    expect(encabezado.font?.bold).toBe(true);
    expect((encabezado.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FF1F2937');

    const cabeceras = (encabezado.values as unknown[]).slice(1).map(String);
    expect(cabeceras).toEqual(COLUMNAS.map((c) => c.header));
    // Las tres que el AC nombra por su nombre.
    expect(cabeceras).toContain('Causal');
    expect(cabeceras).toContain('Observación');
    expect(cabeceras).toContain('Última gestión');

    // La cabecera del estado de MONITOREO se escribe literal y no derivada de `COLUMNAS`: el aserto
    // de arriba compara el archivo contra la constante y pasaría igual con las dos renombradas a la
    // vez, que es exactamente lo que esta HU no puede permitir. La pantalla dejó de llamarla
    // «Estado» (HU #11713) y el archivo tiene que decir lo mismo, porque el operador filtra por
    // nombre de columna en Excel con la pantalla al lado.
    expect(cabeceras).toContain('Monitoreo');
    expect(cabeceras).toContain('Estado en la fuente');
    // Y «Estado» a secas NO puede volver: junto a «Estado en la fuente» son dos columnas cuya
    // primera palabra es la misma y que hablan de cosas distintas.
    expect(cabeceras).not.toContain('Estado');

    // Una fila por registro y ni una de más: el encabezado no cuenta.
    expect(hoja.rowCount).toBe(3);
    expect(hoja.actualRowCount).toBe(3);

    const texto = textoDe(hoja);
    expect(texto).toContain('05001000000012345670');
    expect(texto).toContain('05001000000012345671');
  });

  it('trae «Tipo» y «N.º resolución», y el tipo sale traducido (HU #11712)', async () => {
    kdb.when.select(TABLA, filas(1));

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'tipoRegistro')).toBe('Multa');
    expect(celda(hoja, 2, 'numeroResolucion')).toBe('RES-2026-4471');
  });

  it('**un tipo NULO deja la celda VACÍA, nunca «Comparendo»** (HU #11712)', async () => {
    // El mutante de la HU: rellenar el hueco con la palabra convertiría todo el histórico anterior a
    // la 0160 en un dato verificado, dentro de un archivo que sale del perímetro y que alguien va a
    // conciliar. `null` es «no se sabe», y de las filas `inactivo` nadie va a volver a saberlo.
    kdb.when.select(TABLA, [fila({ tipoRegistro: null, numeroResolucion: null })]);

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'tipoRegistro') ?? null).toBeNull();
    expect(textoDe(hoja)).not.toContain('Comparendo');
    // Y la fila sí está: el test no pasa por no haber traído nada.
    expect(celda(hoja, 2, 'numeroComparendo')).toBe('05001000000012345678');
  });

  it('el `id_resolucion` no existe como columna del archivo', async () => {
    // Es un identificador de sistema del proveedor: no se publica en el API y tampoco aquí.
    expect(COLUMNAS.map((c) => c.key)).not.toContain('idResolucion');
    expect(COLUMNAS.map((c) => c.header.toLowerCase())).not.toContain('id resolución');
  });

  it('la causal sale por NOMBRE y la última gestión en hora de Colombia', async () => {
    kdb.when.select(TABLA, filas(1));

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    // **Por celda y no por `textoDe(hoja)`**: una columna Causal vacía pasaría desapercibida si otra
    // celda de la fila contuviera un texto parecido —que es exactamente lo que ocurría cuando la
    // observación de la fixture empezaba por el nombre de la causal—. Y un archivo cuya columna
    // Causal fuera el UUID cumpliría el AC leído literal sin servir para conciliar con nadie.
    expect(celda(hoja, 2, 'causal')).toBe(CAUSAL_NOMBRE);
    expect(celda(hoja, 2, 'observacion')).toBe(OBSERVACION);
    // 14:00 UTC son las 09:00 en Colombia. En UTC el archivo diría que la gestión fue cinco horas
    // más tarde, y nada dentro del `.xlsx` delataría la zona.
    expect(celda(hoja, 2, 'gestionActualizadaEn')).toBe('2026-08-19 09:00');
    // El monto va como NÚMERO para poder sumarse en la hoja, no como el texto del JSON.
    expect(celda(hoja, 2, 'monto')).toBe(604100);
    // Y el NIT y la placa siguen en su columna: son las dos que el rastro declara.
    expect(celda(hoja, 2, 'nitMonitoreado')).toBe(NIT);
    expect(celda(hoja, 2, 'placa')).toBe(PLACA);
  });

  it('**no lleva `payload_simit` ni `payload_municipal` en ninguna celda (RN-31)**', async () => {
    kdb.when.select(TABLA, filas(2));

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    expect(textoDe(hoja)).not.toContain(CEDULA_EN_PAYLOAD);
    // Y la garantía de verdad: la consulta ni los pide. Lo que no sale de la base no se puede
    // publicar por descuido más arriba.
    const proyeccion = consultasDelConsolidado()[0]?.columnas ?? [];
    expect(proyeccion.length).toBeGreaterThan(0);
    expect(proyeccion).not.toContain('payloadSimit');
    expect(proyeccion).not.toContain('payloadMunicipal');
  });

  it('un filtro sin resultados es un archivo de solo encabezado, no un 404', async () => {
    kdb.when.select(TABLA, []);

    const r = await exportar(await sesion(), '?estado=inactivo');
    const hoja = await libro(r.body as Buffer);

    expect(r.status).toBe(200);
    expect(hoja.actualRowCount).toBe(1);
    // Una consulta ejecutada es un acceso, aunque no devuelva nada: mismo criterio que el listado.
    expect(ultimoAcceso().motivo).toContain('filas=0');
  });
});

// ─────────────────────────── AC3 · Tope de filas ────────────────────────────────────────────────

describe('AC3 — el tope se comprueba con tope+1 y responde 422', () => {
  it('exactamente el tope se entrega entero', async () => {
    kdb.when.select(TABLA, filas(TOPE));

    const r = await exportar(await sesion());
    const hoja = await libro(r.body as Buffer);

    expect(r.status).toBe(200);
    expect(hoja.actualRowCount).toBe(TOPE + 1);
  });

  it('una fila por encima del tope es 422 `export_demasiado_grande` con mensaje accionable', async () => {
    kdb.when.select(TABLA, filas(TOPE + 1));

    const r = await exportar(await sesion());
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8'));

    expect(r.status).toBe(422);
    expect(cuerpo.codigo).toBe('export_demasiado_grande');
    // El mensaje tiene que decir qué hacer, no solo que no se pudo.
    expect(cuerpo.error).toMatch(/acota/i);
    // Y no dice cuántas filas hay: el 422 no puede convertirse en un contador de registros por NIT.
    expect(cuerpo.error).not.toMatch(new RegExp(String(TOPE + 1)));
  });

  it('**pide tope+1 filas en UNA sola lectura y sin `count` sobre la tabla**', async () => {
    kdb.when.select(TABLA, filas(TOPE + 1));

    await exportar(await sesion());

    const lecturas = consultasDelConsolidado();
    // Un `count(*)` sobre el filtro recorrería 24 meses de histórico para decidir si se escribe un
    // archivo, y obligaría a consultar dos veces lo mismo.
    expect(lecturas).toHaveLength(1);
    expect(lecturas[0].limit).toBe(TOPE + 1);
    expect(lecturas[0].columnas.join(' ')).not.toMatch(/count/i);
  });
});

// ─────────────────────────── AC4 · Orden de la respuesta ────────────────────────────────────────

describe('AC4 — validar, contar, y solo entonces cabeceras y archivo', () => {
  it('**el 422 sale sin cabecera de adjunto y sin haber escrito un byte**', async () => {
    kdb.when.select(TABLA, filas(TOPE + 1));

    const r = await exportar(await sesion());

    expect(r.status).toBe(422);
    expect(r.headers['content-type']).toContain('application/json');
    // Lo que se está cazando: un `Content-Disposition` puesto antes de saber el tamaño produce un
    // `.xlsx` con un JSON de error dentro, que el navegador guarda igual.
    expect(r.headers['content-disposition']).toBeUndefined();
    // Y no se llegó a `sendExcel`: no hay archivo, ni truncado ni de ningún tipo.
    expect(orden).toEqual([]);
  });

  it('**el 422 NO deja un rastro de export, pero sí deja rastro**', async () => {
    kdb.when.select(TABLA, filas(TOPE + 1));

    const r = await exportar(await sesion(), '?estado=activo', { nit: NIT });

    expect(r.status).toBe(422);
    // La mitad que exige el AC4: nada de `accion='export'`, porque no se exportó nada. Contarlo
    // como export inflaría los agregados de privacidad con filas que nunca salieron.
    const acciones = logPiiAccessMock.mock.calls.map((c) => (c[1] as { accion: string }).accion);
    expect(acciones).not.toContain('export');
    // La otra mitad, que es la que se pasa por alto: la consulta CORRIÓ —tope+1 filas con su NIT y
    // su placa entraron al proceso— y, sobre todo, ADR-0004 promete recalibrar el tope leyendo este
    // log dentro de dos o tres meses. Si los exports que chocan con el tope no se escriben, la
    // muestra queda amputada justo en la cola que se quiere medir y el ADR concluiría que nadie se
    // acerca a 5 000 porque los que lo pasan son invisibles.
    expect(acciones).toEqual(['search']);
    const acceso = ultimoAcceso();
    expect(acceso.motivo).toContain('filas=0');
    // El marcador va delante de los filtros: `motivo` es varchar(200) y se recorta por el final.
    expect(acceso.motivo).toContain('resultado=export_demasiado_grande');
    expect(acceso.motivo).toContain('estado=activo');
    // Sigue sin escribirse el NIT en claro, y sigue sin revelarse el conteo: el `tope + 1` existe
    // para no calcularlo, así que esta fila no dice cuántos comparendos tiene el filtro.
    expect(acceso.motivo).not.toContain(NIT);
    expect(acceso.motivo).not.toMatch(new RegExp(`filas=${TOPE + 1}`));
  });

  it('en el 200, el registro de acceso se escribe ANTES del archivo', async () => {
    kdb.when.select(TABLA, filas(1));
    logPiiAccessMock.mockImplementation(async () => { orden.push('pii'); });

    const r = await exportar(await sesion());

    expect(r.status).toBe(200);
    // Un rastro escrito después del `write` se pierde entero si el proceso muere a mitad del
    // archivo, y esta petición vale hasta 5 000 NITs y placas.
    expect(orden).toEqual(['pii', 'excel']);
    logPiiAccessMock.mockImplementation(async () => undefined);
  });
});

// ─────────────────────────── AC5 · Limitador propio ─────────────────────────────────────────────

describe('AC5 — 5 exports por minuto y usuario, con cuota propia', () => {
  it('el sexto export del minuto es 429', async () => {
    kdb.when.select(TABLA, filas(1));
    const cabecera = await sesion();

    for (let i = 0; i < 5; i++) {
      expect((await exportar(cabecera)).status).toBe(200);
    }

    expect((await exportar(cabecera)).status).toBe(429);
  });

  it('un 422 también gasta cuota: sondear el tamaño de un filtro no es gratis', async () => {
    kdb.when.select(TABLA, filas(TOPE + 1));
    const cabecera = await sesion();

    for (let i = 0; i < 5; i++) {
      expect((await exportar(cabecera)).status).toBe(422);
    }

    expect((await exportar(cabecera)).status).toBe(429);
  });

  it('agotar la cuota del VISOR no impide exportar: el eje inverso', async () => {
    kdb.when.select(TABLA, []);
    const cabecera = await sesion();
    const app = await buildApp();

    // 60 páginas es la cuota entera de la lectura interactiva. Sin cuotas separadas, quien haya
    // estado trabajando la tabla un rato descubriría que ya no puede descargar lo que está viendo —
    // y el mensaje que recibiría hablaría de «consultas», no de exports.
    for (let i = 0; i < 60; i++) {
      await request(app).get(REGISTROS).set('Authorization', cabecera);
    }
    expect((await request(app).get(REGISTROS).set('Authorization', cabecera)).status).toBe(429);

    kdb.when.select(TABLA, filas(1));
    expect((await exportar(cabecera)).status).toBe(200);
  });

  it('**cada limitador tiene su propio namespace de cuota (el eje que el runtime no enseña)**', async () => {
    const fuente = fuenteDelRouter();

    // Por qué esto es análisis estático y no una petición más: sin Redis, `makeStore()` devuelve
    // `undefined` y `express-rate-limit` le da a CADA limitador su propio `MemoryStore`, así que
    // darle al export la llave del listado seguiría saliendo verde en toda la suite. En producción
    // hay Redis y esos prefijos SON la separación: dos limitadores que compartan namespace comparten
    // contador, y entonces las cuotas dejan de ser dos.
    const llaves = [...fuente.matchAll(/userOrIpKey\('([^']+)'\)/g)].map((m) => m[1]);
    const stores = [...fuente.matchAll(/makeStore\('([^']+)'\)/g)].map((m) => m[1]);

    expect(llaves).toContain('flito-comparendos-export');
    expect(stores).toContain('rl:flito-comparendos-export:');
    // La regla, no el valor: ningún limitador del módulo puede repetir el namespace de otro.
    expect(new Set(llaves).size).toBe(llaves.length);
    expect(new Set(stores).size).toBe(stores.length);
    // Y hay más de uno, para que la aserción anterior no sea trivialmente cierta.
    expect(llaves.length).toBeGreaterThan(1);
  });

  it('agotar la cuota del export no deja sin paginar al visor: son dos presupuestos', async () => {
    kdb.when.select(TABLA, filas(1));
    const cabecera = await sesion();
    const app = await buildApp();

    for (let i = 0; i < 6; i++) await exportar(cabecera);

    // El listado devuelve el DTO completo, con columnas que el export no proyecta: se le da su
    // propia respuesta —vacía— en vez de reutilizar la fila del archivo, que le faltarían campos.
    kdb.when.select(TABLA, []);

    // Con una cuota compartida, el usuario vería la tabla romperse por haber descargado.
    const listado = await request(app).get(REGISTROS).set('Authorization', cabecera);
    expect(listado.status).toBe(200);
  });
});

// ─────────────────────────── AC6 · Trazabilidad ─────────────────────────────────────────────────

describe('AC6 — el rastro dice qué se llevó y cuánto', () => {
  it('registra `export`, el recurso, los campos personales y las filas entregadas', async () => {
    kdb.when.select(TABLA, filas(2));

    const r = await exportar(await sesion(), '?estado=activo', { nit: NIT });

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('export');
    expect(acceso.resourceTipo).toBe('flito_comparendos_registro');
    // `filas=N` es lo que distingue «miró una» de «se llevó cinco mil», y es la materia prima con la
    // que se decidirá si hace falta un tope diario.
    expect(acceso.motivo).toContain('filas=2');
    expect(acceso.motivo).toContain('estado=activo');
    // El NIT del filtro va ENMASCARADO: el rastro de quién miró un dato no puede escribir el dato.
    expect(acceso.motivo).not.toContain(NIT);
  });

  it('**declara la observación además del NIT y la placa, y no declara los payloads**', async () => {
    kdb.when.select(TABLA, filas(1));

    await exportar(await sesion());

    const campos = ultimoAcceso().camposAccedidos as string[];
    // El archivo lleva observaciones de texto libre —el único campo que redacta una PERSONA—, así
    // que `campos_accedidos` tiene que decirlo. Declarar solo NIT y placa dejaría un export de miles
    // de observaciones anotado como si no hubiera salido ninguna.
    expect(campos).toEqual(expect.arrayContaining(['nit_monitoreado', 'placa', 'observacion']));
    // Y declarar de más también sería mentir: los payloads no salen en el archivo.
    expect(campos).not.toContain('payload_simit');
    expect(campos).not.toContain('payload_municipal');
  });

  it('la respuesta sale con `Cache-Control: no-store`', async () => {
    kdb.when.select(TABLA, filas(1));

    const r = await exportar(await sesion());

    expect(r.headers['cache-control']).toBe('no-store');
  });
});

// ─────────────────────────── AC7 · Permisos ─────────────────────────────────────────────────────

describe('AC7 — solo admin exporta', () => {
  it('un rol sin permiso recibe 403 y no se genera ningún archivo', async () => {
    kdb.when.select(TABLA, filas(1));

    const r = await exportar(await sesion('auditor'));

    expect(r.status).toBe(403);
    expect(orden).toEqual([]);
    expect(consultasDelConsolidado()).toHaveLength(0);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('sin sesión no se llega ni al limitador', async () => {
    const r = await request(await buildApp()).post(RUTA).send({});

    expect(r.status).toBe(401);
    expect(consultasDelConsolidado()).toHaveLength(0);
  });
});

// ─────────────────────────── Reutilización del filtro (HU #11555) ───────────────────────────────

describe('el export filtra igual que el visor', () => {
  it('**los SEIS filtros del visor llegan al WHERE, no solo el NIT y la placa**', async () => {
    kdb.when.select(TABLA, filas(1));
    const CAUSAL = '22222222-2222-4222-8222-222222222222';

    const r = await exportar(
      await sesion(),
      `?estado=activo&municipio=itagui&fuente=simit&causalId=${CAUSAL}&q=12345`,
      { nit: '900.123.456', placa: 'abc-123' },
    );
    expect(r.status).toBe(200);

    const { sql, params } = whereDelExport();

    // Qué se está cazando: un export que ignorara los filtros de la pantalla entregaría hasta 5 000
    // filas con NIT, placa y observación a quien había filtrado por municipio — con los siete AC en
    // verde y un `pii_access_log` que parecería veraz, porque el motivo anota los filtros PEDIDOS,
    // no los aplicados. La fixture del mock devuelve lo mismo se filtre o no, así que ninguna
    // aserción sobre el contenido del archivo puede ver esto: solo el WHERE real lo demuestra.
    expect(sql).toContain('"estado"');
    expect(sql).toContain('"municipio_fuente"');
    expect(sql).toContain('"origen_merge"');
    expect(sql).toContain('"causal_id"');
    expect(sql).toContain('"numero_comparendo"');
    expect(sql).toContain('"nit_monitoreado"');
    expect(sql).toContain('"placa"');

    // Los valores, ya normalizados por el MISMO normalizador con el que se guardaron: «itagui» tiene
    // que buscar «ITAGUI» y «900.123.456» buscar «900123456», o el archivo saldría vacío sin que
    // nadie lo notara. El `%…%` del número es la búsqueda por contenido del listado (RN-33).
    expect(params).toEqual(expect.arrayContaining([
      'activo', 'ITAGUI', 'simit', CAUSAL, '900123456', 'ABC123', '%12345%',
    ]));
    // Ni uno de más: un filtro que se colara sin estar en el visor cambiaría el conjunto exportado.
    expect(params).toHaveLength(7);
  });

  it('`sinCausal` viaja como `IS NULL`, que es la cola de trabajo de la pantalla', async () => {
    kdb.when.select(TABLA, filas(1));

    const r = await exportar(await sesion(), '?sinCausal=true');
    expect(r.status).toBe(200);

    const { sql, params } = whereDelExport();
    // No es una comparación contra vacío —la columna es `uuid`—, y no lleva parámetro: si alguien lo
    // tradujera a `causal_id = ''` reventaría en producción y aquí, con el mock, pasaría de largo.
    expect(sql.toLowerCase()).toContain('"causal_id" is null');
    expect(params).toHaveLength(0);
  });

  it('sin ningún filtro no se inventa un WHERE: el export es de todo el consolidado', async () => {
    kdb.when.select(TABLA, filas(1));

    await exportar(await sesion());

    // El otro lado del caso anterior: un `WHERE` fantasma —un `estado = 'activo'` por defecto, por
    // ejemplo— haría que el archivo no contuviera lo que la pantalla muestra sin filtros.
    expect(consultasDelConsolidado()[0].where).toBeUndefined();
  });

  it('una placa que al normalizar no deja nada devuelve un archivo VACÍO, no la tabla entera', async () => {
    // `placaFiltroSchema` acepta «- -» (tres caracteres del alfabeto permitido) y `placaCanonica` lo
    // reduce a `null`. Ignorar el filtro ahí entregaría hasta 5 000 NITs y placas a quien pidió UN
    // vehículo, y pasaría todos los demás AC sin despeinarse.
    kdb.when.select(TABLA, filas(2));

    const r = await exportar(await sesion(), '', { placa: '- -' });
    const hoja = await libro(r.body as Buffer);

    expect(r.status).toBe(200);
    expect(hoja.actualRowCount).toBe(1);
    expect(consultasDelConsolidado()).toHaveLength(0);
    expect(ultimoAcceso().motivo).toContain('filas=0');
  });

  it('`causalId` y `sinCausal` a la vez son 400, igual que en el listado', async () => {
    const r = await exportar(
      await sesion(),
      '?causalId=22222222-2222-4222-8222-222222222222&sinCausal=true',
    );

    expect(r.status).toBe(400);
  });
});
