// FLITO — el ZIP de soportes de las tres superficies (Feature #11908, HU #11910).
//
// Lo que se afirma es el ZIP REAL: se lee con JSZip y se comprueban los nombres de sus entradas, no
// la constante que los generó. `archiver` se ENVUELVE, no se sustituye — hace falta saber si llegó a
// instanciarse (AC6) y a la vez que el archivo que sale sea el de verdad.
//
// ── Los defectos que esta suite existe para atrapar ──────────────────────────────────────────────
//
//   · **El ZIP vacío de 22 bytes.** El molde del que sale esta HU escribía cabeceras y hacía `pipe`
//     ANTES del bucle. Una selección sin soportes producía un archivo válido y vacío que el usuario
//     abre y no entiende. El AC6 se afirma por AUSENCIA de `Content-Disposition` y por que `archiver`
//     no se instanció: invertir las dos mitades de la ruta no cambia ninguna otra respuesta.
//   · **El ZIP vacío EN PRODUCCIÓN, en verde.** `recibo_impuesto_sin_marca_agua` no lo escribe nadie
//     hoy: el único productor (`flito-recibos.service.ts`) fija `recibo_impuesto`. Una implementación
//     que consulte solo el limpio compila, tipa, y pasaría cualquier test titulado «elige el sin
//     marca de agua» — devolviendo nada para el 100 % del parque actual. Por eso el test central del
//     AC3 es el de la CAÍDA, no el de la preferencia.
//   · **Los homónimos.** `factura_venta` significa dos cosas: sobre `soat_id` es el adjunto que sube
//     el CLIENTE al radicar; la del flujo es la de FLIT y no vive en `flito_soportes`. Un ZIP de SOAT
//     que se lo lleve mete el documento del cliente en una descarga de Operaciones.
//   · **Iterar en el orden del array de ids.** Los ids llegan en el orden en que el usuario hizo
//     clic; el mismo lote marcado al revés repartiría los sufijos `-2`/`-3` de otra manera.
//   · **HU #12817 — un PDF por registro en Trámites e Impuestos, nombre = solo la placa.** Los
//     fixtures de esas dos rutas son PDFs REALES con un ancho de página de firma
//     (`helpers/pdf-firma.ts`): con el texto `'%PDF-1.4 …'` de antes todo saldría como ilegible y
//     daría 409. El orden y el número de páginas se afirman leyendo el PDF que sale del ZIP.
//   · **`OPERACIONES → LECTURA` en Trámites.** `LECTURA` incluye `auditor`, y el AC7 dice que
//     auditoría no descarga. El mutante se lee como una coherencia con las rutas de al lado.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CABECERAS_ZIP_SOPORTES, EstadoSoat, ZIP_SOPORTES_MAX_REGISTROS } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { registrarUsuarioDePrueba, testToken, type TestRole } from '../helpers/auth.js';
import { SignJWT } from 'jose';
import { anchosDe, pdfCifrado, pdfFirma } from '../helpers/pdf-firma.js';

/** Orden observado: el rastro de PII antes del primer byte, y `archiver` después de los dos. */
const orden: string[] = [];
/** Con qué opciones se instanció `archiver` (Bug #12644: store, zlib level 0). */
const opcionesArchiver: unknown[] = [];

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => { orden.push('pii'); return logPiiAccessMock(...args); },
}));

/** `archiver` envuelto: el archivo que se afirma es el de verdad, pero se sabe si se instanció. */
vi.mock('archiver', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as (...a: unknown[]) => unknown;
  return {
    ...actual,
    default: (...a: unknown[]) => { orden.push('archiver'); opcionesArchiver.push(a[1]); return real(...a); },
  };
});

/** MinIO: el soporte llega como stream, que es como lo entrega `getEntityDocumentStream`. */
const contenidoPorClave = new Map<string, string | Buffer>();
const getEntityDocumentStreamMock = vi.fn(async (key: string) => {
  const texto = contenidoPorClave.get(key);
  if (texto === undefined) throw new Error(`clave inexistente en el mock: ${key}`);
  return Readable.from([Buffer.isBuffer(texto) ? texto : Buffer.from(texto)]);
});
vi.mock('../../src/services/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/storage.js')>();
  return { ...actual, getEntityDocumentStream: getEntityDocumentStreamMock };
});

const obtenerUrlFacturaMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({
  getFlitAdapter: () => ({
    obtenerUrlFactura: obtenerUrlFacturaMock, obtenerTramites: vi.fn(), marcarEntregado: vi.fn(),
  }),
}));

const SOAT = '/api/flito/soat';
const IMPUESTOS = '/api/flito/impuestos';
const TRAMITES = '/api/flito/tramites';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const SOAT_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const SOAT_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const IMP_A = 'cccccccc-0000-0000-0000-00000000000c';
const TRAMITE_A = 'dddddddd-0000-0000-0000-00000000000d';

// ── Firmas de página (HU #12817): factura 101, recibo 201, comprobante SOAT 301 ────────────────
const PDF_FACTURA = await pdfFirma([101]);
const PDF_RECIBO = await pdfFirma([201]);
const PDF_SOAT = await pdfFirma([301]);
/** El contenido por defecto de un soporte: un PDF real de una página de 500. */
const PDF_SOPORTE = await pdfFirma([500]);

const AYER = new Date('2026-08-01T10:00:00.000Z');
const HOY = new Date('2026-08-02T10:00:00.000Z');

/** Fila de `flito_soat` × joins tal como la trae la consulta del ZIP. */
const filaSoat = (over: Record<string, unknown> = {}) => ({
  id: SOAT_A, createdAt: AYER, placa: 'ASD123',
  organismoAlias: 'Medellín', organismoCodigo: '05001',
  ...over,
});

const filaImpuesto = (over: Record<string, unknown> = {}) => ({
  id: IMP_A, createdAt: AYER, placa: 'ASD123',
  organismoAlias: 'Medellín', organismoCodigo: '05001',
  facturaVentaFlitId: null,
  ...over,
});

const filaTramite = (over: Record<string, unknown> = {}) => ({
  id: TRAMITE_A, createdAt: AYER, placa: 'ASD123',
  organismoAlias: 'Medellín', organismoCodigo: '05001',
  soatId: SOAT_A, impuestoId: IMP_A, facturaVentaFlitId: 'fac-1',
  ...over,
});

/**
 * Fila de `flito_soportes`. Registra además su contenido para que el stream de MinIO lo devuelva:
 * así el ZIP que se lee al final tiene bytes de verdad y no un `undefined` comprimido.
 */
let claves = 0;
function soporte(over: Record<string, unknown> & { contenido?: string | Buffer } = {}): Record<string, unknown> {
  claves += 1;
  const storageKey = (over.storageKey as string) ?? `flito/soportes/k${claves}.pdf`;
  contenidoPorClave.set(storageKey, over.contenido ?? PDF_SOPORTE);
  delete over.contenido;
  return {
    id: `s${claves}`,
    ancla: SOAT_A,
    tipo: 'factura_soat',
    nombreArchivo: 'comprobante.pdf',
    contentType: 'application/pdf',
    storageKey,
    tamanoBytes: 1024,
    subidoEn: AYER,
    // Lo que la proyección NO pide. El mock keyed devuelve la fila entera aunque el `select` pidiera
    // menos, así que estas viajan igual y sirven de centinela.
    descartado: false,
    conciliacionBoletaId: null,
    ...over,
  };
}

/**
 * La respuesta de S3 de FLIT: cuerpo en streaming, sin tipo útil (rotula todo como octet-stream).
 * Por defecto, un PDF REAL de una página de 101 (la firma de la factura).
 */
function respuestaFlit(cuerpo: string | Buffer = PDF_FACTURA): unknown {
  const bytes = typeof cuerpo === 'string' ? new TextEncoder().encode(cuerpo) : new Uint8Array(cuerpo);
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'binary/octet-stream' }),
    body: new ReadableStream({
      start(c) { c.enqueue(bytes); c.close(); },
    }),
  };
}

// ── App y sesiones ───────────────────────────────────────────────────────────────────────────────

/**
 * Los TRES routers en la misma app.
 *
 * No es comodidad: con una app por módulo, tres bolsas de cuota y una sola bolsa se ven exactamente
 * igual en verde (`makeStore` devuelve `undefined` sin Redis y `express-rate-limit` crea un
 * `MemoryStore` por llamada).
 */
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: soat } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  const { default: impuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { default: tramites } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  app.use(SOAT, soat);
  app.use(IMPUESTOS, impuestos);
  app.use(TRAMITES, tramites);
  return app;
}

/** `sub` nuevo por caso: el limitador cuenta 5/min y usuario, y su ventana no se reinicia. */
let siguienteSub = 7100;
const sesion = async (role: TestRole = 'admin', funciones?: string[]): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role, funciones })}`;

const pedirZip = async (base: string, cabecera: string, cuerpo: unknown) =>
  request(await buildApp())
    .post(`${base}/soportes/zip`)
    .set('Authorization', cabecera)
    .responseType('blob')
    .send(cuerpo as object);

/** Los anchos de página del PDF `nombre` dentro del ZIP (HU #12817). */
async function anchosEnZip(cuerpo: Buffer, nombre: string): Promise<number[]> {
  const zip = await JSZip.loadAsync(cuerpo);
  const f = zip.file(nombre);
  expect(f, `no está la entrada ${nombre}`).not.toBeNull();
  return anchosDe(await f!.async('uint8array'));
}

/** Directorios temporales de la consolidación que siguen en disco. */
const temporales = (): string[] => readdirSync(os.tmpdir()).filter((n) => n.startsWith('flito-zip-'));

/** Los NOMBRES de las entradas del ZIP, en el orden en que están escritas en el archivo. */
async function entradasDe(cuerpo: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(cuerpo);
  const nombres: string[] = [];
  zip.forEach((ruta) => nombres.push(ruta));
  return nombres;
}

// ── Espías de la consulta ────────────────────────────────────────────────────────────────────────

const consultas: { tabla: string; columnas: string[]; where: unknown }[] = [];

/**
 * ⚠️ **El mock keyed enruta por TABLA y devuelve lo registrado SIN aplicar el `where`.**
 *
 * Para casi todo da igual. Para el AC3 **no**, y ese descuido produciría el peor test de esta HU:
 * `recibo_impuesto_sin_marca_agua` no lo escribe nadie hoy —el único productor,
 * `flito-recibos.service.ts`, fija `recibo_impuesto`—, así que una implementación que consulte solo
 * el limpio devuelve un ZIP vacío para el 100 % del parque actual… y con un mock que ignora el
 * predicado, el test de la caída pasaría en verde igualmente. Medido: sin esto, el mutante «quitar
 * `RECIBO_IMPUESTO` del catálogo de tipos de BD» solo tumbaba el aserto de SQL y dejaba pasar el
 * caso funcional.
 *
 * Así que sobre `flito_soportes` se aplica **una sola dimensión del `where`: el `tipo`**, que es la
 * que el AC decide. Ni el ancla ni `descartado` se simulan —eso se afirma aparte sobre el SQL
 * serializado—, para que esto siga siendo un mock y no una segunda implementación de PostgreSQL.
 */
function filtrarPorTipo(consulta: { tabla: string; where: unknown }, filas: unknown): unknown {
  if (consulta.tabla !== 'flito_soportes' || !consulta.where || !Array.isArray(filas)) return filas;
  const { params } = new PgDialect().sqlToQuery(consulta.where as never);
  return (filas as Record<string, unknown>[]).filter((f) => params.includes(f.tipo as string));
}

function instalarEspias(): void {
  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const consulta = { tabla: '__sin_from__', columnas, where: null as unknown };
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { consulta.tabla = nombre(tbl); consultas.push(consulta); return from(tbl); };
    const where = chain.where as (c: unknown) => unknown;
    chain.where = (cond: unknown) => { consulta.where = cond; return where(cond); };
    const then = chain.then as (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => unknown;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      then((filas) => res(filtrarPorTipo(consulta, filas)), rej);
    return chain;
  });
}

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

const lecturasDe = (tabla: string) => consultas.filter((c) => c.tabla === tabla);

function whereDe(tabla: string, indice = 0): { sql: string; params: unknown[] } {
  const lecturas = lecturasDe(tabla);
  expect(lecturas.length, `no hubo lectura de \`${tabla}\``).toBeGreaterThan(indice);
  return new PgDialect().sqlToQuery(lecturas[indice]!.where as never);
}

const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  kdb.reset();
  instalarEspias();
  logPiiAccessMock.mockClear();
  getEntityDocumentStreamMock.mockClear();
  obtenerUrlFacturaMock.mockReset();
  contenidoPorClave.clear();
  consultas.length = 0;
  orden.length = 0;
  opcionesArchiver.length = 0;
  vi.unstubAllGlobals();
});

// ─────────────────────────── AC6 · nada marcado tiene el tipo ────────────────────────────────────

describe('AC6 — sin soportes NO sale un ZIP vacío', () => {
  it('409 con `codigo`, SIN `Content-Disposition` y sin haber instanciado `archiver`', async () => {
    // Hay registros —la frontera los deja pasar— y lo que no hay es un solo soporte. Es el caso que
    // el molde heredado resolvía con un archivo válido de 22 bytes.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(String(r.headers['content-type'] ?? '')).not.toContain('application/zip');
    // Lo que mata el mutante «cabeceras y `pipe` antes del bucle»: con ese orden el estado seguiría
    // siendo 200, el cuerpo un zip vacío y `archiver` habría corrido.
    expect(orden).not.toContain('archiver');

    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;
    expect(cuerpo.codigo).toBe('zip_sin_soportes');
  });

  it('el 409 NO dice cuántos ids quedaron fuera ni por qué', async () => {
    // Publicar «3 de 40 no eran tuyos» convertiría el ZIP en un oráculo de pertenencia: el mismo
    // mensaje tiene que servir para «no existe», «no es tuyo» y «no tiene ese documento».
    kdb.when.scenario({ flito_soat: [], flito_soportes: [] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A, SOAT_B] });
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;

    expect(r.status).toBe(409);
    expect(cuerpo.error).not.toMatch(/\d/);
    expect(cuerpo.error).not.toContain(SOAT_A);
  });

  it('el rastro de PII tampoco se escribe cuando no hay nada que entregar', async () => {
    // No es simetría: no hubo entrega de datos personales, así que una línea de «acceso a datos
    // personales» sería falsa. El 422 del `.xlsx` sí la escribe porque allí la consulta SÍ trajo
    // filas con cédula al proceso; aquí la consulta de soportes volvió vacía.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [] });

    await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── AC2 · el PSE y el homónimo ─────────────────────────────────────────

describe('AC2 — el ZIP de SOAT trae el comprobante y NADA más', () => {
  it('el WHERE nombra `factura_soat` y NO menciona la boleta de conciliación', async () => {
    // Afirmar solo sobre el CONTENIDO no puede fallar nunca: el CHECK
    // `flito_soportes_factura_excluyente_chk` ya impide que un soporte con `conciliacion_boleta_id`
    // tenga `soat_id`, así que el test saldría verde por razones ajenas al código. Lo que se fija
    // aquí es el predicado.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] })).status).toBe(200);

    const { sql, params } = whereDe('flito_soportes');
    expect(sql).toContain('"soat_id"');
    expect(sql).toContain('"tipo"');
    expect(params).toContain('factura_soat');
    expect(params).not.toContain('comprobante_pse');
    expect(sql).not.toContain('conciliacion_boleta_id');
    // Y el descartado en la cola de revisión tampoco entra.
    expect(sql).toContain('"descartado"');
  });

  /**
   * ⚠️ **Estos dos casos afirman sobre el PREDICADO, y el contenido es el testigo secundario.**
   *
   * Con una base real, un aserto solo de contenido no podría fallar nunca: el CHECK
   * `flito_soportes_factura_excluyente_chk` ya impide que un `comprobante_pse` tenga `soat_id`, así
   * que el test saldría verde por razones ajenas al código y sobreviviría a cualquier mutante. Lo
   * que depende del código es QUÉ se pide. El contenido se comprueba además porque el espía aplica
   * la dimensión `tipo` del `where` (ver `filtrarPorTipo`).
   */
  it('el `comprobante_pse` de la boleta conciliada no cabe en el predicado, y la conciliación ni se consulta', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [
        soporte({ nombreArchivo: 'comprobante-soat.pdf' }),
        soporte({
          id: 'pse-1', tipo: 'comprobante_pse', ancla: SOAT_A,
          nombreArchivo: 'PSE-BOLETA-99.pdf', conciliacionBoletaId: 'boleta-99',
        }),
      ],
      flito_conciliacion_lineas: [{ soatId: SOAT_A, boletaId: 'boleta-99', conciliadaEn: AYER }],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(r.status).toBe(200);

    const { params, sql } = whereDe('flito_soportes');
    expect(params).toContain('factura_soat');
    expect(params).not.toContain('comprobante_pse');
    expect(sql).not.toContain('conciliacion_boleta_id');

    // Y el testigo secundario: solo hay UNA entrada, la del comprobante.
    expect(await entradasDe(r.body as Buffer)).toHaveLength(1);

    // **El mutante realista, y este SÍ es observable sin base real**: reusar
    // `soportesDeSoat(soatId, { rol: 'admin' })`, que con `admin` devuelve el PSE
    // (`ROLES_COMPROBANTE_PSE`) y metería en el ZIP el pago de una boleta que agrupa N SOAT ajenos.
    // Esa función parte de `flito_conciliacion_lineas`; si alguien la enchufa aquí, esta lectura
    // aparece.
    expect(lecturasDe('flito_conciliacion_lineas')).toHaveLength(0);
  });

  it('el `factura_venta` que cuelga de un SOAT (adjunto del CLIENTE) no cabe en el predicado', async () => {
    // Homónimo peligroso: `factura_venta` sobre `soat_id` es lo que sube el propio cliente al
    // radicar o al subsanar. La factura del flujo es la de FLIT y ni siquiera está en esta tabla.
    // Colarlo mete el documento del cliente en una descarga de Operaciones.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [
        soporte({ nombreArchivo: 'comprobante-soat.pdf' }),
        soporte({ id: 'cli-1', tipo: 'factura_venta', ancla: SOAT_A, nombreArchivo: 'MI-FACTURA-CLIENTE.pdf' }),
      ],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(r.status).toBe(200);

    const { params } = whereDe('flito_soportes');
    // La lista de tipos del `IN` es EXACTAMENTE una: el mutante «añadir `factura_venta` al catálogo
    // de esta superficie» no puede pasar de aquí.
    expect(params.filter((p) => typeof p === 'string' && p.startsWith('factura')))
      .toEqual(['factura_soat']);
    expect(await entradasDe(r.body as Buffer)).toHaveLength(1);
  });

  it('el cuerpo NO admite `tipos`: esta superficie tiene un solo tipo', async () => {
    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A], tipos: ['factura_venta'] });
    expect(r.status).toBe(400);
    expect(lecturasDe('flito_soportes')).toHaveLength(0);
  });
});

// ─────────────────────────── AC3 · el recibo de Impuestos ───────────────────────────────────────

describe('AC3 — el recibo: la CAÍDA es el camino real, no la preferencia', () => {
  it('**con SOLO `recibo_impuesto`, el ZIP trae el recibo**', async () => {
    // El caso del 100 % de los datos de hoy: `recibo_impuesto_sin_marca_agua` no lo escribe NADIE
    // —el único productor, `flito-recibos.service.ts`, fija `recibo_impuesto`—. Una implementación
    // que consulte solo el limpio compila, tipa y devuelve un ZIP vacío para todo el parque, en
    // verde. Aquí es donde cae el mutante «consultar solo `sin_marca_agua`»: 409 en vez de 200.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', nombreArchivo: 'recibo.pdf' })],
    });

    const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['recibo_impuesto'] });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
  });

  it('con los DOS tipos, UNA sola entrada y es la `sin_marca_agua`', async () => {
    // Consultar ambos sin preferencia daría dos entradas del MISMO pago, desempatadas con `-2` e
    // indistinguibles de un duplicado legítimo. El nombre del fichero de la fixture es el testigo.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', nombreArchivo: 'MARCADO.pdf', contenido: PDF_SOAT }),
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto_sin_marca_agua', nombreArchivo: 'limpio.pdf', contenido: PDF_RECIBO }),
      ],
    });

    const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['recibo_impuesto'] });

    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    // La prueba de CUÁL se eligió es la página del PDF: la del limpio (201), no la del marcado (301).
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([201]);
  });

  it('la consulta pide los DOS tipos: sin eso no puede haber caída', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto' })],
    });

    await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['recibo_impuesto'] });

    const { params } = whereDe('flito_soportes');
    expect(params).toContain('recibo_impuesto_sin_marca_agua');
    expect(params).toContain('recibo_impuesto');
  });

  it('la caída se decide POR IMPUESTO, no para el lote entero', async () => {
    // Un lote donde uno tiene el limpio y otro solo el marcado tiene que entregar los DOS: decidir
    // «hay limpios en el lote → solo limpios» dejaría al segundo sin recibo, en silencio.
    const IMP_B = 'cccccccc-0000-0000-0000-00000000000e';
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto(), filaImpuesto({ id: IMP_B, placa: 'QWE789', createdAt: HOY })],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto_sin_marca_agua' }),
        soporte({ ancla: IMP_B, tipo: 'recibo_impuesto' }),
      ],
    });

    const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A, IMP_B], tipos: ['recibo_impuesto'] });

    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf', 'QWE789.pdf']);
  });

  it('HU #12817 AC2 — factura de venta + recibo en UN solo PDF por impuesto', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ facturaVentaFlitId: 'fac-1' })],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: PDF_RECIBO })],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(IMPUESTOS, await sesion(), {
      ids: [IMP_A], tipos: ['factura_venta', 'recibo_impuesto'],
    });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    // El orden dentro del PDF es el del catálogo (factura → recibo), no el del array pedido.
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([101, 201]);
    expect(r.headers['x-soportes-incluidos']).toBe('2');
    expect(r.headers['x-soportes-omitidos']).toBe('0');
  });

  it('`factura_soat` NO es un tipo de esta superficie: 400', async () => {
    const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['factura_soat'] });
    expect(r.status).toBe(400);
  });

  it('un campo desconocido es 400 y no un filtro ignorado en silencio', async () => {
    // Sin `.strict()`, `{"tipo": "recibo_impuesto"}` —en singular— se ignoraría y el usuario
    // recibiría un archivo con otra cosa dentro creyendo que pidió lo que marcó.
    const r = await pedirZip(IMPUESTOS, await sesion(), {
      ids: [IMP_A], tipos: ['recibo_impuesto'], tipo: 'factura_venta',
    });
    expect(r.status).toBe(400);
  });
});

// ─────────────────────────── AC4 · el ZIP mixto de Trámites ─────────────────────────────────────

describe('HU #12817 AC1 — Trámites: los tres tipos en UN PDF por trámite', () => {
  it('factura + recibo + comprobante del MISMO trámite → `ASD123.pdf` con [101, 201, 301]', async () => {
    // Los soportes se siembran SOAT antes que recibo, y los tipos se piden desordenados: si el orden
    // de páginas sale bien, lo puso `ORDEN_TIPOS_SOPORTE_ZIP`, no la siembra ni el cuerpo.
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [
        soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_SOAT }),
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: PDF_RECIBO }),
      ],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_soat', 'recibo_impuesto', 'factura_venta'],
    });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([101, 201, 301]);
    expect(r.headers['x-soportes-omitidos']).toBe('0');
  });

  it('se pide UN solo tipo y sale igual como `PLACA.pdf` consolidado', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite({ facturaVentaFlitId: null })],
      flito_soportes: [soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_SOAT, nombreArchivo: 'x.jpg' })],
    });

    const r = await pedirZip(TRAMITES, await sesion(), { ids: [TRAMITE_A], tipos: ['factura_soat'] });

    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([301]);
  });

  it('AC3 — sin recibo: [101, 301], sin página vacía donde iría', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite({ impuestoId: null })],
      flito_soportes: [soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_SOAT })],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([101, 301]);
    expect(r.headers['x-soportes-incluidos']).toBe('2');
  });

  it('un trámite sin SOAT y sin impuesto SALE igual, con lo que tenga', async () => {
    // `leftJoin` y no `innerJoin`: un trámite al que le falte una de las anclas no puede desaparecer
    // del lote en silencio; simplemente aporta menos entradas.
    kdb.when.scenario({
      flito_tramites: [filaTramite({ soatId: null, impuestoId: null })],
      flito_soportes: [],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
  });

  // RETIRADO a propósito por la HU #12817: «la factura de FLIT viaja en STREAMING, no bufferizada
  // con `arrayBuffer()`». Pedía justo lo que el AC5 prohíbe en Trámites e Impuestos: sacar la factura
  // después del primer byte sin saber si es legible. Lo que protegía —no bufferizar el LOTE— sigue
  // garantizado de otra forma: el buffer es por documento, dura lo que tarda su registro en
  // consolidarse (concurrencia 2) y el PDF va a disco. La respuesta simulada sigue exponiendo solo
  // `body`, así que volver a `arrayBuffer()` sin tope seguiría reventando. Lo sustituye el de abajo.
  it('HU #12817 AC5 — FLIT caído: `X-Soportes-Omitidos: 1` en la cabecera y el resto se entrega', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: PDF_RECIBO })],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, body: null }));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto'],
    });

    expect(r.status).toBe(200);
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([201]);
    // En la CABECERA —antes del primer byte— y no descubierto a mitad del streaming.
    expect(r.headers['x-soportes-omitidos']).toBe('1');
    expect(r.headers['x-soportes-incluidos']).toBe('1');
  });
});

// ─────────────────────────── HU #12817 · ilegibles, cifrados, temporales ─────────────────────────

describe('HU #12817 — lo ilegible se omite y se avisa; nada legible es el mismo 409', () => {
  it('AC5 — recibo corrupto: [101, 301], omitido contado, cabeceras presentes', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: '%PDF-1.4 basura' }),
        soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_SOAT }),
      ],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([101, 301]);
    expect(r.headers['x-soportes-incluidos']).toBe('2');
    expect(r.headers['x-soportes-omitidos']).toBe('1');
  });

  it('AC5 — NADA legible: el mismo 409, sin `Content-Disposition`, sin cifras, sin `archiver` ni PII', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: '%PDF-1.4 basura' }),
        soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: 'no soy nada' }),
      ],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit('bytes basura de FLIT')));
    const antes = temporales();

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    expect(r.status).toBe(409);
    expect(JSON.parse((r.body as Buffer).toString('utf8')).codigo).toBe('zip_sin_soportes');
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(r.headers['x-soportes-incluidos']).toBeUndefined();
    expect(r.headers['x-soportes-omitidos']).toBeUndefined();
    expect(orden).not.toContain('archiver');
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    expect(temporales()).toEqual(antes);
  });

  it('PDF cifrado: `PLACA.pdf` con lo unible y el original aparte como `PLACA-2.pdf`, bytes intactos', async () => {
    const cifrado = await pdfCifrado([250]);
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', contenido: cifrado }),
        soporte({ ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_SOAT }),
      ],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf', 'ASD123-2.pdf']);
    expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([101, 301]);
    const zip = await JSZip.loadAsync(r.body as Buffer);
    expect(Buffer.from(await zip.file('ASD123-2.pdf')!.async('uint8array')).equals(cifrado)).toBe(true);
    // Cuenta como incluido, no como omitido.
    expect(r.headers['x-soportes-incluidos']).toBe('3');
    expect(r.headers['x-soportes-omitidos']).toBe('0');
  });

  it('el directorio temporal queda borrado tras el 200', async () => {
    kdb.when.scenario({
      flito_tramites: [filaTramite({ facturaVentaFlitId: null })],
      flito_soportes: [soporte({ ancla: SOAT_A, tipo: 'factura_soat' })],
    });
    const antes = temporales();

    const r = await pedirZip(TRAMITES, await sesion(), { ids: [TRAMITE_A], tipos: ['factura_soat'] });

    expect(r.status).toBe(200);
    // El cliente recibe el final del cuerpo un instante antes de que el `finally` de la ruta borre:
    // se espera (≤ 1 s) a que desaparezca, que es lo que importa —que no QUEDE en disco—.
    await vi.waitFor(() => expect(temporales()).toEqual(antes), { timeout: 1000 });
  });

  it('AC8 — 422 si los bytes REALES de FLIT superan el tope, aunque el cupo declarado cupiera', async () => {
    const { env } = await import('../../src/config/env.js');
    const tope = env.FLITO_ZIP_SOPORTES_MAX_BYTES;
    const cupo = env.FLITO_ZIP_FACTURA_CUPO_BYTES;
    env.FLITO_ZIP_SOPORTES_MAX_BYTES = 3000;
    env.FLITO_ZIP_FACTURA_CUPO_BYTES = 1000;
    const IMP_B = 'cccccccc-0000-0000-0000-00000000000e';
    try {
      // Declarado: 2 × 1000 = 2000 ≤ 3000. Real: 2 × 1800 = 3600 > 3000.
      kdb.when.scenario({
        flito_impuestos: [
          filaImpuesto({ facturaVentaFlitId: 'fac-1' }),
          filaImpuesto({ id: IMP_B, placa: 'QWE789', createdAt: HOY, facturaVentaFlitId: 'fac-2' }),
        ],
        flito_soportes: [],
      });
      obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac');
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => respuestaFlit(Buffer.alloc(1800, 0x25))));
      const antes = temporales();

      const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A, IMP_B], tipos: ['factura_venta'] });

      expect(r.status).toBe(422);
      expect(JSON.parse((r.body as Buffer).toString('utf8')).codigo).toBe('zip_demasiado_grande');
      expect(r.headers['content-disposition']).toBeUndefined();
      expect(orden).not.toContain('archiver');
      expect(logPiiAccessMock).not.toHaveBeenCalled();
      expect(temporales()).toEqual(antes);
    } finally {
      env.FLITO_ZIP_SOPORTES_MAX_BYTES = tope;
      env.FLITO_ZIP_FACTURA_CUPO_BYTES = cupo;
    }
  });
});

// ─────────────────────────── HU #12817 AC6 · desempate entre REGISTROS ───────────────────────────

describe('HU #12817 AC6 — en Trámites `-2` desempata REGISTROS con la misma placa, no documentos', () => {
  const TRAMITE_B = 'dddddddd-0000-0000-0000-00000000000e';
  const SOAT_Z = 'aaaaaaaa-0000-0000-0000-0000000000ff';

  const escenario = (invertido: boolean) => {
    const tramites = [
      filaTramite({ id: TRAMITE_A, createdAt: AYER, impuestoId: null, facturaVentaFlitId: null, soatId: SOAT_A }),
      filaTramite({ id: TRAMITE_B, createdAt: HOY, impuestoId: null, facturaVentaFlitId: null, soatId: SOAT_Z }),
    ];
    const soportes = [
      soporte({ id: 's-viejo', ancla: SOAT_A, tipo: 'factura_soat', contenido: PDF_RECIBO }),
      soporte({ id: 's-nuevo', ancla: SOAT_Z, tipo: 'factura_soat', contenido: PDF_SOAT }),
    ];
    kdb.when.scenario({
      flito_tramites: invertido ? [...tramites].reverse() : tramites,
      flito_soportes: invertido ? [...soportes].reverse() : soportes,
    });
  };

  it('el trámite más antiguo se lleva `ASD123.pdf`, pedido en cualquier orden', async () => {
    for (const invertido of [false, true]) {
      kdb.reset(); instalarEspias(); contenidoPorClave.clear();
      escenario(invertido);
      const ids = invertido ? [TRAMITE_B, TRAMITE_A] : [TRAMITE_A, TRAMITE_B];
      const r = await pedirZip(TRAMITES, await sesion(), { ids, tipos: ['factura_soat'] });

      expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf', 'ASD123-2.pdf']);
      // La firma de página dice DE QUIÉN es cada nombre, no solo que hay dos.
      expect(await anchosEnZip(r.body as Buffer, 'ASD123.pdf')).toEqual([201]);
      expect(await anchosEnZip(r.body as Buffer, 'ASD123-2.pdf')).toEqual([301]);
      expect(r.headers['x-soportes-registros']).toBe('2');
    }
  });
});

// ─────────────────────────── AC5 · el nombre ────────────────────────────────────────────────────

describe('HU #12817 AC6 — el nombre es SOLO la placa, en mayúsculas y sin separadores', () => {
  const casoNombre = async (over: Record<string, unknown>): Promise<string[]> => {
    kdb.when.scenario({
      flito_soat: [filaSoat(over)],
      flito_soportes: [soporte({ ancla: (over.id as string) ?? SOAT_A })],
    });
    const r = await pedirZip(SOAT, await sesion(), { ids: [(over.id as string) ?? SOAT_A] });
    expect(r.status).toBe(200);
    return entradasDe(r.body as Buffer);
  };

  it('`ASD123` con organismo `Medellín` → `ASD123.pdf` (el organismo ya no entra)', async () => {
    const nombres = await casoNombre({});
    expect(nombres).toEqual(['ASD123.pdf']);
    expect(nombres.join('|')).not.toContain('MEDELLIN');
  });

  it('la placa con guion y minúsculas se normaliza igual', async () => {
    expect(await casoNombre({ placa: 'asd-123' })).toEqual(['ASD123.pdf']);
  });

  // RETIRADOS por la HU #12817 (no invertidos): «sin alias, el organismo cae a su CÓDIGO» y «sin
  // alias y sin código → `SIN-ORGANISMO`». El organismo ya no forma parte del nombre.

  it('sin placa, el documento SALE igual con `SIN-PLACA`, nunca `null`', async () => {
    // Un soporte que existe no puede desaparecer del archivo porque al vehículo le falte un campo.
    const nombres = await casoNombre({ placa: null });
    expect(nombres).toEqual(['SIN-PLACA.pdf']);
    expect(nombres.join('|').toLowerCase()).not.toContain('null');
  });

  it('`organismoParaExport` NO se muta: el `.xlsx` de la HU #11909 sigue con el alias crudo', async () => {
    // El mutante que esto mata es «ponerle `toUpperCase()` a `organismoParaExport`»: el ZIP saldría
    // idéntico y la columna ORGANISMO DE TRANSITO del Excel del eslabón anterior cambiaría de
    // contenido sin que ningún test de esta HU se enterara.
    const { organismoParaExport } = await import('../../src/shared/export/cola-flito-excel.js');
    expect(organismoParaExport('Medellín', '05001')).toBe('Medellín');
    expect(organismoParaExport(null, '05001')).toBe('05001');
    expect(organismoParaExport(null, null)).toBeNull();
  });
});

// ─────────────────────────── AC5 · el desempate determinista ────────────────────────────────────

describe('AC5 — el desempate no depende del orden en que el usuario hizo clic', () => {
  /**
   * Dos SOAT con la MISMA placa: es lo que produce la colisión.
   *
   * `invertido` no es un adorno del test: la consulta por lote **no lleva `ORDER BY`** —el orden lo
   * pone el servicio—, así que en producción PostgreSQL puede devolver las filas en cualquier orden.
   * Sin invertir también la FIXTURE, el mutante «iterar `registros` en vez de `ordenados`» pasa en
   * verde: el mock devuelve siempre la misma secuencia y los dos caminos coinciden. Medido.
   */
  const escenarioDosSoat = (invertido = false) => {
    const soats = [
      filaSoat({ id: SOAT_A, createdAt: AYER }),
      filaSoat({ id: SOAT_B, createdAt: HOY }),
    ];
    const soportes = [
      soporte({ id: 's-viejo', ancla: SOAT_A, storageKey: 'k/viejo.pdf', contenido: 'VIEJO' }),
      soporte({ id: 's-nuevo', ancla: SOAT_B, storageKey: 'k/nuevo.pdf', contenido: 'NUEVO' }),
    ];
    kdb.when.scenario({
      flito_soat: invertido ? [...soats].reverse() : soats,
      flito_soportes: invertido ? [...soportes].reverse() : soportes,
    });
  };

  /** Qué CONTENIDO se llevó cada nombre. Los nombres solos no dicen a quién le tocó el `-2`. */
  async function reparto(cuerpo: Buffer): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(cuerpo);
    const salida: Record<string, string> = {};
    for (const ruta of Object.keys(zip.files)) salida[ruta] = await zip.file(ruta)!.async('string');
    return salida;
  }

  it('el MISMO lote pedido al revés —y devuelto al revés por la base— reparte igual', async () => {
    escenarioDosSoat();
    const enOrden = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A, SOAT_B] });
    const repartoA = await reparto(enOrden.body as Buffer);

    kdb.reset(); instalarEspias(); contenidoPorClave.clear();
    escenarioDosSoat(true);
    const alReves = await pedirZip(SOAT, await sesion(), { ids: [SOAT_B, SOAT_A] });
    const repartoB = await reparto(alReves.body as Buffer);

    // Mata las DOS formas de perder el determinismo: iterar el array de ids (el orden en que el
    // usuario hizo clic) e iterar el orden en que la base devolvió las filas.
    expect(repartoB).toEqual(repartoA);
    // Y el reparto es el que dice el AC5: manda `createdAt ASC`, así que el SOAT más antiguo se
    // lleva el nombre limpio y el nuevo el `-2`.
    expect(repartoA).toEqual({
      'ASD123.pdf': 'VIEJO',
      'ASD123-2.pdf': 'NUEVO',
    });
  });

  it('con `created_at` EMPATADO entre registros, manda el `id` del registro', async () => {
    // El otro empate real: dos SOAT creados por la misma corrida del sync comparten instante. Sin el
    // segundo criterio, el reparto de los sufijos lo decidiría el orden en que la base devolvió las
    // filas —y la consulta del lote NO lleva `ORDER BY`—. La fixture llega con el id mayor primero.
    kdb.when.scenario({
      flito_soat: [
        filaSoat({ id: SOAT_B, createdAt: AYER }),
        filaSoat({ id: SOAT_A, createdAt: AYER }),
      ],
      flito_soportes: [
        soporte({ id: 's-b', ancla: SOAT_B, storageKey: 'k/b.pdf', contenido: 'DEL-B' }),
        soporte({ id: 's-a', ancla: SOAT_A, storageKey: 'k/a.pdf', contenido: 'DEL-A' }),
      ],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_B, SOAT_A] });

    // `aaaaaaaa-…` < `bbbbbbbb-…`: el nombre limpio es del A pase lo que pase.
    expect(await reparto(r.body as Buffer)).toEqual({
      'ASD123.pdf': 'DEL-A',
      'ASD123-2.pdf': 'DEL-B',
    });
  });

  it('con `subido_en` EMPATADO, el desempate lo decide el `id` y no PostgreSQL', async () => {
    // La carga masiva de recibos inserta varios en la misma transacción: `subido_en` empata de
    // verdad. Sin el segundo criterio, quién se lleva el nombre limpio lo decidiría el orden en que
    // la base devuelva las filas.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [
        // Contenidos DISTINTOS: con el PDF por defecto (el mismo para los dos) el aserto no vería nada.
        soporte({ id: 'zzz', ancla: SOAT_A, subidoEn: AYER, contenido: 'DEL-ZZZ' }),
        soporte({ id: 'aaa', ancla: SOAT_A, subidoEn: AYER, contenido: 'DEL-AAA' }),
      ],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    const zip = await JSZip.loadAsync(r.body as Buffer);
    // El `aaa` es el que tiene que llevarse el nombre sin sufijo.
    expect(await zip.file('ASD123.pdf')!.async('string')).toBe('DEL-AAA');
    expect(await zip.file('ASD123-2.pdf')!.async('string')).toBe('DEL-ZZZ');
  });

  it('dos `factura_soat` VIVOS del mismo SOAT colisionan y salen los dos (SOAT NO consolida)', async () => {
    // `flito_soportes` solo tiene índice único de `factura_venta` sobre `soat_id`: dos comprobantes
    // vivos son posibles y ninguno puede perderse.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [
        soporte({ id: 's1', ancla: SOAT_A, subidoEn: AYER }),
        soporte({ id: 's2', ancla: SOAT_A, subidoEn: HOY }),
      ],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf', 'ASD123-2.pdf']);
    // HU #12817: SOAT no consolida, así que tampoco manda la cabecera de omitidos.
    expect(r.headers['x-soportes-omitidos']).toBeUndefined();
  });

  it('la extensión sale del `nombre_archivo` del soporte, no de un `.pdf` fijo', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, nombreArchivo: 'poliza escaneada.JPG', contentType: 'image/jpeg' })],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.jpg']);
  });
});

// ─────────────────────────── AC7 y fronteras ────────────────────────────────────────────────────

describe('AC7 — auditoría NO descarga, en las tres rutas', () => {
  it('`auditor` recibe 403 en SOAT, en Impuestos y en Trámites', async () => {
    const app = await buildApp();
    for (const [base, cuerpo] of [
      [SOAT, { ids: [SOAT_A] }],
      [IMPUESTOS, { ids: [IMP_A], tipos: ['recibo_impuesto'] }],
      // El mutante nombrado de Trámites: `OPERACIONES → LECTURA`. `LECTURA` de ese router es
      // `admin` + `auditor`, así que el cambio se lee como una coherencia con `GET /:id/soportes` de
      // al lado y abre una descarga masiva de documentos a auditoría.
      [TRAMITES, { ids: [TRAMITE_A], tipos: ['factura_soat'] }],
    ] as const) {
      const r = await request(app).post(`${base}/soportes/zip`)
        .set('Authorization', await sesion('auditor')).responseType('blob').send(cuerpo as object);
      expect(r.status, `${base} tenía que devolver 403 a auditor`).toBe(403);
    }
    expect(consultas).toHaveLength(0);
    expect(orden).not.toContain('archiver');
  });

  it('HU #12815 AC2 — `cliente` SIN `soat.soportes.descargar` recibe 403, y no se consulta nada', async () => {
    // Desde la #12815 la lista blanca del canal deja pasar la ruta; la decisión es de `exigirFuncion`.
    const r = await pedirZip(SOAT, await sesion('cliente'), { ids: [SOAT_A] });
    expect(r.status).toBe(403);
    expect(JSON.parse((r.body as Buffer).toString('utf8')).funcion).toBe('soat.soportes.descargar');
    expect(consultas).toHaveLength(0);
  });
});

describe('fronteras — lo ajeno no sale, y no se distingue de «sin soporte»', () => {
  it('el gestor de SOAT arrastra su frontera al WHERE del lote', async () => {
    kdb.when.scenario({
      users: [{ p: 'prov-1' }],
      flito_soat: [filaSoat()],
      flito_soportes: [soporte()],
    });

    expect((await pedirZip(SOAT, await sesion('proveedor'), { ids: [SOAT_A] })).status).toBe(200);

    const { sql, params } = whereDe('flito_soat');
    expect(sql).toContain('proveedor_soat_id');
    expect(sql).toContain('gestion_operaciones');
    expect(params).toContain('prov-1');
    // `pagado` tiene que estar, porque el comprobante solo existe cuando el registro ya está pagado.
    // Heredar el defecto de la PANTALLA (`solicitado` a secas) habría dejado al gestor sin poder
    // descargar nunca lo que él mismo subió. Y desde la HU #12815 (AC3) es lo ÚNICO que baja.
    expect(params).toContain('pagado');
    expect(params).not.toContain('solicitado');
    expect(params).not.toContain('pendiente');
  });

  it('gestor SIN proveedor → 409, no la tabla entera', async () => {
    // `condicionesCola` devuelve `null` cuando no hay frontera que aplicar. El defecto que esto mata
    // es tratar ese `null` como «sin filtros»: la fixture tiene soportes y no pueden salir.
    kdb.when.scenario({
      users: [{ p: null }],
      flito_soat: [filaSoat()],
      flito_soportes: [soporte()],
    });

    const r = await pedirZip(SOAT, await sesion('proveedor'), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(lecturasDe('flito_soat')).toHaveLength(0);
    expect(lecturasDe('flito_soportes')).toHaveLength(0);
  });

  it('gestor de Impuestos sin organismo → 409, y ninguna consulta a la tabla', async () => {
    kdb.when.scenario({
      users: [{ t: null }],
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto' })],
    });

    const r = await pedirZip(IMPUESTOS, await sesion('gestor_impuestos'), {
      ids: [IMP_A], tipos: ['recibo_impuesto'],
    });

    expect(r.status).toBe(409);
    expect(lecturasDe('flito_impuestos')).toHaveLength(0);
  });

  it('un id ajeno que la frontera descarta NO se distingue de uno sin documento', async () => {
    // Dos peticiones, dos causas distintas, la MISMA respuesta byte a byte. Es lo que impide usar el
    // endpoint como oráculo de pertenencia.
    kdb.when.scenario({ users: [{ p: 'prov-1' }], flito_soat: [], flito_soportes: [] });
    const ajeno = await pedirZip(SOAT, await sesion('proveedor'), { ids: [SOAT_B] });

    kdb.reset(); instalarEspias();
    kdb.when.scenario({ users: [{ p: 'prov-1' }], flito_soat: [filaSoat()], flito_soportes: [] });
    const sinSoporte = await pedirZip(SOAT, await sesion('proveedor'), { ids: [SOAT_A] });

    expect(ajeno.status).toBe(sinSoporte.status);
    expect((ajeno.body as Buffer).toString('utf8')).toBe((sinSoporte.body as Buffer).toString('utf8'));
  });

  it('la consulta del lote es UNA, con `IN`, y no una por id', async () => {
    // El zip anterior llamaba a `buscarConAcceso` id a id: N×2 consultas para 100 ids.
    kdb.when.scenario({
      flito_soat: [filaSoat(), filaSoat({ id: SOAT_B, createdAt: HOY })],
      flito_soportes: [soporte({ ancla: SOAT_A }), soporte({ ancla: SOAT_B })],
    });

    await pedirZip(SOAT, await sesion(), { ids: [SOAT_A, SOAT_B] });

    expect(lecturasDe('flito_soat')).toHaveLength(1);
    expect(lecturasDe('flito_soportes')).toHaveLength(1);
    const { sql } = whereDe('flito_soat');
    expect(sql).toContain('in (');
  });
});

// ─────────────────────────── HU #12815 — canal Cliente y solo `pagado` ───────────────────────────
//
// El mock keyed NO aplica el `where` sobre `flito_soat`: devuelve lo registrado. Por eso el estado y la
// compañía se afirman sobre el SQL RENDERIZADO de la consulta del lote (`whereDe`), y el 409 de «nada
// propio / nada pagado» se simula con el resultado que PostgreSQL daría: ninguna fila.

/** Los valores de `EstadoSoat` que aparecen como parámetro en el WHERE del lote. */
const estadosEnWhere = (params: unknown[]) =>
  Object.values(EstadoSoat).filter((e) => params.includes(e));

describe('HU #12815 AC3 — el lote de SOAT es SOLO `pagado`, para cualquier actor', () => {
  it('admin: el WHERE del lote filtra por `estado` y el único estado es `pagado`', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] })).status).toBe(200);

    const { sql, params } = whereDe('flito_soat');
    expect(sql).toContain('"estado" in (');
    expect(estadosEnWhere(params)).toEqual([EstadoSoat.PAGADO]);
  });

  it('cliente con la función: el mismo `pagado` a secas, junto a su compañía', async () => {
    kdb.when.scenario({
      users: [{ c: 42 }],
      flito_soat: [filaSoat()],
      flito_soportes: [soporte()],
    });

    const r = await pedirZip(SOAT, await sesion('cliente', ['soat.soportes.descargar']), { ids: [SOAT_A] });

    expect(r.status).toBe(200);
    const { sql, params } = whereDe('flito_soat');
    expect(sql).toContain('"estado" in (');
    expect(estadosEnWhere(params)).toEqual([EstadoSoat.PAGADO]);
  });
});

describe('HU #12815 AC1/AC4/AC5 — canal Cliente con la función: su compañía, y el 409 de siempre', () => {
  it('AC1 — cliente con `soat.soportes.descargar` descarga el ZIP (la lista blanca no lo corta)', async () => {
    kdb.when.scenario({
      users: [{ c: 42 }],
      flito_soat: [filaSoat()],
      flito_soportes: [soporte()],
    });

    const r = await pedirZip(SOAT, await sesion('cliente', ['soat.soportes.descargar']), { ids: [SOAT_A] });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
  });

  it('AC5 — la frontera por compañía viaja en el WHERE del lote (lo ajeno es inexistente)', async () => {
    kdb.when.scenario({ users: [{ c: 42 }], flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    await pedirZip(SOAT, await sesion('cliente', ['soat.soportes.descargar']), { ids: [SOAT_A] });

    const { sql, params } = whereDe('flito_soat');
    expect(sql).toContain('"compania_id" = ');
    expect(params).toContain(42);
  });

  it('cliente SIN compañía → 409 y ninguna lectura del lote (nunca la tabla entera)', async () => {
    kdb.when.scenario({ users: [{ c: null }], flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    const r = await pedirZip(SOAT, await sesion('cliente', ['soat.soportes.descargar']), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(lecturasDe('flito_soat')).toHaveLength(0);
  });

  it('AC4/AC5 — ningún id propio y pagado → el MISMO 409, byte a byte, que «sin soporte»', async () => {
    // Lo que PostgreSQL devolvería con ids de otra compañía o no pagados: ninguna fila del lote.
    const cliente = () => sesion('cliente', ['soat.soportes.descargar']);
    kdb.when.scenario({ users: [{ c: 42 }], flito_soat: [], flito_soportes: [] });
    const fuera = await pedirZip(SOAT, await cliente(), { ids: [SOAT_B] });

    kdb.reset(); instalarEspias();
    kdb.when.scenario({ users: [{ c: 42 }], flito_soat: [filaSoat()], flito_soportes: [] });
    const sinSoporte = await pedirZip(SOAT, await cliente(), { ids: [SOAT_A] });

    expect(fuera.status).toBe(409);
    expect(sinSoporte.status).toBe(409);
    expect((fuera.body as Buffer).toString('utf8')).toBe((sinSoporte.body as Buffer).toString('utf8'));
  });
});

describe('HU #12815 — rol externo NO-`cliente` (`davivienda`) con la función: su compañía y nada más', () => {
  // El panel crea roles externos con cualquier código desde la HU #12082. `contextoSoat` decidía por
  // el literal `'cliente'`, y este rol caía en la rama de admin: el ZIP sin filtro de compañía.
  const sesionDavivienda = async (): Promise<string> => {
    const sub = siguienteSub++;
    await registrarUsuarioDePrueba(sub, {
      rol: 'davivienda', tipoPrincipal: 'externo', funcionesDelRol: ['soat.soportes.descargar'], excepciones: [],
    });
    const t = await new SignJWT({ username: 'd@banco.co', role: 'davivienda' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    return `Bearer ${t}`;
  };

  it('id de OTRA compañía → el MISMO 409 que «sin soporte», sin rastro de filas, y el WHERE lleva SU compañía', async () => {
    // Lo que PostgreSQL devolvería con la frontera aplicada a un id ajeno: ninguna fila del lote.
    kdb.when.scenario({ users: [{ c: 42 }], flito_soat: [], flito_soportes: [] });
    const ajeno = await pedirZip(SOAT, await sesionDavivienda(), { ids: [SOAT_B] });

    expect(ajeno.status).toBe(409);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    const { sql, params } = whereDe('flito_soat');
    expect(sql).toContain('"compania_id" = ');
    expect(params).toContain(42);
    expect(estadosEnWhere(params)).toEqual([EstadoSoat.PAGADO]);

    kdb.reset(); instalarEspias();
    kdb.when.scenario({ users: [{ c: 42 }], flito_soat: [filaSoat()], flito_soportes: [] });
    const sinSoporte = await pedirZip(SOAT, await sesionDavivienda(), { ids: [SOAT_A] });

    expect(sinSoporte.status).toBe(409);
    expect((ajeno.body as Buffer).toString('utf8')).toBe((sinSoporte.body as Buffer).toString('utf8'));
  });

  it('sin compañía → 409 y ninguna lectura del lote', async () => {
    kdb.when.scenario({ users: [{ c: null }], flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    const r = await pedirZip(SOAT, await sesionDavivienda(), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(lecturasDe('flito_soat')).toHaveLength(0);
  });
});

// ─────────────────────────── Presupuesto por bytes ──────────────────────────────────────────────

describe('presupuesto — se mide en BYTES y se decide ANTES de abrir el ZIP', () => {
  it('por encima del tope: 422 con `codigo`, sin cabecera de ZIP y sin `archiver`', async () => {
    // `FLITO_ZIP_SOPORTES_MAX_BYTES` por defecto son 1 GiB (1024 MiB); un soporte que declare más lo pasa.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 1100 * 1024 * 1024 })],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    expect(r.status).toBe(422);
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(orden).not.toContain('archiver');
    // Y no se abrió ni un solo documento: el 422 se decide sobre la SUMA, sin tocar MinIO.
    expect(getEntityDocumentStreamMock).not.toHaveBeenCalled();

    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;
    expect(cuerpo.codigo).toBe('zip_demasiado_grande');
    // Dice el TOPE, no cuánto pesaba la selección: eso sería un contador de bytes por filtro.
    expect(cuerpo.error).toContain('1024');
    expect(cuerpo.error).not.toContain('1100');
  });

  it('el ZIP se arma en STORE (zlib level 0): PDF/JPG ya vienen comprimidos (Bug #12644)', async () => {
    // Con level 9 el peor lote legal (300 × 3 MiB) pasa de ~4 s a ~26 s de CPU en el hilo del API
    // (medido en `flito-soportes-zip-coste.test.ts`); el tope de 1 GiB se fijó contando con store.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte({ ancla: SOAT_A })] });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] })).status).toBe(200);
    // `archiver` completa el objeto con sus defaults; lo que se ata es el nivel, no la forma entera.
    expect(opcionesArchiver).toHaveLength(1);
    expect(opcionesArchiver[0]).toMatchObject({ zlib: { level: 0 } });
  });

  it('justo en el tope, 1024 MiB: el borde no se pasa de largo', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 1_073_741_824 })],
    });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] })).status).toBe(200);
  });

  it('la factura de FLIT entra con un CUPO declarado, no con cero', async () => {
    // Sin cupo, un lote de facturas presupuestaría 0 bytes y pasaría por delante del tope
    // entero. 205 facturas × 5 MiB = 1025 MiB > 1024 MiB (default 1 GiB).
    const ids = Array.from({ length: 205 }, (_, i) => `eeeeeeee-0000-0000-0000-${String(i).padStart(12, '0')}`);
    kdb.when.scenario({
      flito_impuestos: ids.map((id, i) => filaImpuesto({
        id, createdAt: new Date(AYER.getTime() + i), facturaVentaFlitId: `fac-${i}`,
      })),
      flito_soportes: [],
    });

    const r = await pedirZip(IMPUESTOS, await sesion(), { ids, tipos: ['factura_venta'] });

    expect(r.status).toBe(422);
    expect(obtenerUrlFacturaMock).not.toHaveBeenCalled();
  });

});

// ─────────────────────────── Tope de registros (por CANTIDAD) ───────────────────────────────────

describe('tope de registros — 400 con código propio, distinguible del 422 por peso', () => {
  const demasiados = (n = ZIP_SOPORTES_MAX_REGISTROS + 1) =>
    Array.from({ length: n }, (_, i) => `eeeeeeee-0000-0000-0000-${String(i).padStart(12, '0')}`);

  it('pasarse del tope es 400 con `codigo`, y NO un 400 crudo de Zod', async () => {
    // El defecto que esto mata: con `.max()` en el esquema, marcar más del tope —lo más fácil de
    // hacer sin querer en una tabla con «seleccionar todo»— caía en la rama genérica del cliente y
    // enseñaba «no se pudo generar el archivo, avisa a soporte».
    const r = await pedirZip(SOAT, await sesion(), { ids: demasiados() });

    expect(r.status).toBe(400);
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, unknown>;
    expect(cuerpo.codigo).toBe('zip_demasiados_registros');
    // Y NO trae el `details` de Zod: si lo trajera, es que sigue saliendo del `.safeParse`.
    expect(cuerpo.details).toBeUndefined();
  });

  it('el mensaje trae el TOPE para que el cliente lo haga eco, y no cuántos mandó', async () => {
    const r = await pedirZip(SOAT, await sesion(), { ids: demasiados(337) });
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;

    expect(cuerpo.error).toContain(String(ZIP_SOPORTES_MAX_REGISTROS));
    // Cuántos mandó ya lo sabe él; repetírselo solo añade una cifra que puede desincronizarse.
    expect(cuerpo.error).not.toContain('337');
  });

  it('se decide ANTES de tocar la base: ni una consulta, ni `archiver`', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    await pedirZip(SOAT, await sesion(), { ids: demasiados() });

    expect(consultas).toHaveLength(0);
    expect(orden).not.toContain('archiver');
  });

  it('EXACTAMENTE el tope pasa: el borde no se cierra de más', async () => {
    const ids = demasiados(ZIP_SOPORTES_MAX_REGISTROS);
    kdb.when.scenario({
      flito_soat: [filaSoat({ id: ids[0] })],
      flito_soportes: [soporte({ ancla: ids[0] })],
    });

    expect((await pedirZip(SOAT, await sesion(), { ids })).status).toBe(200);
  });

  it('**el código por CANTIDAD es distinto del de PESO**, y los mensajes dicen cosas distintas', async () => {
    // Si compartieran código, el copy tendría que ser vago para valer en los dos y no diría la
    // verdad en ninguno: el de peso se choca con 3 filas marcadas y se resuelve quitando documentos
    // pesados; el de cantidad se choca con documentos de 1 KB y se resuelve marcando menos filas.
    const porCantidad = await pedirZip(SOAT, await sesion(), { ids: demasiados() });

    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 1100 * 1024 * 1024 })],
    });
    const porPeso = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    const cCantidad = JSON.parse((porCantidad.body as Buffer).toString('utf8')) as Record<string, string>;
    const cPeso = JSON.parse((porPeso.body as Buffer).toString('utf8')) as Record<string, string>;

    expect(porCantidad.status).toBe(400);
    expect(porPeso.status).toBe(422);
    expect(cCantidad.codigo).not.toBe(cPeso.codigo);
    expect(cCantidad.error).not.toBe(cPeso.error);
    // El de peso NO puede decir «marca menos registros»: se choca con pocas filas muy pesadas.
    expect(cPeso.error).toContain('pesan');
    expect(cCantidad.error).toContain('a la vez');
  });

  it('el tope es el MISMO en las tres rutas', async () => {
    // El `catch` unificado por `ZipError` es lo que garantiza esto: con tres `instanceof` sueltos,
    // añadir un código nuevo y olvidarse en una ruta la devuelve a la rama genérica sin `codigo`.
    const app = await buildApp();
    for (const [base, extra] of [
      [SOAT, {}],
      [IMPUESTOS, { tipos: ['recibo_impuesto'] }],
      [TRAMITES, { tipos: ['factura_soat'] }],
    ] as const) {
      const r = await request(app).post(`${base}/soportes/zip`)
        .set('Authorization', await sesion()).responseType('blob')
        .send({ ids: demasiados(), ...extra } as object);
      const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;
      expect(r.status, `${base} tenía que rechazar por cantidad`).toBe(400);
      expect(cuerpo.codigo, `${base} tenía que traer el código propio`).toBe('zip_demasiados_registros');
    }
  });
});

// ─────────────────────────── Las cifras del aviso parcial ───────────────────────────────────────

describe('caso parcial — el ZIP dice CUÁNTO trae, en cabeceras', () => {
  it('5 marcadas y 2 con soporte: `X-Soportes-Registros: 2`, y el archivo sale igual', async () => {
    // El acuerdo de UX es «se descarga y se avisa con cifras». Sin la cabecera el cliente no puede
    // avisar de nada y el mensaje se queda en el genérico: la decisión no ocurre en producción
    // aunque el cliente esté escrito para ella.
    const ids = [
      SOAT_A, SOAT_B,
      ...Array.from({ length: 3 }, (_, i) => `ffffffff-0000-0000-0000-00000000000${i}`),
    ];
    kdb.when.scenario({
      // Solo dos de los cinco marcados existen para esta petición. Los otros tres no se distinguen
      // entre «no existe», «no es tuyo» y «sin documento»: los tres son el mismo silencio.
      flito_soat: [filaSoat(), filaSoat({ id: SOAT_B, placa: 'QWE789', createdAt: HOY })],
      flito_soportes: [soporte({ ancla: SOAT_A }), soporte({ ancla: SOAT_B })],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids });

    expect(r.status).toBe(200);
    expect(r.headers['x-soportes-incluidos']).toBe('2');
    expect(r.headers['x-soportes-registros']).toBe('2');
    expect(await entradasDe(r.body as Buffer)).toHaveLength(2);
  });

  it('**las dos cifras NO son la misma**: un trámite aporta tres documentos', async () => {
    // El defecto que mata este test: publicar solo `incluidos` y dejar que la pantalla componga
    // «N de las que marcaste» daría «3 de 1» —o «6 de 5»— en el ZIP mixto. Una cifra falsa con
    // aspecto de cierta es peor que ninguna.
    kdb.when.scenario({
      flito_tramites: [filaTramite()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto' }),
        soporte({ ancla: SOAT_A, tipo: 'factura_soat' }),
      ],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(TRAMITES, await sesion(), {
      ids: [TRAMITE_A], tipos: ['factura_venta', 'recibo_impuesto', 'factura_soat'],
    });

    // HU #12817: sale UN PDF, pero `incluidos` sigue contando DOCUMENTOS (los tres, dentro de él).
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123.pdf']);
    expect(r.headers['x-soportes-incluidos']).toBe('3'); // DOCUMENTOS
    expect(r.headers['x-soportes-registros']).toBe('1'); // TRÁMITES que aportaron
  });

  it('las cifras van en la cabecera y ANTES del primer byte, no como trailer', async () => {
    // Poder ponerlas es consecuencia directa del orden invertido del AC6: `entradas` ya está
    // resuelto. Un trailer no lo lee `fetch` sin streams, así que la cifra se perdería.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    expect(r.headers['x-soportes-incluidos']).toBe('1');
    expect(r.headers['content-disposition']).toContain('attachment');
  });

  it('el nombre de las cabeceras sale de shared-types, no de un literal en cada punta', async () => {
    // El nombre de la cabecera ES el contrato: un literal repetido en cliente y servidor se
    // desincroniza sin que nada avise, y el síntoma es que el aviso vuelve al genérico, en verde.
    expect(CABECERAS_ZIP_SOPORTES.incluidos).toBe('X-Soportes-Incluidos');
    expect(CABECERAS_ZIP_SOPORTES.registros).toBe('X-Soportes-Registros');
    expect(CABECERAS_ZIP_SOPORTES.omitidos).toBe('X-Soportes-Omitidos');
  });

  it('el 409 NO lleva las cifras: no hay archivo del que informar', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(r.headers['x-soportes-incluidos']).toBeUndefined();
    expect(r.headers['x-soportes-registros']).toBeUndefined();
  });

  it('CORS expone las tres cabeceras: sin eso un cliente cross-origin no las ve', async () => {
    // `fetch` solo expone las seis cabeceras de la lista segura de CORS y DESCARTA el resto EN
    // SILENCIO —sin error en consola ni en la pestaña de red—. Hoy el front va same-origin (proxy de
    // Vite en dev, nginx en producción), así que esto es la defensa para el día que un cliente entre
    // por `corsOrigins`, que existe precisamente para eso.
    const fuente = readFileSync(fileURLToPath(new URL('../../src/app.ts', import.meta.url)), 'utf8');
    expect(fuente).toContain('exposedHeaders');
    expect(fuente).toContain('CABECERAS_ZIP_SOPORTES.incluidos');
    expect(fuente).toContain('CABECERAS_ZIP_SOPORTES.registros');
    expect(fuente).toContain('CABECERAS_ZIP_SOPORTES.omitidos');
  });
});

// ─────────────────────────── Rastro PII y bitácora ──────────────────────────────────────────────

describe('rastro — antes del primer byte, y con lo que el ZIP publica de verdad', () => {
  it('SOAT: una línea `export`, con las entradas REALES, antes de `archiver`', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat(), filaSoat({ id: SOAT_B, createdAt: HOY })],
      flito_soportes: [soporte({ ancla: SOAT_A }), soporte({ ancla: SOAT_B })],
    });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A, SOAT_B] })).status).toBe(200);

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const acceso = ultimoAcceso();
    expect(acceso.accion).toBe('export');
    expect(acceso.resourceTipo).toBe('flito_soat');
    expect(String(acceso.motivo)).toContain('archivo=zip_soportes');
    expect(String(acceso.motivo)).toContain('filas=2');
    // Invertir las dos mitades de la ruta no cambia ninguna respuesta: solo este aserto lo ve.
    expect(orden).toEqual(['pii', 'archiver']);
  });

  it('`campos_accedidos` declara la PLACA y NO el correo ni la dirección', async () => {
    // La placa viaja en el nombre de cada entrada; el correo y la dirección son del `.xlsx`, no de
    // aquí. Declarar de más hace que el registro deje de decir la verdad.
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    const campos = ultimoAcceso().camposAccedidos as string[];

    expect(campos).toContain('placa');
    expect(campos).not.toContain('correo');
    expect(campos).not.toContain('direccion');
  });

  it('**Impuestos registra el acceso**: el zip retirado auditaba y NO dejaba rastro del art. 17', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto' })],
    });

    await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['recibo_impuesto'] });

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso().resourceTipo).toBe('flito_impuesto');
    expect(String(ultimoAcceso().motivo)).toContain('archivo=zip_soportes');
  });

  it('Trámites registra con SU propio `resource_tipo`, una sola línea', async () => {
    // Ni dos filas para una lectura, ni el `resource_tipo` de otra cola: `flito_tramite` es el mismo
    // literal con el que `audit()` anota las escrituras de ese router.
    kdb.when.scenario({
      flito_tramites: [filaTramite({ facturaVentaFlitId: null })],
      flito_soportes: [soporte({ ancla: SOAT_A })],
    });

    await pedirZip(TRAMITES, await sesion(), { ids: [TRAMITE_A], tipos: ['factura_soat'] });

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso().resourceTipo).toBe('flito_tramite');
    expect(String(ultimoAcceso().motivo)).not.toContain('ASD123');
  });

  it('el `motivo` no lleva la placa ni los ids del lote', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    const motivo = String(ultimoAcceso().motivo);

    expect(motivo).not.toContain('ASD123');
    expect(motivo).not.toContain(SOAT_A);
  });
});

// ─────────────────────────── El nombre externo y las cabeceras ──────────────────────────────────

describe('el nombre del archivo no lleva datos de nadie', () => {
  it('`attachment; filename="soportes_YYYYMMDD-HHmm.zip"`, `no-store`, y sin placa', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    const disposition = String(r.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="soportes_\d{8}-\d{4}\.zip"$/);
    // La placa va DENTRO, en los nombres de las entradas. El nombre externo acaba en el sistema de
    // archivos de quien descarga y en cualquier adjunto que reenvíe: misma razón que el `.xlsx`.
    expect(disposition).not.toContain('ASD123');
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['content-type']).toContain('application/zip');
  });
});

// ─────────────────────────── La cuota es UNA para las tres rutas ────────────────────────────────

describe('cuota — una sola bolsa, y por usuario', () => {
  it('agotar los 5 en SOAT devuelve 429 en Impuestos y en Trámites', async () => {
    // Sin Redis, `makeStore` devuelve `undefined` y `express-rate-limit` crea un `MemoryStore` POR
    // LLAMADA: tres `rateLimit()` con la misma llave compartirían el nombre y no el contador, así que
    // el código se leería idéntico y el freno valdría el triple. Con una app por módulo esto pasaría
    // en verde igualmente, y por eso los tres routers están montados juntos.
    const cabecera = await sesion();
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });
    const app = await buildApp();

    for (let i = 1; i <= 5; i += 1) {
      const r = await request(app).post(`${SOAT}/soportes/zip`)
        .set('Authorization', cabecera).responseType('blob').send({ ids: [SOAT_A] });
      expect(r.status, `la descarga ${i} tenía que caber en la cuota`).toBe(200);
    }

    const sexto = await request(app).post(`${IMPUESTOS}/soportes/zip`)
      .set('Authorization', cabecera).responseType('blob').send({ ids: [IMP_A], tipos: ['recibo_impuesto'] });
    expect(sexto.status).toBe(429);

    const septimo = await request(app).post(`${TRAMITES}/soportes/zip`)
      .set('Authorization', cabecera).responseType('blob').send({ ids: [TRAMITE_A], tipos: ['factura_soat'] });
    expect(septimo.status).toBe(429);
  });

  it('la bolsa es POR USUARIO: otro `sub` sigue pudiendo descargar', async () => {
    const cabecera = await sesion();
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [soporte()] });
    const app = await buildApp();

    for (let i = 1; i <= 5; i += 1) {
      await request(app).post(`${SOAT}/soportes/zip`)
        .set('Authorization', cabecera).responseType('blob').send({ ids: [SOAT_A] });
    }
    expect((await request(app).post(`${SOAT}/soportes/zip`)
      .set('Authorization', cabecera).responseType('blob').send({ ids: [SOAT_A] })).status).toBe(429);

    // `userOrIpKey` y no la IP pelada: varios usuarios de Operaciones salen por la misma IP.
    const otro = await request(app).post(`${SOAT}/soportes/zip`)
      .set('Authorization', await sesion()).responseType('blob').send({ ids: [SOAT_A] });
    expect(otro.status).toBe(200);
  });

  it('la bolsa del ZIP es DISTINTA de la del `.xlsx`', async () => {
    // Son dos recursos distintos: aquella raciona heap (`sendExcel` arma el workbook entero en
    // memoria) y esta I/O con compresión en streaming. Compartirlas haría que la medición de
    // ADR-0004 dejara de decir nada sobre ninguna de las dos.
    const cabecera = await sesion();
    kdb.when.scenario({
      flito_soat: [filaSoat()], flito_soportes: [soporte()],
      flito_tramites: [], flito_compradores: [],
    });
    const app = await buildApp();

    for (let i = 1; i <= 5; i += 1) {
      await request(app).post(`${SOAT}/soportes/zip`)
        .set('Authorization', cabecera).responseType('blob').send({ ids: [SOAT_A] });
    }

    const excel = await request(app).post(`${SOAT}/export`)
      .set('Authorization', cabecera).responseType('blob').send({});
    expect(excel.status).toBe(200);
  });
});

// ─────────────────────────── Un documento que falla no tumba el ZIP ─────────────────────────────

describe('un documento que no se puede abrir se omite y QUEDA EN EL LOG', () => {
  it('el resto del archivo sale igual', async () => {
    // El molde tenía un `catch {}` mudo: un soporte que no llegaba desaparecía sin dejar rastro en
    // ninguna parte y nadie podía saber por qué el ZIP traía nueve de diez.
    kdb.when.scenario({
      flito_soat: [filaSoat(), filaSoat({ id: SOAT_B, placa: 'QWE789', createdAt: HOY })],
      flito_soportes: [
        soporte({ ancla: SOAT_A, storageKey: 'clave/inexistente.pdf' }),
        soporte({ ancla: SOAT_B }),
      ],
    });
    // La clave del primero se borra para que el stream falle al abrirse.
    contenidoPorClave.delete('clave/inexistente.pdf');

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A, SOAT_B] });

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual(['QWE789.pdf']);
  });
});
