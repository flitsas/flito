// FLITO comparendos — lectura del consolidado y del timeline (HU #11502, AC1/AC3, CF-09/CF-11).
//
// Las cuatro rutas que 17b va a consumir. Lo que se demuestra, por orden de importancia:
//
//   1. **La identidad no viaja en la URL** (AGENTS.md §14). `nit` y `placa` se filtran por el
//      CUERPO de `POST /registros/buscar`, y el `GET` del listado los rechaza con un 400 en vez de
//      aceptarlos: una URL con un NIT sobrevive en el access log del proxy y en el historial, dos
//      sitios fuera de la retención del módulo.
//   2. **Los payloads crudos no salen del módulo** (RN-31). Se comprueba por los dos lados y en las
//      DOS consultas —la del listado y la del detalle, que no ordena y por eso se le escapaba a la
//      aserción del listado—: la PROYECCIÓN enumera las columnas una a una y ninguna es `payload_*`,
//      y la fila que devuelve el mock SÍ los trae, con una cédula reconocible dentro, de modo que
//      cambiar el `select(...)` por un `select()` no solo cambia la proyección sino que saca el
//      centinela por la respuesta.
//   3. **Los filtros son los que dicen ser** (RN-33). El WHERE se serializa a SQL real: un filtro
//      por NIT que no filtra y uno que filtra son idénticos para un mock que devuelve lo registrado
//      pase lo que pase, y la diferencia entre los dos es devolverle a alguien los comparendos de
//      todas las empresas.
//   4. **La paginación es por cursor y sobre un orden estable** (RN-32). Se afirma el `ORDER BY`, el
//      `LIMIT n+1`, el contenido del cursor emitido y el WHERE de la segunda página —por IGUALDAD,
//      porque `'"id" <='` contiene `'"id" <'` y un `toContain` no distingue los dos—, y además se
//      RECORREN tres páginas contra una mini-tabla que aplica ese WHERE de verdad.
//   5. **Toda lectura de datos personales deja rastro** (Ley 1581 art. 17, HU #11511): es el
//      consumidor que `flito-comparendos.pii.ts` estaba esperando.
//   6. **Nada de esto lo ve quien no es admin** (CF-12) ni nadie sin autenticar.
//   7. **Nada de un origen que no sea el canónico sale por el API**: ni el token SIMIT, ni una clave
//      inesperada dentro del `detalle` de un evento (RN-35).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { COMPARENDOS_REGISTROS_LIMIT_MAX } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Mismo criterio que en el test de acceso a PII: se fija el CONTRATO con el helper compartido. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const BASE = '/api/flito/comparendos';
const REGISTROS = `${BASE}/registros`;
const BUSCAR = `${REGISTROS}/buscar`;
const TABLA = 'flito_comparendos_registros';
const EVENTOS = 'flito_comparendos_eventos';

/** Ids del mismo formato que solo se distinguen por su dígito: su orden es el del dígito. */
const idNumero = (n: number) => {
  const d = String(n);
  return `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
};

const ID_1 = idNumero(1);
const ID_2 = idNumero(2);
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AHORA = new Date('2026-08-13T15:30:00.000Z');
const ANTES = new Date('2026-08-12T09:00:00.000Z');
const HACE_TIEMPO = new Date('2026-08-01T07:00:00.000Z');

/**
 * El dato personal que los payloads del proveedor llevan dentro y que ninguna respuesta puede
 * mostrar. Es una cadena reconocible a propósito: si algún día sale, el fallo se lee solo.
 */
const CEDULA_EN_PAYLOAD = 'cedula-del-propietario-1032456789';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

/**
 * Cabecera de un usuario propio del bloque.
 *
 * **El `sub` es distinto en cada `describe` a propósito.** El limitador de la lectura cuenta 60
 * peticiones por minuto y USUARIO, su ventana no se reinicia entre tests y este archivo hace bastantes
 * más de 60 en total. Con un `sub` compartido, cualquier fallo real —que vitest reintenta, gastando
 * el doble de cuota— empuja al resto del archivo contra el techo y los tests siguientes fallan con un
 * `429` que no tiene nada que ver con lo que se rompió. El bloque del propio limitador ya lo hacía;
 * esto lo generaliza.
 */
const sesion = (sub: number) => async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/**
 * Fila del consolidado tal como la traería la base **sin proyectar**: con `payload_simit` y
 * `payload_municipal` dentro.
 *
 * No es la fila que el servicio pide —él enumera sus columnas y ninguna es un payload— y por eso
 * sirve: es lo que un `db.select()` sin lista de columnas devolvería. Con una fixture limpia, una
 * aserción sobre el cuerpo de la respuesta no puede distinguir «no se proyectan» de «no había nada
 * que proyectar», que es exactamente el hueco que dejaba la versión anterior de este archivo.
 */
const fila = (over: Record<string, unknown> = {}) => ({
  id: ID_1,
  numeroComparendo: '05001000000012345678',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en sitio prohibido',
  fechaComparendo: '2026-06-02',
  organismo: 'Secretaría de Movilidad de Bello',
  municipioFuente: 'BELLO',
  monto: '604100.00',
  estadoFuente: 'PENDIENTE',
  origenMerge: 'ambos',
  vistoEnSimit: true,
  vistoEnMunicipal: true,
  estado: 'activo',
  primeraVistoEn: ANTES,
  ultimoVistoEn: AHORA,
  inactivadoEn: null,
  ultimoSyncRunId: RUN,
  causalId: null,
  observacion: null,
  createdAt: ANTES,
  updatedAt: AHORA,
  // La respuesta del tercero sobre un tercero: existe para poder re-mergear sin volver a llamar al
  // proveedor, no para alimentar una pantalla (RN-31).
  payloadSimit: { propietario: { documento: CEDULA_EN_PAYLOAD }, direccion: 'CL 30 # 4-12' },
  payloadMunicipal: { deudor: CEDULA_EN_PAYLOAD, telefono: '3001234567' },
  ...over,
});

const evento = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  registroId: ID_1,
  tipo: 'primera_llegada',
  syncRunId: RUN,
  detalle: { origen: 'ambos' },
  createdAt: ANTES,
  ...over,
});

// ─────────────────────────── Espía de consultas ─────────────────────────────────────────────────
//
// `keyed-db` decide QUÉ devuelve cada query y descarta cómo se pidió. Aquí lo pedido es la prueba:
// la proyección (qué columnas salen de la base), el WHERE (qué se filtra de verdad), el ORDER BY
// (si el orden de la paginación es estable) y el LIMIT (si se pide una fila de más para saber que
// hay página siguiente).

const dialecto = new PgDialect();

interface Consulta {
  tabla: string;
  proyeccion: string[];
  condiciones: unknown[];
  orden: unknown[];
  limite: number | null;
}

const lecturas: Consulta[] = [];

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

function instalarEspia(): void {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = base(...args);
    const proyeccion = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const registro: Consulta = { tabla: '__sin_from__', proyeccion, condiciones: [], orden: [], limite: null };

    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { registro.tabla = nombre(tbl); lecturas.push(registro); return from(tbl); };
    const where = chain.where as (v: unknown) => unknown;
    chain.where = (c: unknown) => { if (c !== undefined) registro.condiciones.push(c); return where(c); };
    const orderBy = chain.orderBy as (...v: unknown[]) => unknown;
    chain.orderBy = (...c: unknown[]) => { registro.orden.push(...c); return orderBy(...c); };
    const limit = chain.limit as (v: number) => unknown;
    chain.limit = (n: number) => { registro.limite = n; return limit(n); };
    return chain;
  });
}

const lecturasEn = (tabla: string) => lecturas.filter((l) => l.tabla === tabla);
/** La consulta de listado: la única sobre registros que ordena. */
const listado = () => lecturasEn(TABLA).find((l) => l.orden.length > 0)!;
/**
 * La consulta del DETALLE (`obtenerRegistro`): la que busca UN registro por id y no ordena.
 *
 * Existe porque `listado()` filtra por «tiene ORDER BY» y por tanto NUNCA miraba esta: la ruta que
 * devuelve un registro entero se quedaba sin ninguna aserción de proyección. Solo vale en tests que
 * piden el detalle: `listarEventos` también consulta esta tabla sin ordenar, aunque proyectando un
 * único `id`.
 */
const consultaDetalle = () => lecturasEn(TABLA).find((l) => l.orden.length === 0)!;
const sqlDe = (c: unknown) => dialecto.sqlToQuery(c as never);
const whereDe = (c: Consulta) => sqlDe(c.condiciones[0]);
const ordenDe = (c: Consulta) => c.orden.map((o) => sqlDe(o).sql).join(', ');

// ─────────────────────────── Mini-tabla en memoria (para RECORRER páginas) ──────────────────────
//
// `keyed-db` devuelve las filas registradas pase lo que pase, así que con él «paginar» es pedir tres
// veces la misma respuesta: un cursor que repite filas y uno que no se ven idénticos. Para que un
// recorrido signifique algo tiene que haber alguien que APLIQUE el WHERE, y es esto.
//
// Lo que esta tabla no hace es decidir el criterio. Los dos operadores del keyset se LEEN del SQL
// que construyó el servicio, no se dan por supuestos: si el desempate por `id` pasara de `<` a `<=`,
// aquí se pagina con `<=` —como haría PostgreSQL— y la fila que cierra una página vuelve a salir en
// la siguiente. Reimplementar el criterio «como debería ser» sería probar el test contra sí mismo.

type Comparador = '<' | '<=';

/** Los dos operadores del cursor, tal como el servicio los escribió. */
function operadoresDelCursor(sql: string): [Comparador, Comparador] {
  const m = /"created_at" (<=?) \$1 or .+"created_at" = \$2 and .+"id" (<=?) \$3/.exec(sql);
  if (!m) throw new Error(`WHERE de cursor con una forma que esta tabla no sabe simular: ${sql}`);
  return [m[1] as Comparador, m[2] as Comparador];
}

/** ISO y UUID en minúsculas comparan igual como cadena que como `timestamptz` y `uuid`. */
const menorQue = (op: Comparador, a: string, b: string) => (op === '<' ? a < b : a <= b);

interface FilaPaginable { id: string; createdAt: Date }

/**
 * Resolver de `keyed-db` que responde una consulta del listado como lo haría PostgreSQL: filtra por
 * el cursor, ordena por `(created_at, id)` descendente y corta por el `LIMIT` que se pidió.
 *
 * `keyed-db` lo invoca al resolver la promesa, cuando la cadena ya está armada, así que la última
 * lectura registrada sobre la tabla es la consulta que hay que responder.
 */
function tablaEnMemoria<T extends FilaPaginable>(filas: T[]) {
  return (): T[] => {
    const q = lecturasEn(TABLA).at(-1)!;
    // Esta tabla solo sabe simular el orden del listado; con otro estaría respondiendo otra consulta.
    expect(ordenDe(q)).toContain('"created_at" desc');
    expect(ordenDe(q)).toContain('"id" desc');

    const ordenadas = [...filas].sort((a, b) => {
      const porFecha = b.createdAt.getTime() - a.createdAt.getTime();
      if (porFecha !== 0) return porFecha;
      return a.id === b.id ? 0 : (a.id < b.id ? 1 : -1);
    });

    let visibles = ordenadas;
    if (q.condiciones.length > 0) {
      const w = whereDe(q);
      const [opFecha, opId] = operadoresDelCursor(w.sql);
      const [corteFecha, , corteId] = w.params as string[];
      visibles = ordenadas.filter((f) => {
        const fecha = f.createdAt.toISOString();
        return menorQue(opFecha, fecha, corteFecha)
          || (fecha === corteFecha && menorQue(opId, f.id, corteId));
      });
    }
    return q.limite === null ? visibles : visibles.slice(0, q.limite);
  };
}

/** Lo que el helper de PII recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  kdb.reset();
  lecturas.length = 0;
  logPiiAccessMock.mockClear();
  instalarEspia();
});

// ─────────────────────────── Guardas (AC1, CF-12) ───────────────────────────────────────────────

describe('registros — quién puede leer', () => {
  const auth = sesion(7101);

  it('sin Authorization → 401 y no se consulta nada', async () => {
    const r = await request(await buildApp()).get(REGISTROS);

    expect(r.status).toBe(401);
    expect(lecturas).toHaveLength(0);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('**con rol auditor → 403**: la deuda de tránsito de terceros no es información de consulta general', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).get(REGISTROS).set('Authorization', await auth('auditor'));

    expect(r.status).toBe(403);
    expect(lecturas).toHaveLength(0);
    // Y no deja rastro de acceso: no hubo acceso que registrar.
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('el detalle y el timeline están igual de cerrados', async () => {
    const app = await buildApp();
    const cabecera = await auth('conductor');

    expect((await request(app).get(`${REGISTROS}/${ID_1}`).set('Authorization', cabecera)).status).toBe(403);
    expect((await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera)).status).toBe(403);
    expect(lecturas).toHaveLength(0);
  });

  it('**la búsqueda por NIT/placa nace con los mismos guardas**: sin token 401, sin rol 403', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const anonimo = await request(app).post(BUSCAR).send({ nit: '900123456' });
    const auditor = await request(app).post(BUSCAR)
      .set('Authorization', await auth('auditor')).send({ nit: '900123456' });

    expect(anonimo.status).toBe(401);
    expect(auditor.status).toBe(403);
    // Los guardas están a nivel de router: una ruta nueva no depende de que su autor los recuerde.
    expect(lecturas).toHaveLength(0);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Listado: forma y proyección (AC1, RN-31) ───────────────────────────

describe('GET /registros — la forma de lo que devuelve', () => {
  const auth = sesion(7102);

  it('devuelve items con la forma de `ComparendoRegistro` y `nextCursor`', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toEqual({
      id: ID_1,
      numeroComparendo: '05001000000012345678',
      nitMonitoreado: '900123456',
      placa: 'ABC123',
      codigoInfraccion: 'C29',
      descripcionInfraccion: 'Estacionar en sitio prohibido',
      fechaComparendo: '2026-06-02',
      organismo: 'Secretaría de Movilidad de Bello',
      municipioFuente: 'BELLO',
      monto: '604100.00',
      estadoFuente: 'PENDIENTE',
      origenMerge: 'ambos',
      vistoEnSimit: true,
      vistoEnMunicipal: true,
      estado: 'activo',
      primeraVistoEn: ANTES.toISOString(),
      ultimoVistoEn: AHORA.toISOString(),
      inactivadoEn: null,
      ultimoSyncRunId: RUN,
      causalId: null,
      observacion: null,
      creadoEn: ANTES.toISOString(),
      actualizadoEn: AHORA.toISOString(),
    });
    // `null` y no ausente: la pantalla no tiene que distinguir «no vino» de «se acabó».
    expect(r.body.nextCursor).toBeNull();
  });

  it('**el listado no pide los payloads crudos ni los devuelve** (RN-31)', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    // Lo que no sale de la base no se puede filtrar por descuido más arriba.
    expect(listado().proyeccion).not.toContain('payloadSimit');
    expect(listado().proyeccion).not.toContain('payloadMunicipal');
    // Y sí trae lo que el contrato promete, para que esto no pase por proyectar de menos —ni por
    // un `select()` sin argumentos, que dejaría la proyección VACÍA y haría pasar las dos negativas.
    expect(listado().proyeccion).toEqual(expect.arrayContaining(['numeroComparendo', 'placa', 'estado']));
    // La otra mitad: la fila del mock SÍ lleva los dos payloads, con una cédula dentro. Si alguien
    // devolviera lo leído sin proyectar, el centinela saldría por aquí.
    expect(r.body.items[0]).not.toHaveProperty('payloadSimit');
    expect(r.body.items[0]).not.toHaveProperty('payloadMunicipal');
    expect(JSON.stringify(r.body)).not.toContain(CEDULA_EN_PAYLOAD);
  });

  it('el `monto` viaja como CADENA: `numeric(14,2)` por un `double` pierde el último centavo', async () => {
    kdb.when.select(TABLA, [fila({ monto: '1160500.55' })]);

    const r = await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    expect(r.body.items[0].monto).toBe('1160500.55');
  });

  it('**ninguna respuesta lleva el token SIMIT ni nada que se le parezca** (AC3)', async () => {
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [evento()]);
    const app = await buildApp();
    const cabecera = await auth();

    const lista = await request(app).get(REGISTROS).set('Authorization', cabecera);
    const detalle = await request(app).get(`${REGISTROS}/${ID_1}`).set('Authorization', cabecera);
    const timeline = await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera);

    for (const cuerpo of [lista.body, detalle.body, timeline.body]) {
      expect(JSON.stringify(cuerpo).toLowerCase()).not.toContain('token');
    }
  });

  it('**un secreto GUARDADO en el `detalle` de un evento tampoco sale** (RN-35)', async () => {
    // El caso anterior solo demuestra que una fixture limpia sale limpia. Este ensucia la fila en
    // el único sitio de la respuesta que no está enumerado campo a campo —`detalle` es JSONB— y es
    // por tanto el único camino real por el que un secreto podría colarse al API.
    const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmbGl0In0.7mB-kQ';
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [evento({
      detalle: {
        motivo: 'ausente_en_todas_las_fuentes',
        token: TOKEN,
        placa: 'XYZ789',
        respuestaProveedor: { authorization: `Bearer ${TOKEN}` },
      },
    })]);
    const app = await buildApp();
    const cabecera = await auth();

    const detalle = await request(app).get(`${REGISTROS}/${ID_1}`).set('Authorization', cabecera);
    const timeline = await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera);

    for (const cuerpo of [detalle.body, timeline.body]) {
      const json = JSON.stringify(cuerpo);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain('XYZ789');
      expect(json.toLowerCase()).not.toContain('authorization');
    }
    // Y lo canónico sigue saliendo: esto no pasa por vaciar `detalle`.
    expect(timeline.body[0].detalle).toEqual({ motivo: 'ausente_en_todas_las_fuentes' });
  });

  it('un `detalle` del que no sobrevive ninguna clave conocida vuelve como `null`, no como `{}`', async () => {
    kdb.when.select(TABLA, [{ id: ID_1 }]).select(EVENTOS, [evento({ detalle: { loQueSea: 1 } })]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', await auth());

    // «Sin contexto conocido» tiene una sola representación: la pantalla no distingue dos vacíos.
    expect(r.body[0].detalle).toBeNull();
  });
});

// ─────────────────────────── Las cuatro rutas solo leen (CF-09, RN-04) ──────────────────────────

describe('la lectura del consolidado no escribe en ninguna de sus cuatro rutas', () => {
  const auth = sesion(7111);

  it('**ni el listado, ni la búsqueda, ni el detalle, ni el timeline tocan un campo de fuente**', async () => {
    // El servicio no tiene un solo INSERT/UPDATE/DELETE y esto es esa promesa vista desde fuera. Se
    // comprueban las CUATRO y no solo `POST /buscar`: el POST era el único sospechoso por su verbo,
    // pero el que un día crecerá con un «marcar como visto» es cualquiera de los otros tres.
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [evento()]);
    const app = await buildApp();
    const cabecera = await auth();

    const lista = await request(app).get(REGISTROS).set('Authorization', cabecera);
    const busqueda = await request(app).post(BUSCAR).set('Authorization', cabecera).send({ nit: '900123456' });
    const detalle = await request(app).get(`${REGISTROS}/${ID_1}`).set('Authorization', cabecera);
    const timeline = await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera);

    for (const r of [lista, busqueda, detalle, timeline]) expect(r.status).toBe(200);
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(kdb.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Dónde viajan los filtros (AGENTS.md §14) ───────────────────────────

describe('la identidad no viaja en la URL (§14)', () => {
  const auth = sesion(7103);

  it('**`GET /registros?nit=` es 400**: el filtro de identidad ya no existe en la query', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();
    const cabecera = await auth();

    const porNit = await request(app).get(`${REGISTROS}?nit=900123456`).set('Authorization', cabecera);
    const porPlaca = await request(app).get(`${REGISTROS}?placa=ABC123`).set('Authorization', cabecera);

    // Un 400 y no un «se ignora»: quien todavía llame con el contrato viejo tiene que enterarse, y
    // un NIT en la URL que «funciona a medias» es un NIT en el access log del proxy igualmente.
    expect(porNit.status).toBe(400);
    expect(porPlaca.status).toBe(400);
    expect(lecturas).toHaveLength(0);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('**`POST /registros/buscar` responde 200, no 201**: es una búsqueda, no un alta', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).post(BUSCAR)
      .set('Authorization', await auth()).send({ nit: '900123456' });

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    // La única escritura de la ruta es el rastro de acceso; nada del consolidado se toca.
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(kdb.delete).not.toHaveBeenCalled();
  });

  it('un cuerpo sin filtros de identidad es una búsqueda sin filtrar, no un 400', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).post(BUSCAR).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(listado().condiciones).toHaveLength(0);
  });
});

// ─────────────────────────── Listado: filtros (AC1, RN-33) ──────────────────────────────────────

describe('los filtros filtran de verdad', () => {
  const auth = sesion(7104);

  /** Filtros que no identifican a nadie: siguen en la query, del `GET` y del `POST`. */
  async function listar(query: string) {
    kdb.when.select(TABLA, [fila()]);
    return request(await buildApp()).get(`${REGISTROS}${query}`).set('Authorization', await auth());
  }

  /** Filtros de identidad: por el cuerpo del `POST`, con la paginación todavía en la query. */
  async function buscar(cuerpo: Record<string, unknown>, query = '') {
    kdb.when.select(TABLA, [fila()]);
    return request(await buildApp()).post(`${BUSCAR}${query}`)
      .set('Authorization', await auth()).send(cuerpo);
  }

  it('sin filtros no monta WHERE: el listado completo no es un filtro vacío mal construido', async () => {
    await listar('');

    expect(listado().condiciones).toHaveLength(0);
  });

  it('`estado` acota por la columna de monitoreo', async () => {
    await listar('?estado=inactivo');

    const w = whereDe(listado());
    expect(w.sql).toContain('"estado"');
    expect(w.params).toContain('inactivo');
  });

  it('**`nit` normaliza igual que el catálogo**: «900.123.456» encuentra lo guardado', async () => {
    await buscar({ nit: '900.123.456' });

    const w = whereDe(listado());
    expect(w.sql).toContain('"nit_monitoreado"');
    // El valor que viaja al parámetro es el normalizado, no el escrito.
    expect(w.params).toEqual(['900123456']);
  });

  it('**`placa` normaliza con el MISMO normalizador del merge**: «abc-123» encuentra «ABC123»', async () => {
    await buscar({ placa: 'abc-123' });

    const w = whereDe(listado());
    expect(w.sql).toContain('"placa"');
    expect(w.params).toEqual(['ABC123']);
  });

  it('**y con ESPACIOS también**: «abc 123» es lo que sale de copiar una placa de un correo', async () => {
    await buscar({ placa: 'abc 123' });

    // El alfabeto del filtro admite el espacio (`placaFiltroSchema`) justo para que esto llegue al
    // servicio; sin la normalización sería una búsqueda de una placa que no existe → página vacía.
    expect(whereDe(listado()).params).toEqual(['ABC123']);
  });

  it('`nit` y `placa` son igualdad, no coincidencia parcial (RN-33)', async () => {
    await buscar({ nit: '900123456', placa: 'ABC123' });

    const w = whereDe(listado());
    // Un `like` sobre un identificador sería barrer datos personales de a poco.
    expect(w.sql).not.toContain('like');
    expect(w.params).toEqual(['900123456', 'ABC123']);
  });

  it('el cuerpo y la query se combinan: buscar por NIT no deja de acotar por estado', async () => {
    await buscar({ nit: '900123456' }, '?estado=activo');

    const w = whereDe(listado());
    expect(w.sql).toContain('"estado"');
    expect(w.sql).toContain('"nit_monitoreado"');
    expect(w.params).toEqual(['activo', '900123456']);
  });

  it('`q` busca por el NÚMERO, en mayúsculas y por contenido', async () => {
    await listar('?q=abc12345');

    const w = whereDe(listado());
    expect(w.sql).toContain('"numero_comparendo"');
    expect(w.params).toEqual(['%ABC12345%']);
  });

  it('**`q` escapa los comodines de LIKE**: `%` no puede devolver la tabla entera', async () => {
    await listar('?q=%25_a');

    expect(whereDe(listado()).params).toEqual(['%\\%\\_A%']);
  });

  it('`q` de menos de 3 caracteres → 400, no un recorrido de la tabla', async () => {
    const r = await listar('?q=1');

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });

  it('una placa que al normalizar no deja nada devuelve página vacía, NO el listado completo', async () => {
    const r = await buscar({ placa: '---' });

    // Ignorar el filtro sería devolverle todo el módulo a quien pidió un vehículo.
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], nextCursor: null });
    expect(lecturas).toHaveLength(0);
  });

  it('**un filtro mal escrito (`?nits=` / `{ nits }`) es 400 y no un volcado del módulo**', async () => {
    const enQuery = await listar('?nits=900123456');
    const enCuerpo = await buscar({ nits: '900123456' });

    expect(enQuery.status).toBe(400);
    expect(enCuerpo.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });

  it('un NIT con caracteres fuera del alfabeto se rechaza en el borde', async () => {
    const r = await buscar({ nit: '900123456&x=1' });

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });
});

// ─────────────────────────── Un parámetro vacío se lee igual en todas partes ────────────────────

describe('un parámetro vacío es un parámetro sin poner, y lo es para todos', () => {
  const auth = sesion(7105);

  it('los filtros de la query vacíos no montan WHERE ni devuelven 400', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}?q=&estado=&cursor=`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(listado().condiciones).toHaveLength(0);
  });

  it('**`?limit=` vacío también**: era el único parámetro con otra regla', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}?limit=`).set('Authorization', await auth());

    // Antes daba 400 mientras `?q=` se ignoraba: dos respuestas distintas para el mismo gesto.
    expect(r.status).toBe(200);
    // Y cae en el valor por defecto, no en «sin límite».
    expect(listado().limite).toBe(51);
  });

  it('los filtros de identidad vacíos o nulos en el cuerpo se leen igual', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).post(BUSCAR)
      // `null` es como un formulario serializa el campo que el usuario borró.
      .set('Authorization', await auth()).send({ nit: '', placa: null });

    expect(r.status).toBe(200);
    expect(listado().condiciones).toHaveLength(0);
  });
});

// ─────────────────────────── Paginación por cursor (AC1, RN-32) ─────────────────────────────────

describe('GET /registros — paginación por cursor', () => {
  const auth = sesion(7106);

  it('**ordena por `(created_at, id)` descendente**: el orden no se mueve bajo quien pagina', async () => {
    kdb.when.select(TABLA, [fila()]);

    await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    const orden = ordenDe(listado());
    expect(orden).toContain('"created_at" desc');
    // El desempate por id es lo que impide repetir o saltar filas de la misma corrida.
    expect(orden).toContain('"id" desc');
    // `ultimo_visto_en` NO ordena: lo reescribe cada sync y siempre hacia arriba, así que una fila
    // sin alcanzar puede saltar por encima del cursor y no aparecer nunca.
    expect(orden).not.toContain('ultimo_visto_en');
  });

  it('pide una fila de MÁS que el límite para saber si hay página siguiente', async () => {
    kdb.when.select(TABLA, [fila()]);

    await request(await buildApp()).get(`${REGISTROS}?limit=25`).set('Authorization', await auth());

    // Sin la fila extra haría falta un `count(*)` sobre el filtro, que es la consulta cara.
    expect(listado().limite).toBe(26);
  });

  it('con la página llena devuelve `nextCursor` y NO la fila sobrante', async () => {
    kdb.when.select(TABLA, [
      fila({ id: ID_1, createdAt: AHORA }),
      fila({ id: ID_2, createdAt: ANTES }),
      fila({ id: '99999999-9999-4999-8999-999999999999', createdAt: ANTES }),
    ]);

    const r = await request(await buildApp()).get(`${REGISTROS}?limit=2`).set('Authorization', await auth());

    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([ID_1, ID_2]);
    expect(r.body.nextCursor).toBeTruthy();
    // El cursor apunta al ÚLTIMO devuelto, no a la fila que se descartó.
    expect(Buffer.from(r.body.nextCursor, 'base64url').toString('utf8'))
      .toBe(`${ANTES.toISOString()}|${ID_2}`);
  });

  it('la última página no emite cursor: no se pide una página vacía para descubrir que se acabó', async () => {
    kdb.when.select(TABLA, [fila(), fila({ id: ID_2 })]);

    const r = await request(await buildApp()).get(`${REGISTROS}?limit=5`).set('Authorization', await auth());

    expect(r.body.items).toHaveLength(2);
    expect(r.body.nextCursor).toBeNull();
  });

  it('**la página siguiente continúa donde acabó la anterior**, sin `offset`', async () => {
    kdb.when.select(TABLA, [fila()]);
    const cursor = Buffer.from(`${ANTES.toISOString()}|${ID_2}`, 'utf8').toString('base64url');

    await request(await buildApp()).get(`${REGISTROS}?cursor=${cursor}`).set('Authorization', await auth());

    const w = whereDe(listado());
    // Keyset: «más viejo que el corte, o del mismo instante y con id menor».
    //
    // Por IGUALDAD y no con `toContain`: `'"id" <='` CONTIENE `'"id" <'`, así que un `toContain`
    // daba por buena la única mutación que rompe la garantía —cambiar `lt` por `lte` en el
    // desempate—, que es justo la que hace que la fila del corte salga en las dos páginas.
    expect(w.sql).toBe(
      `("${TABLA}"."created_at" < $1 or ("${TABLA}"."created_at" = $2 and "${TABLA}"."id" < $3))`,
    );
    expect(w.sql).not.toContain('offset');
    // Drizzle serializa el `Date` del filtro a ISO al construir la consulta.
    expect(w.params).toEqual([ANTES.toISOString(), ANTES.toISOString(), ID_2]);
  });

  it('**tres páginas seguidas: ni una fila repetida ni una perdida, con `created_at` empatados**', async () => {
    // La aserción de arriba mira el SQL; esta mira el RESULTADO, que es la garantía que el operador
    // nota. El conjunto está armado sobre el caso que rompe: dos altas de la misma corrida comparten
    // `created_at` al milisegundo y el corte de la primera página cae justo entre ellas. Con `<=` en
    // el desempate por `id`, la fila que cierra la página 1 vuelve a salir de primera en la 2 —el
    // mismo comparendo dos veces en pantalla— y la última nunca se alcanza.
    const universo = [
      fila({ id: idNumero(5), createdAt: AHORA }),
      fila({ id: idNumero(4), createdAt: ANTES }),        // ─┐ misma corrida: `created_at` idéntico
      fila({ id: idNumero(3), createdAt: ANTES }),        // ─┘ y el corte de la página 1 en medio
      fila({ id: idNumero(2), createdAt: HACE_TIEMPO }),
      fila({ id: idNumero(1), createdAt: HACE_TIEMPO }),
    ];
    kdb.when.select(TABLA, tablaEnMemoria(universo));
    const app = await buildApp();
    const cabecera = await auth();

    const recorridos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const sufijo: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const r = await request(app).get(`${REGISTROS}?limit=2${sufijo}`).set('Authorization', cabecera);
      expect(r.status).toBe(200);
      recorridos.push(...r.body.items.map((i: { id: string }) => i.id));
      cursor = r.body.nextCursor as string | null;
      paginas++;
      // Tope de seguridad: un cursor que no avanza pagina para siempre, y colgar el test sería una
      // forma peor de fallar que decir en qué página se fue de madre.
    } while (cursor !== null && paginas < 6);

    // Ni una repetida — y nombrando cuál, que es lo que el operador vería dos veces en la tabla.
    expect(recorridos.filter((id, i) => recorridos.indexOf(id) !== i)).toEqual([]);
    // ...ni una perdida, y en el orden que el listado promete.
    expect(recorridos).toEqual([idNumero(5), idNumero(4), idNumero(3), idNumero(2), idNumero(1)]);
    // 5 filas de 2 en 2 son exactamente 3 páginas: si hicieran falta más, el cursor no avanza.
    expect(paginas).toBe(3);
  });

  it('el cursor se combina con los filtros en lugar de reemplazarlos', async () => {
    kdb.when.select(TABLA, [fila()]);
    const cursor = Buffer.from(`${ANTES.toISOString()}|${ID_2}`, 'utf8').toString('base64url');

    await request(await buildApp())
      .get(`${REGISTROS}?estado=activo&cursor=${cursor}`).set('Authorization', await auth());

    const w = whereDe(listado());
    expect(w.sql).toContain('"estado"');
    expect(w.params).toEqual(['activo', ANTES.toISOString(), ANTES.toISOString(), ID_2]);
  });

  it('**un cursor corrupto → 400 `cursor_invalido`, no la primera página en silencio**', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}?cursor=no-es-un-cursor`).set('Authorization', await auth());

    // Devolver la primera página se leería como que la lista se acabó y volvió a empezar.
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('cursor_invalido');
    expect(lecturas).toHaveLength(0);
  });

  it('un cursor con fecha válida pero id que no es UUID tampoco pasa', async () => {
    const cursor = Buffer.from(`${ANTES.toISOString()}|1 OR 1=1`, 'utf8').toString('base64url');

    const r = await request(await buildApp())
      .get(`${REGISTROS}?cursor=${cursor}`).set('Authorization', await auth());

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('cursor_invalido');
  });

  it('`limit` fuera de rango → 400 (un `?limit=999999` sería un volcado)', async () => {
    const r = await request(await buildApp())
      .get(`${REGISTROS}?limit=999999`).set('Authorization', await auth());

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });

  it('**el tope de página es 50**: 60 peticiones por minuto × 50 filas es el techo real', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();
    const cabecera = await auth();

    const tope = await request(app).get(`${REGISTROS}?limit=50`).set('Authorization', cabecera);
    const pasado = await request(app).get(`${REGISTROS}?limit=51`).set('Authorization', cabecera);

    expect(tope.status).toBe(200);
    // 200 por página eran 12 000 NITs y placas por minuto y usuario; 50 son 3 000.
    expect(pasado.status).toBe(400);
    expect(COMPARENDOS_REGISTROS_LIMIT_MAX).toBe(50);
  });

  it('la búsqueda por cuerpo pagina igual: el cursor y el límite siguen en la query', async () => {
    kdb.when.select(TABLA, [fila()]);
    const cursor = Buffer.from(`${ANTES.toISOString()}|${ID_2}`, 'utf8').toString('base64url');

    await request(await buildApp()).post(`${BUSCAR}?limit=10&cursor=${cursor}`)
      .set('Authorization', await auth()).send({ nit: '900123456' });

    expect(listado().limite).toBe(11);
    const w = whereDe(listado());
    expect(w.sql).toContain('"nit_monitoreado"');
    // `< \$` y no `toContain('<')`: un `<=` no casa con esto (ver el keyset del `GET`).
    expect(w.sql).toMatch(/"created_at" < \$\d/);
    expect(w.sql).toMatch(/"id" < \$\d/);
  });

  it('un cursor corrupto en la búsqueda es 400 igual que en el listado', async () => {
    kdb.when.select(TABLA, [fila()]);

    const r = await request(await buildApp()).post(`${BUSCAR}?cursor=no-es-un-cursor`)
      .set('Authorization', await auth()).send({ nit: '900123456' });

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('cursor_invalido');
  });
});

// ─────────────────────────── Caché (Low del gate de seguridad) ──────────────────────────────────

describe('las respuestas con datos personales no se guardan en caché', () => {
  const auth = sesion(7107);

  it('**`no-store` en el listado, en la búsqueda y en el detalle**', async () => {
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, []);
    const app = await buildApp();
    const cabecera = await auth();

    const lista = await request(app).get(REGISTROS).set('Authorization', cabecera);
    const busqueda = await request(app).post(BUSCAR).set('Authorization', cabecera).send({ nit: '900123456' });
    const detalle = await request(app).get(`${REGISTROS}/${ID_1}`).set('Authorization', cabecera);

    // Un NIT y una placa no tienen por qué quedarse en el disco del navegador ni en un proxy
    // intermedio después de que la pantalla se cierre.
    for (const r of [lista, busqueda, detalle]) {
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });
});

// ─────────────────────────── Detalle y timeline (AC1, CF-11) ────────────────────────────────────

describe('GET /registros/:id — detalle con timeline', () => {
  const auth = sesion(7108);

  it('devuelve el registro y sus eventos, del más reciente al más antiguo', async () => {
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [
      evento({ id: ID_2, tipo: 'inactivacion', detalle: { motivo: 'ausente_en_todas_las_fuentes' }, createdAt: AHORA }),
      evento(),
    ]);

    const r = await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.id).toBe(ID_1);
    expect(r.body.eventos).toHaveLength(2);
    expect(r.body.eventos[0]).toEqual({
      id: ID_2,
      tipo: 'inactivacion',
      syncRunId: RUN,
      detalle: { motivo: 'ausente_en_todas_las_fuentes' },
      ocurridoEn: AHORA.toISOString(),
    });
    const eventos = lecturasEn(EVENTOS)[0];
    expect(ordenDe(eventos)).toContain('"created_at" desc');
    // Los eventos de una corrida se insertan en un solo statement y comparten `created_at`: sin
    // desempate, el timeline bailaría entre dos peticiones idénticas.
    expect(ordenDe(eventos)).toContain('"id" desc');
  });

  it('**el DETALLE tampoco pide los payloads crudos ni los devuelve** (RN-31)', async () => {
    // El listado tenía su aserción de proyección desde el principio; esta consulta NO, porque el
    // helper que la buscaba filtraba por «tiene ORDER BY» y el detalle no ordena. Y es la ruta que
    // devuelve UN registro entero: el sitio natural donde un `select(COLUMNAS)` se convierte en un
    // `select()` el día que haga falta una columna más.
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [evento()]);

    const r = await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(consultaDetalle().proyeccion).not.toContain('payloadSimit');
    expect(consultaDetalle().proyeccion).not.toContain('payloadMunicipal');
    // Positiva por lo mismo que en el listado: `select()` deja la proyección vacía.
    expect(consultaDetalle().proyeccion)
      .toEqual(expect.arrayContaining(['numeroComparendo', 'placa', 'estado']));
    expect(r.body).not.toHaveProperty('payloadSimit');
    expect(r.body).not.toHaveProperty('payloadMunicipal');
    expect(JSON.stringify(r.body)).not.toContain(CEDULA_EN_PAYLOAD);
  });

  it('un `detalle` que no es un objeto se devuelve como `null`, no como un valor suelto', async () => {
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, [evento({ detalle: 'texto raro' })]);

    const r = await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(r.body.eventos[0].detalle).toBeNull();
  });

  it('un id que no existe → 404', async () => {
    kdb.when.select(TABLA, []);

    const r = await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('no_encontrado');
    // Y no se llega a consultar el timeline de un registro que no está.
    expect(lecturasEn(EVENTOS)).toHaveLength(0);
  });

  it('un id que no es UUID → 400 (y no un 22P02 de PostgreSQL disfrazado de 500)', async () => {
    const r = await request(await buildApp()).get(`${REGISTROS}/no-es-uuid`).set('Authorization', await auth());

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });
});

describe('GET /registros/:id/eventos — timeline suelto', () => {
  const auth = sesion(7109);

  it('devuelve solo los eventos del registro pedido', async () => {
    kdb.when.select(TABLA, [{ id: ID_1 }]).select(EVENTOS, [evento()]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toEqual([{
      id: '33333333-3333-4333-8333-333333333333',
      tipo: 'primera_llegada',
      syncRunId: RUN,
      detalle: { origen: 'ambos' },
      ocurridoEn: ANTES.toISOString(),
    }]);
    const w = whereDe(lecturasEn(EVENTOS)[0]);
    expect(w.sql).toContain('"registro_id"');
    expect(w.params).toEqual([ID_1]);
  });

  it('**un registro sin eventos es una lista vacía; uno que no existe es 404**', async () => {
    const app = await buildApp();
    const cabecera = await auth();

    kdb.when.select(TABLA, [{ id: ID_1 }]).select(EVENTOS, []);
    const vacio = await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera);
    expect(vacio.status).toBe(200);
    expect(vacio.body).toEqual([]);

    kdb.reset(); lecturas.length = 0; instalarEspia();
    kdb.when.select(TABLA, []);
    const ausente = await request(app).get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', cabecera);
    expect(ausente.status).toBe(404);
  });
});

// ─────────────────────────── Registro de acceso a PII (AC3, HU #11511) ──────────────────────────

describe('registros — la lectura deja rastro (Ley 1581 art. 17)', () => {
  const auth = sesion(7110);

  it('**el listado registra un acceso `search`** con los campos personales y cuántas filas se entregaron', async () => {
    kdb.when.select(TABLA, [fila(), fila({ id: ID_2 })]);

    const r = await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: 'flito_comparendos_registro',
      accion: 'search',
      camposAccedidos: ['nit_monitoreado', 'placa'],
    });
    expect(String(ultimoAcceso().motivo)).toContain('filas=2');
  });

  it('**la búsqueda por cuerpo deja el MISMO rastro que el listado**', async () => {
    kdb.when.select(TABLA, [fila(), fila({ id: ID_2 })]);

    const r = await request(await buildApp()).post(BUSCAR)
      .set('Authorization', await auth()).send({ nit: '900123456' });

    // Mover el filtro al cuerpo no puede costar el registro de acceso: es justo la lectura que un
    // titular preguntaría quién hizo.
    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: 'flito_comparendos_registro',
      accion: 'search',
      camposAccedidos: ['nit_monitoreado', 'placa'],
    });
    expect(String(ultimoAcceso().motivo)).toContain('filas=2');
  });

  it('**los filtros van al motivo enmascarados**: el rastro no publica el dato que protege', async () => {
    kdb.when.select(TABLA, [fila()]);

    await request(await buildApp()).post(`${BUSCAR}?estado=activo`)
      .set('Authorization', await auth()).send({ nit: '900123456', placa: 'ABC123' });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('900123456');
    expect(motivo).not.toContain('ABC123');
    expect(motivo).toContain('nit=');
    expect(motivo).toContain('placa=');
    expect(motivo).toContain('estado=activo');
  });

  it('el detalle registra un acceso `read` con el id del comparendo', async () => {
    kdb.when.select(TABLA, [fila()]).select(EVENTOS, []);

    await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(ultimoAcceso()).toMatchObject({ resourceTipo: 'flito_comparendos_registro', accion: 'read' });
    expect(String(ultimoAcceso().motivo)).toContain(ID_1);
  });

  it('**un 404 no registra acceso**: nadie miró los datos de nadie', async () => {
    kdb.when.select(TABLA, []);

    const r = await request(await buildApp()).get(`${REGISTROS}/${ID_1}`).set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('el timeline NO registra acceso: su respuesta no lleva ni NIT ni placa (RN-20)', async () => {
    kdb.when.select(TABLA, [{ id: ID_1 }]).select(EVENTOS, [evento()]);

    const r = await request(await buildApp())
      .get(`${REGISTROS}/${ID_1}/eventos`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    // Anotar lecturas sin datos personales llena el log justo hasta que deja de poder consultarse.
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Limitador de la lectura ────────────────────────────────────────────

describe('registros — rateLimiter del listado', () => {
  // Usuario propio, como el de todos los bloques: el limitador cuenta por `sub` y este caso agota su
  // cuota entera a propósito.
  const auth = sesion(5150);

  it('**el bucle de paginación paga 429 a las 60 páginas, y la búsqueda comparte esa cuota**', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();
    const cabecera = await auth();

    let ultimo = 0;
    for (let i = 0; i < 60; i++) {
      ultimo = (await request(app).get(REGISTROS).set('Authorization', cabecera)).status;
    }
    expect(ultimo).toBe(200);

    // Por el cuerpo no hay una cuota nueva: si la hubiera, el techo del módulo sería el doble.
    const porCuerpo = await request(app).post(BUSCAR).set('Authorization', cabecera).send({});

    expect(porCuerpo.status).toBe(429);
  });
});
