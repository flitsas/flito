// FLITO Impuestos — CA-10 con VARIOS organismos (HU #12053, Feature #12052).
//
// La frontera del gestor dejó de ser un código y pasó a ser una LISTA leída de
// `flito_gestor_organismos`. Este archivo existe aparte de `flito-impuestos.workflow.test.ts` porque
// lo que hay que probar no es «el gestor ve lo suyo» —eso ya estaba— sino las tres cosas que solo
// aparecen al pasar de uno a N:
//
//   1. con DOS organismos entran los DOS en el SQL (un `eq(…, ctx.organismos[0])` pasaría todos los
//      asertos de un solo organismo y le escondería al gestor la mitad de su cola);
//   2. con la lista VACÍA no ve NADA — ni la cola, ni el detalle, ni el cruce de un recibo. Es lo
//      contrario de «sin filtros», y es el agujero que la HU cierra;
//   3. el detalle de un impuesto fuera de la lista es 404 y no 403 (un 403 ya confirma que existe).
//
// **Los mocks de este repo mienten y aquí se cuenta con ello.** El `chain` de los helpers devuelve
// la fila entera aunque el `select` pidiera menos y es indiferente al `orderBy`, así que ningún
// aserto de este archivo se hace sobre las filas que el mock devuelve: se hacen sobre el **SQL
// RENDERIZADO** (`PgDialect().sqlToQuery`) y sobre CUÁNTAS consultas se emitieron. Un mutante que
// borre la frontera cambia el SQL o el número de consultas; no cambia las filas del fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

/** El OCR no se llama de verdad: lo único que hace falta es que el recibo «diga» una placa. */
const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/flito-ocr/flito-ocr.service.js')>();
  return { ...actual, extraerReciboImpuesto: (...args: unknown[]) => extraerMock(...args) };
});
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('s3://no-deberia-llegar-aqui'),
}));

/** Los WHERE tal cual los recibió drizzle: lo que se afirma es el SQL, no las filas del fixture. */
const wheres: unknown[] = [];

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  insertMock.mockReset();
  transactionMock.mockReset();
  extraerMock.mockReset();
  wheres.length = 0;
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}

const auth = async (role: TestRole = 'gestor_impuestos') =>
  `Bearer ${await testToken({ sub: 5, username: 'gestor@flito.co', role })}`;

const ORG_A = '05001';
const ORG_B = '05266';
const AJENO = '08001';
const UUID = '00000000-0000-0000-0000-0000000000cc';

const render = (cond: unknown) => {
  const q = new PgDialect().sqlToQuery(cond as never);
  return { sql: q.sql, params: q.params as unknown[] };
};

/** `contextoImpuesto` lee `flito_gestor_organismos`: una fila por organismo. */
const contexto = (...codigos: string[]) => selectMock.mockReturnValueOnce(chain(codigos.map((codigo) => ({ codigo }))));

/** Encola las dos consultas de la cola (conteo y página) capturando su WHERE. */
function capturarCola(): void {
  const captura = (filas: unknown[]) => {
    const t: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'limit', 'offset', 'orderBy', 'groupBy', '$dynamic']) t[m] = () => t;
    t.where = (c: unknown) => { wheres.push(c); return t; };
    t.then = (res: (v: unknown) => unknown) => Promise.resolve(filas).then(res);
    return t;
  };
  selectMock.mockReturnValueOnce(captura([{ total: 0 }]) as never);
  selectMock.mockReturnValueOnce(captura([]) as never);
}

describe('CA-10 con lista — la cola (AC6)', () => {
  it('TC-12053-21: un gestor con DOS organismos los lleva LOS DOS al WHERE', async () => {
    contexto(ORG_A, ORG_B);
    capturarCola();

    const r = await request(await buildApp()).get('/api/flito/impuestos').set('Authorization', await auth());

    expect(r.status).toBe(200);
    // Los DOS where —el del conteo y el de la página—, no solo el de las filas: si no, el total
    // seguiría contando lo que ya no se ve.
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      const { sql, params } = render(w);
      expect(sql).toContain('organismo_codigo');
      // El aserto que mata el atajo `eq(…, ctx.organismos[0])`: tienen que estar LOS DOS.
      expect(params).toContain(ORG_A);
      expect(params).toContain(ORG_B);
      // Y las otras dos fronteras siguen: nada asumido por Operaciones, y `pendiente` NUNCA.
      expect(sql).toContain('gestion_operaciones');
      expect(params).toContain('solicitado');
      expect(params).not.toContain('pendiente');
    }
  });

  it('TC-12053-22: con la lista VACÍA no ve NADA — ni se consulta la tabla', async () => {
    contexto(); // ninguna fila en `flito_gestor_organismos`
    capturarCola(); // encoladas a propósito: si se llegaran a usar, el fixture las delataría

    const r = await request(await buildApp()).get('/api/flito/impuestos').set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    // «Sin frontera no ve nada», no «sin filtros»: el defecto que esto mata es servirle la tabla
    // ENTERA. Ni el conteo se emite, así que ni siquiera sabe cuántas filas hay.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(wheres).toHaveLength(0);
  });

  it('TC-12053-22 (bis): a Operaciones no se le acota nada, como siempre', async () => {
    capturarCola(); // `admin` no consulta la tabla puente: su contexto no la necesita

    const r = await request(await buildApp()).get('/api/flito/impuestos').set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(wheres).toHaveLength(2);
    const { sql } = render(wheres[0]);
    expect(sql).not.toContain('organismo_codigo');
  });
});

describe('CA-10 con lista — el detalle (AC6)', () => {
  it('TC-12053-23: un impuesto de un organismo FUERA de la lista → 404, no 403', async () => {
    contexto(ORG_A, ORG_B);
    selectMock.mockReturnValueOnce(chain([{ imp: { id: UUID, organismoCodigo: AJENO, estado: 'solicitado', gestionOperaciones: false }, dentroDeFrontera: true }]));

    const r = await request(await buildApp()).get(`/api/flito/impuestos/${UUID}`).set('Authorization', await auth());

    // 404 y no 403: un 403 ya le confirmaría que ese id existe.
    expect(r.status).toBe(404);
  });

  /**
   * Los dos siguientes van contra `buscarConAcceso` y no contra la ruta: es la función que APLICA la
   * frontera, y por HTTP el camino feliz arrastra tres consultas más (la fila de la cola, el
   * ensamblado y los soportes) que no tienen nada que ver con lo que se prueba aquí.
   */
  const ctxDe = (...organismos: string[]) => ({ userId: 5, username: 'gestor@flito.co', role: 'gestor_impuestos', organismos });

  it('TC-12053-23 (bis): el SEGUNDO organismo de la lista SÍ se le sirve', async () => {
    const { buscarConAcceso } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    selectMock.mockReturnValueOnce(chain([{ imp: { id: UUID, organismoCodigo: ORG_B, estado: 'solicitado', gestionOperaciones: false }, dentroDeFrontera: true }]));

    // Con `ctx.organismos[0]` esto sería `null`: el gestor perdería la mitad de su ámbito sin que
    // ningún error lo delate.
    expect(await buscarConAcceso(UUID, ctxDe(ORG_A, ORG_B))).not.toBeNull();
  });

  it('TC-12053-23 (ter): con la lista vacía, ni el detalle de un impuesto cualquiera', async () => {
    const { buscarConAcceso } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    selectMock.mockReturnValueOnce(chain([{ imp: { id: UUID, organismoCodigo: ORG_A, estado: 'solicitado', gestionOperaciones: false }, dentroDeFrontera: true }]));

    expect(await buscarConAcceso(UUID, ctxDe())).toBeNull();
  });
});

describe('CA-10 con lista — la conciliación de recibos', () => {
  it('TC-12053-22 (recibos): un gestor SIN organismos no cruza con NADA', async () => {
    // El agujero que esto cierra es preexistente y no es de la cola: `buscarCandidato` traducía
    // «sin código» por «sin acotar», así que el gestor que la propia API producía —sin
    // `transito_codigo`, porque se lo prohibía— conciliaba contra impuestos de CUALQUIER organismo,
    // incluidos los asumidos por Operaciones. La cola le salía vacía; la conciliación, no.
    const { cargarRecibos } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
    extraerMock.mockResolvedValue({ placa: { valor: 'ABC123', confianza: 0.99, confiable: true } });
    selectMock.mockReturnValueOnce(chain([])); // CA-08: el archivo no está duplicado por hash

    const res = await cargarRecibos(
      [{ originalname: 'recibo.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x'), size: 1 }],
      true,
      { userId: 5, username: 'gestor@flito.co', role: 'gestor_impuestos', organismos: [] },
    );

    expect(res.conciliados).toHaveLength(0);
    expect(res.complementos).toHaveLength(0);
    expect(res.noAsociados).toHaveLength(1);
    // La prueba de que no cruzó: la ÚNICA consulta emitida es la del dedup por hash. Ni el candidato
    // en gestión ni el pagado del complemento llegaron a preguntarse.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Paridad de la migración 0173 ────────────────────────────────────────

describe('los gestores que ya existían conservan su cola (TC-12053-25)', () => {
  const leer = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  /**
   * Esto NO es un test de comportamiento y no pretende serlo: la migración se comprueba corriéndola
   * (dos veces, sobre la base ya migrada). Lo que fija aquí es lo único que un test puede fijar y que
   * de verdad se puede romper en una revisión posterior — **que las dos mitades viajen juntas**.
   *
   * El riesgo es de ORDEN, no de SQL: en este repo el merge a `develop` ES el deploy y el CD aplica
   * las migraciones. Si la lectura de la tabla nueva llegara sin el backfill, los gestores que ya
   * existen se quedan sin cola —sin error, sin log, solo una pantalla vacía—; y si el backfill
   * llegara sin la lectura, seguirían leyendo una columna que ya está a NULL.
   */
  it('TC-12053-25: la 0173 backfillea a los gestores existentes ANTES de limpiar su columna', () => {
    const sql = leer('../../src/db/migrations/0173_flito_gestor_organismos.sql');

    const iTabla = sql.indexOf('CREATE TABLE IF NOT EXISTS flito_gestor_organismos');
    const iBackfill = sql.indexOf('INSERT INTO flito_gestor_organismos');
    const iLimpieza = sql.indexOf('UPDATE users SET transito_codigo = NULL');
    expect(iTabla).toBeGreaterThan(-1);
    expect(iBackfill).toBeGreaterThan(iTabla);
    // El orden es carga: si la limpieza fuera antes, el backfill copiaría columnas ya vaciadas y
    // TODOS los gestores del ambiente perderían su cola en el mismo deploy.
    expect(iLimpieza).toBeGreaterThan(iBackfill);

    const backfill = sql.slice(iBackfill, iLimpieza);
    expect(backfill).toContain("u.role = 'gestor_impuestos'");
    // El JOIN no es adorno: `users.transito_codigo` no tiene FK, así que puede llevar un código que
    // no está en el catálogo parametrizado, y un INSERT directo abortaría con 23503 la cadena entera
    // de migraciones en TODOS los ambientes.
    expect(backfill).toContain('JOIN organismos_transito_config');
    expect(backfill).toContain('ON CONFLICT DO NOTHING');
    // Y lo que el JOIN deja fuera se AVISA en el log del CD en vez de desaparecer en silencio.
    expect(sql).toContain('RAISE NOTICE');
    // La limpieza es solo del gestor: `transito_codigo` sigue siendo del rol `transito`.
    expect(sql.slice(iLimpieza)).toContain("role = 'gestor_impuestos'");
  });

  it('TC-12053-25 (bis): el seed siembra la atadura en la tabla, no en `transito_codigo`', () => {
    const seed = leer('../../src/scripts/flito-seed.ts');
    const gestores = seed.slice(seed.indexOf('gestor.medellin'), seed.indexOf("username: 'auditoria'"));

    // Si el seed siguiera escribiendo `transitoCodigo`, el ambiente de demo reproduciría justo el
    // estado que el `superRefine` de `users.routes.ts` declara ilegal.
    expect(gestores).not.toContain('transitoCodigo');
    expect(seed).toContain('flitoGestorOrganismos');
  });
});
