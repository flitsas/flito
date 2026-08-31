// FLITO Impuestos — export a Excel de la cola filtrada (Feature #11908, HU #11909).
//
// Gemelo de `flito-soat-export.test.ts` y con la misma doctrina: lo que se afirma es el WORKBOOK
// REAL, no la constante que lo generó. Las diferencias con el de SOAT son las que hacen que este
// archivo exista aparte y no sea una copia:
//
//   · **CIUDAD sale del `innerJoin` con `flito_tramites`**, porque `flito_impuestos.tramite_id` es
//     NOT NULL y UNIQUE: un impuesto tiene un trámite y solo uno. En SOAT hay que reconciliar.
//   · **Los tres datos técnicos del vehículo (HU #11906) NO estaban en la proyección de esta cola.**
//     El DTO de Impuestos no los publica y el archivo sí los pide, así que aquí se comprueba que se
//     leen — el defecto probable de esta mitad de la HU es copiarse la proyección del listado y
//     entregar CARROCERIA, TIPO DE SERVICIO y CILINDRAJE vacías en todas las filas.
//   · **El módulo no registraba NINGÚN acceso a PII** (`grep -c logPiiAccess` daba 0 en sus ocho
//     archivos). Aquí se fija que ahora lo hacen las dos lecturas: el export y el `GET /`.
//   · **El rol que sobra es `auditor`** (aquí no hay `cliente`: el canal es de SOAT).
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
const TRAMITE_A = '33333333-3333-3333-3333-333333333333';

const PLACA = 'KLM45N';
const VIN = '9BWZZZ377VT004251';
const CEDULA = '5060708090';

const CENTINELA_NOMBRE = 'CENTINELA-NOMBRE-PROPIETARIO';
const CENTINELA_MOTIVO = 'CENTINELA-MOTIVO-RECHAZO';

/** Fila de `flito_impuestos` × joins, tal como la traería la base SIN proyectar. */
const filaImpuesto = (over: Record<string, unknown> = {}) => ({
  id: IMPUESTO_A,
  tramiteId: TRAMITE_A,
  placa: PLACA,
  vin: VIN,
  ciudad: 'MOSQUERA',
  carroceria: 'FURGON',
  tipoServicio: 'Publico',
  cilindraje: '2400',
  organismoAlias: 'MOSQUERA',
  organismoCodigo: '25473',
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
  nombreCompleto: CENTINELA_NOMBRE,
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
  tabla: string; columnas: string[]; limit: number | null; offset: number | null; where: unknown;
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
 * Las once cabeceras ESCRITAS A MANO, igual que en la suite de SOAT.
 *
 * Se repiten a propósito en los dos archivos en vez de sacarlas a un helper compartido: si vivieran
 * en un solo sitio, ese sitio sería una segunda constante de producción disfrazada de test y las dos
 * suites podrían romperse a la vez con una sola edición. El AC1 dice «exactamente estas once» de
 * cada archivo, y cada archivo lo afirma por su cuenta.
 */
const CABECERAS = [
  'PLACA', 'CEDULA', 'CORREO', 'TELEFONO', 'DIRECCION', 'VIN', 'CIUDAD',
  'CARROCERIA', 'TIPO DE SERVICIO', 'CILINDRAJE', 'ORGANISMO DE TRANSITO',
];

const cabecerasDe = (hoja: ExcelJS.Worksheet): string[] =>
  (hoja.getRow(1).values as unknown[]).slice(1).map(String);

function celda(hoja: ExcelJS.Worksheet, nFila: number, cabecera: string): unknown {
  const indice = CABECERAS.indexOf(cabecera);
  expect(indice, `la cabecera «${cabecera}» no está en la lista del AC1`).toBeGreaterThanOrEqual(0);
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

describe('AC1 — el archivo tiene EXACTAMENTE once columnas, en su orden', () => {
  it('las once cabeceras, en MAYÚSCULAS y sin tildes, y `columnCount === 11`', async () => {
    kdb.when.scenario({ flito_impuestos: filas(2), flito_compradores: [] });

    const r = await exportar(await sesion());
    expect(r.status).toBe(200);
    const hoja = await libro(r.body as Buffer);

    expect(cabecerasDe(hoja)).toEqual(CABECERAS);
    expect(hoja.columnCount).toBe(11);
  });

  it('NO existe una columna `MUNICIPIO`, ni `NOMBRE`, ni ninguna de fecha', async () => {
    kdb.when.scenario({ flito_impuestos: filas(1), flito_compradores: [] });

    const cabeceras = cabecerasDe(await libro((await exportar(await sesion())).body as Buffer));

    expect(cabeceras).not.toContain('MUNICIPIO');
    expect(cabeceras).not.toContain('NOMBRE');
    expect(cabeceras.filter((h) => /CREAD|FECHA/.test(h))).toEqual([]);
  });

  it('**los tres datos técnicos del vehículo salen con su valor** (HU #11906)', async () => {
    // El DTO de esta cola NO los publica, así que el defecto probable es copiarse la proyección del
    // listado: el archivo saldría con CARROCERIA, TIPO DE SERVICIO y CILINDRAJE vacías en TODAS las
    // filas, se abriría sin quejarse y los asertos de cabeceras pasarían igual.
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'CARROCERIA')).toBe('FURGON');
    expect(celda(hoja, 2, 'TIPO DE SERVICIO')).toBe('Publico');
    expect(celda(hoja, 2, 'CILINDRAJE')).toBe('2400');
    // Y la ciudad, que aquí es directa (1:1 con el trámite) y no reconciliada como en SOAT.
    expect(celda(hoja, 2, 'CIUDAD')).toBe('MOSQUERA');
  });
});

// ─────────────────────────── Lista blanca ────────────────────────────────────────────────────────

describe('lista blanca — el archivo lleva lo que la lista dice y la consulta no pide más', () => {
  it('el nombre del propietario ni se consulta ni aparece en el buffer', async () => {
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

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
      users: [{ t: '25473' }],
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

  it('un gestor SIN organismo descarga un archivo VACÍO, no la tabla entera', async () => {
    // `condicionesColaImpuestos` devuelve `null` cuando no hay frontera que aplicar. El defecto que
    // esto mata es tratar ese `null` como «sin filtros»: la fixture tiene filas y no pueden salir.
    kdb.when.scenario({
      users: [{ t: null }],
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
  it('sin correo, sin cilindraje y sin ciudad: tres celdas vacías y el resto con su valor', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ cilindraje: null, ciudad: null })],
      flito_compradores: [comprador({ correo: null })],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);

    expect(celda(hoja, 2, 'CORREO') ?? null).toBeNull();
    expect(celda(hoja, 2, 'CILINDRAJE') ?? null).toBeNull();
    expect(celda(hoja, 2, 'CIUDAD') ?? null).toBeNull();
    expect(celda(hoja, 2, 'PLACA')).toBe(PLACA);
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
    expect(celda(hoja, 2, 'TELEFONO')).toBe('3109876543');
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('MOSQUERA');

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
    expect(celda(hoja, 2, 'PLACA')).toBe(PLACA);
    expect(celda(hoja, 2, 'VIN')).toBe(VIN);
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('MOSQUERA');
    expect(celda(hoja, 2, 'CEDULA') ?? null).toBeNull();
    expect(celda(hoja, 2, 'DIRECCION') ?? null).toBeNull();
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
    expect(celda(hoja, 2, 'CEDULA')).toBe(CEDULA);
    expect(textoDe(hoja)).not.toContain('9999999999');
  });

  it('con el `orden` EMPATADO, el principal se decide por `id` y no por el azar de la consulta', async () => {
    // `orden` es `notNull().default(0)` y NO es único por trámite: sin el desempate, dos exports del
    // mismo filtro podrían traer cédulas distintas en la misma fila.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
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
      flito_impuestos: [filaImpuesto({ organismoAlias: null })],
      flito_compradores: [comprador()],
    });

    const hoja = await libro((await exportar(await sesion())).body as Buffer);
    expect(celda(hoja, 2, 'ORGANISMO DE TRANSITO')).toBe('25473');
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

  it('`campos_accedidos` declara el correo, el celular y la dirección — y NO el nombre', async () => {
    kdb.when.scenario({ flito_impuestos: [filaImpuesto()], flito_compradores: [comprador()] });

    await exportar(await sesion());
    const campos = ultimoAcceso().camposAccedidos as string[];

    expect(campos).toContain('correo');
    expect(campos).toContain('celular');
    expect(campos).toContain('direccion');
    expect(campos).toContain('ciudad');
    expect(campos).toContain('numero_documento');
    // El archivo no lleva el nombre: declararlo haría que `campos_accedidos` dejara de decir la
    // verdad, que es lo único que ese registro tiene que hacer.
    expect(campos).not.toContain('nombre_completo');
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
