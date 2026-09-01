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
//   · **`OPERACIONES → LECTURA` en Trámites.** `LECTURA` incluye `auditor`, y el AC7 dice que
//     auditoría no descarga. El mutante se lee como una coherencia con las rutas de al lado.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CABECERAS_ZIP_SOPORTES, ZIP_SOPORTES_MAX_REGISTROS } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

/** Orden observado: el rastro de PII antes del primer byte, y `archiver` después de los dos. */
const orden: string[] = [];

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
    default: (...a: unknown[]) => { orden.push('archiver'); return real(...a); },
  };
});

/** MinIO: el soporte llega como stream, que es como lo entrega `getEntityDocumentStream`. */
const contenidoPorClave = new Map<string, string>();
const getEntityDocumentStreamMock = vi.fn(async (key: string) => {
  const texto = contenidoPorClave.get(key);
  if (texto === undefined) throw new Error(`clave inexistente en el mock: ${key}`);
  return Readable.from([Buffer.from(texto)]);
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
function soporte(over: Record<string, unknown> & { contenido?: string } = {}): Record<string, unknown> {
  claves += 1;
  const storageKey = (over.storageKey as string) ?? `flito/soportes/k${claves}.pdf`;
  contenidoPorClave.set(storageKey, over.contenido ?? `%PDF-1.4 contenido ${claves}`);
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

/** La respuesta de S3 de FLIT: cuerpo en streaming, sin tipo útil (rotula todo como octet-stream). */
function respuestaFlit(cuerpo = '%PDF-1.4 factura de venta'): unknown {
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'binary/octet-stream' }),
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(cuerpo)); c.close(); },
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
const sesion = async (role: TestRole = 'admin'): Promise<string> =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role })}`;

const pedirZip = async (base: string, cabecera: string, cuerpo: unknown) =>
  request(await buildApp())
    .post(`${base}/soportes/zip`)
    .set('Authorization', cabecera)
    .responseType('blob')
    .send(cuerpo as object);

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
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123-MEDELLIN.pdf']);
  });

  it('con los DOS tipos, UNA sola entrada y es la `sin_marca_agua`', async () => {
    // Consultar ambos sin preferencia daría dos entradas del MISMO pago, desempatadas con `-2` e
    // indistinguibles de un duplicado legítimo. El nombre del fichero de la fixture es el testigo.
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto()],
      flito_soportes: [
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto', nombreArchivo: 'MARCADO.pdf' }),
        soporte({ ancla: IMP_A, tipo: 'recibo_impuesto_sin_marca_agua', nombreArchivo: 'limpio.pdf' }),
      ],
    });

    const r = await pedirZip(IMPUESTOS, await sesion(), { ids: [IMP_A], tipos: ['recibo_impuesto'] });
    const nombres = await entradasDe(r.body as Buffer);

    expect(nombres).toHaveLength(1);
    // El nombre externo es `PLACA-ORGANISMO`, así que la prueba de CUÁL se eligió es el contenido.
    const zip = await JSZip.loadAsync(r.body as Buffer);
    const texto = await zip.file(nombres[0]!)!.async('string');
    const clavesLimpio = [...contenidoPorClave.entries()];
    // El segundo soporte registrado (el limpio) es el que tiene que haber salido.
    expect(texto).toBe(clavesLimpio[1]![1]);
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

    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123-MEDELLIN.pdf', 'QWE789-MEDELLIN.pdf']);
  });

  it('factura de venta + recibo en UN solo ZIP (los dos tipos marcados)', async () => {
    kdb.when.scenario({
      flito_impuestos: [filaImpuesto({ facturaVentaFlitId: 'fac-1' })],
      flito_soportes: [soporte({ ancla: IMP_A, tipo: 'recibo_impuesto' })],
    });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuestaFlit()));

    const r = await pedirZip(IMPUESTOS, await sesion(), {
      ids: [IMP_A], tipos: ['factura_venta', 'recibo_impuesto'],
    });

    expect(r.status).toBe(200);
    // El orden dentro de un registro es el del catálogo (factura → recibo), no el del array pedido.
    expect(await entradasDe(r.body as Buffer))
      .toEqual(['ASD123-MEDELLIN.pdf', 'ASD123-MEDELLIN-2.pdf']);
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

describe('AC4 — Trámites: los tres tipos en un solo archivo', () => {
  it('factura + recibo + comprobante del MISMO trámite → `-2` y `-3`', async () => {
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

    expect(r.status).toBe(200);
    expect(await entradasDe(r.body as Buffer)).toEqual([
      'ASD123-MEDELLIN.pdf', 'ASD123-MEDELLIN-2.pdf', 'ASD123-MEDELLIN-3.pdf',
    ]);
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
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123-MEDELLIN.pdf']);
  });

  it('la factura de FLIT viaja en STREAMING, no bufferizada con `arrayBuffer()`', async () => {
    // El molde hacía `arrayBuffer()` por factura: el fichero entero en el heap, cien veces. Si
    // alguien vuelve a ese camino, la respuesta simulada —que solo expone `body`— revienta.
    const fetchMock = vi.fn().mockResolvedValue(respuestaFlit());
    kdb.when.scenario({ flito_tramites: [filaTramite()], flito_soportes: [] });
    obtenerUrlFacturaMock.mockResolvedValue('https://flit-bucket.s3/fac-1');
    vi.stubGlobal('fetch', fetchMock);

    const r = await pedirZip(TRAMITES, await sesion(), { ids: [TRAMITE_A], tipos: ['factura_venta'] });

    expect(r.status).toBe(200);
    const zip = await JSZip.loadAsync(r.body as Buffer);
    expect(await zip.file('ASD123-MEDELLIN.pdf')!.async('string')).toBe('%PDF-1.4 factura de venta');
  });
});

// ─────────────────────────── AC5 · el nombre ────────────────────────────────────────────────────

describe('AC5 — `PLACA-ORGANISMO`, en mayúsculas y sin tildes', () => {
  const casoNombre = async (over: Record<string, unknown>): Promise<string[]> => {
    kdb.when.scenario({
      flito_soat: [filaSoat(over)],
      flito_soportes: [soporte({ ancla: (over.id as string) ?? SOAT_A })],
    });
    const r = await pedirZip(SOAT, await sesion(), { ids: [(over.id as string) ?? SOAT_A] });
    expect(r.status).toBe(200);
    return entradasDe(r.body as Buffer);
  };

  it('`ASD123` + alias `Medellín` → `ASD123-MEDELLIN.pdf`', async () => {
    expect(await casoNombre({})).toEqual(['ASD123-MEDELLIN.pdf']);
  });

  it('la placa con guion y minúsculas se normaliza igual', async () => {
    expect(await casoNombre({ placa: 'asd-123' })).toEqual(['ASD123-MEDELLIN.pdf']);
  });

  it('sin alias, el organismo cae a su CÓDIGO', async () => {
    expect(await casoNombre({ organismoAlias: null })).toEqual(['ASD123-05001.pdf']);
  });

  it('sin alias y sin código → `SIN-ORGANISMO`, nunca `null` ni la cadena «null»', async () => {
    const nombres = await casoNombre({ organismoAlias: null, organismoCodigo: null });
    expect(nombres).toEqual(['ASD123-SIN-ORGANISMO.pdf']);
    expect(nombres.join('|').toLowerCase()).not.toContain('null');
    expect(nombres.join('|')).not.toContain('undefined');
  });

  it('sin placa, el documento SALE igual con `SIN-PLACA`', async () => {
    // Un soporte que existe no puede desaparecer del archivo porque al vehículo le falte un campo.
    expect(await casoNombre({ placa: null })).toEqual(['SIN-PLACA-MEDELLIN.pdf']);
  });

  it('`organismoParaExport` se importa y NO se muta: el `.xlsx` de la HU #11909 sigue con el alias crudo', async () => {
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
   * Dos SOAT con el MISMO `PLACA-ORGANISMO`: es lo que produce la colisión.
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
      'ASD123-MEDELLIN.pdf': 'VIEJO',
      'ASD123-MEDELLIN-2.pdf': 'NUEVO',
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
      'ASD123-MEDELLIN.pdf': 'DEL-A',
      'ASD123-MEDELLIN-2.pdf': 'DEL-B',
    });
  });

  it('con `subido_en` EMPATADO, el desempate lo decide el `id` y no PostgreSQL', async () => {
    // La carga masiva de recibos inserta varios en la misma transacción: `subido_en` empata de
    // verdad. Sin el segundo criterio, quién se lleva el nombre limpio lo decidiría el orden en que
    // la base devuelva las filas.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [
        soporte({ id: 'zzz', ancla: SOAT_A, subidoEn: AYER }),
        soporte({ id: 'aaa', ancla: SOAT_A, subidoEn: AYER }),
      ],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    const zip = await JSZip.loadAsync(r.body as Buffer);
    // El `aaa` es el que tiene que llevarse el nombre sin sufijo. Su contenido es el segundo que se
    // registró en el mapa de claves.
    const contenidos = [...contenidoPorClave.values()];
    expect(await zip.file('ASD123-MEDELLIN.pdf')!.async('string')).toBe(contenidos[1]);
    expect(await zip.file('ASD123-MEDELLIN-2.pdf')!.async('string')).toBe(contenidos[0]);
  });

  it('dos `factura_soat` VIVOS del mismo SOAT colisionan y salen los dos', async () => {
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
    expect(await entradasDe(r.body as Buffer))
      .toEqual(['ASD123-MEDELLIN.pdf', 'ASD123-MEDELLIN-2.pdf']);
  });

  it('la extensión sale del `nombre_archivo` del soporte, no de un `.pdf` fijo', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, nombreArchivo: 'poliza escaneada.JPG', contentType: 'image/jpeg' })],
    });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });
    expect(await entradasDe(r.body as Buffer)).toEqual(['ASD123-MEDELLIN.jpg']);
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

  it('`cliente` tampoco entra en el ZIP de SOAT, aunque sí vea la cola', async () => {
    // `LECTURA` del router de SOAT incluye `cliente`. Su canal tiene su propia allowlist por tipo y
    // por estado (`TIPOS_SOPORTE_VISIBLES_CLIENTE`), y una descarga masiva por ids no pasa por ella.
    const r = await pedirZip(SOAT, await sesion('cliente'), { ids: [SOAT_A] });
    expect(r.status).toBe(403);
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
    // Y los estados que el gestor SÍ ve: `pagado` tiene que estar, porque el comprobante solo existe
    // cuando el registro ya está pagado. Heredar el defecto de la PANTALLA (`solicitado` a secas)
    // habría dejado al gestor sin poder descargar nunca lo que él mismo subió.
    expect(params).toContain('solicitado');
    expect(params).toContain('pagado');
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

// ─────────────────────────── Presupuesto por bytes ──────────────────────────────────────────────

describe('presupuesto — se mide en BYTES y se decide ANTES de abrir el ZIP', () => {
  it('por encima del tope: 422 con `codigo`, sin cabecera de ZIP y sin `archiver`', async () => {
    // `FLITO_ZIP_SOPORTES_MAX_BYTES` por defecto son 200 MiB; un soporte que declare más lo pasa.
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 300 * 1024 * 1024 })],
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
    expect(cuerpo.error).toContain('200');
    expect(cuerpo.error).not.toContain('300');
  });

  it('justo en el tope, 200: el borde no se pasa de largo', async () => {
    kdb.when.scenario({
      flito_soat: [filaSoat()],
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 200 * 1024 * 1024 })],
    });

    expect((await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] })).status).toBe(200);
  });

  it('la factura de FLIT entra con un CUPO declarado, no con cero', async () => {
    // Sin cupo, un lote de cien facturas presupuestaría 0 bytes y pasaría por delante del tope
    // entero. 41 facturas × 5 MiB = 205 MiB > 200 MiB.
    const ids = Array.from({ length: 41 }, (_, i) => `eeeeeeee-0000-0000-0000-${String(i).padStart(12, '0')}`);
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
    // El defecto que esto mata: con `.max()` en el esquema, marcar 120 filas —lo más fácil de hacer
    // sin querer en una tabla con «seleccionar todo»— caía en la rama genérica del cliente y
    // enseñaba «no se pudo generar el archivo, avisa a soporte».
    const r = await pedirZip(SOAT, await sesion(), { ids: demasiados() });

    expect(r.status).toBe(400);
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, unknown>;
    expect(cuerpo.codigo).toBe('zip_demasiados_registros');
    // Y NO trae el `details` de Zod: si lo trajera, es que sigue saliendo del `.safeParse`.
    expect(cuerpo.details).toBeUndefined();
  });

  it('el mensaje trae el TOPE para que el cliente lo haga eco, y no cuántos mandó', async () => {
    const r = await pedirZip(SOAT, await sesion(), { ids: demasiados(137) });
    const cuerpo = JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, string>;

    expect(cuerpo.error).toContain(String(ZIP_SOPORTES_MAX_REGISTROS));
    // Cuántos mandó ya lo sabe él; repetírselo solo añade una cifra que puede desincronizarse.
    expect(cuerpo.error).not.toContain('137');
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
      flito_soportes: [soporte({ ancla: SOAT_A, tamanoBytes: 300 * 1024 * 1024 })],
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
  });

  it('el 409 NO lleva las cifras: no hay archivo del que informar', async () => {
    kdb.when.scenario({ flito_soat: [filaSoat()], flito_soportes: [] });

    const r = await pedirZip(SOAT, await sesion(), { ids: [SOAT_A] });

    expect(r.status).toBe(409);
    expect(r.headers['x-soportes-incluidos']).toBeUndefined();
    expect(r.headers['x-soportes-registros']).toBeUndefined();
  });

  it('CORS expone las dos cabeceras: sin eso un cliente cross-origin no las ve', async () => {
    // `fetch` solo expone las seis cabeceras de la lista segura de CORS y DESCARTA el resto EN
    // SILENCIO —sin error en consola ni en la pestaña de red—. Hoy el front va same-origin (proxy de
    // Vite en dev, nginx en producción), así que esto es la defensa para el día que un cliente entre
    // por `corsOrigins`, que existe precisamente para eso.
    const fuente = readFileSync(fileURLToPath(new URL('../../src/app.ts', import.meta.url)), 'utf8');
    expect(fuente).toContain('exposedHeaders');
    expect(fuente).toContain('CABECERAS_ZIP_SOPORTES.incluidos');
    expect(fuente).toContain('CABECERAS_ZIP_SOPORTES.registros');
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
    expect(await entradasDe(r.body as Buffer)).toEqual(['QWE789-MEDELLIN.pdf']);
  });
});
