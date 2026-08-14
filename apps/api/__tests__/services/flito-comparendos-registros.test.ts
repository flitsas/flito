// FLITO comparendos — lectura del consolidado y del timeline (HU #11502, AC1/AC3, CF-09/CF-11).
//
// Las tres rutas que 17b va a consumir. Lo que se demuestra, por orden de importancia:
//
//   1. **Los payloads crudos no salen del módulo** (RN-31). No se comprueba mirando la respuesta
//      —el mock devuelve lo que se le registre— sino la PROYECCIÓN de la consulta: las columnas se
//      enumeran una a una y ninguna es `payload_*`. Si mañana alguien cambia el `select(...)` por un
//      `select()`, este archivo lo dice.
//   2. **Los filtros son los que dicen ser** (RN-33). El WHERE se serializa a SQL real: un filtro
//      por NIT que no filtra y uno que filtra son idénticos para un mock que devuelve lo registrado
//      pase lo que pase, y la diferencia entre los dos es devolverle a alguien los comparendos de
//      todas las empresas.
//   3. **La paginación es por cursor y sobre un orden estable** (RN-32). Se afirma el `ORDER BY`, el
//      `LIMIT n+1`, el contenido del cursor emitido y el WHERE de la segunda página.
//   4. **Toda lectura de datos personales deja rastro** (Ley 1581 art. 17, HU #11511): es el
//      consumidor que `flito-comparendos.pii.ts` estaba esperando.
//   5. **Nada de esto lo ve quien no es admin** (CF-12) ni nadie sin autenticar.
//   6. **El token SIMIT no aparece en ninguna respuesta** (AC3).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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
const TABLA = 'flito_comparendos_registros';
const EVENTOS = 'flito_comparendos_eventos';

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AHORA = new Date('2026-08-13T15:30:00.000Z');
const ANTES = new Date('2026-08-12T09:00:00.000Z');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: TestRole = 'admin', sub = 7) =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/** Fila del consolidado tal como la devuelve la proyección del servicio. */
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
const sqlDe = (c: unknown) => dialecto.sqlToQuery(c as never);
const whereDe = (c: Consulta) => sqlDe(c.condiciones[0]);
const ordenDe = (c: Consulta) => c.orden.map((o) => sqlDe(o).sql).join(', ');

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
});

// ─────────────────────────── Listado: forma y proyección (AC1, RN-31) ───────────────────────────

describe('GET /registros — la forma de lo que devuelve', () => {
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

  it('**la consulta no pide los payloads crudos** (RN-31)', async () => {
    kdb.when.select(TABLA, [fila()]);

    await request(await buildApp()).get(REGISTROS).set('Authorization', await auth());

    // Lo que no sale de la base no se puede filtrar por descuido más arriba.
    expect(listado().proyeccion).not.toContain('payloadSimit');
    expect(listado().proyeccion).not.toContain('payloadMunicipal');
    // Y sí trae lo que el contrato promete, para que esto no pase por proyectar de menos.
    expect(listado().proyeccion).toEqual(expect.arrayContaining(['numeroComparendo', 'placa', 'estado']));
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
});

// ─────────────────────────── Listado: filtros (AC1, RN-33) ──────────────────────────────────────

describe('GET /registros — los filtros filtran de verdad', () => {
  async function listar(query: string) {
    kdb.when.select(TABLA, [fila()]);
    return request(await buildApp()).get(`${REGISTROS}${query}`).set('Authorization', await auth());
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
    await listar('?nit=900.123.456');

    const w = whereDe(listado());
    expect(w.sql).toContain('"nit_monitoreado"');
    // El valor que viaja al parámetro es el normalizado, no el escrito.
    expect(w.params).toEqual(['900123456']);
  });

  it('**`placa` normaliza con el MISMO normalizador del merge**: «abc-123» encuentra «ABC123»', async () => {
    await listar('?placa=abc-123');

    const w = whereDe(listado());
    expect(w.sql).toContain('"placa"');
    expect(w.params).toEqual(['ABC123']);
  });

  it('`nit` y `placa` son igualdad, no coincidencia parcial (RN-33)', async () => {
    await listar('?nit=900123456&placa=ABC123');

    const w = whereDe(listado());
    // Un `like` sobre un identificador sería barrer datos personales de a poco.
    expect(w.sql).not.toContain('like');
    expect(w.params).toEqual(['900123456', 'ABC123']);
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
    const r = await listar('?placa=---');

    // Ignorar el filtro sería devolverle todo el módulo a quien pidió un vehículo.
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], nextCursor: null });
    expect(lecturas).toHaveLength(0);
  });

  it('un filtro vacío (`?nit=`) es un filtro sin poner, no un 400', async () => {
    const r = await listar('?nit=&placa=&q=&estado=');

    expect(r.status).toBe(200);
    expect(listado().condiciones).toHaveLength(0);
  });

  it('**un filtro mal escrito (`?nits=`) es 400 y no un volcado del módulo**', async () => {
    const r = await listar('?nits=900123456');

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });

  it('un NIT con caracteres fuera del alfabeto se rechaza en el borde', async () => {
    const r = await listar('?nit=900123456%26x%3D1');

    expect(r.status).toBe(400);
    expect(lecturas).toHaveLength(0);
  });
});

// ─────────────────────────── Paginación por cursor (AC1, RN-32) ─────────────────────────────────

describe('GET /registros — paginación por cursor', () => {
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
    expect(w.sql).toContain('"created_at" <');
    expect(w.sql).toContain('"id" <');
    expect(w.sql).not.toContain('offset');
    // Drizzle serializa el `Date` del filtro a ISO al construir la consulta.
    expect(w.params).toEqual([ANTES.toISOString(), ANTES.toISOString(), ID_2]);
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
});

// ─────────────────────────── Detalle y timeline (AC1, CF-11) ────────────────────────────────────

describe('GET /registros/:id — detalle con timeline', () => {
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

  it('**los filtros van al motivo enmascarados**: el rastro no publica el dato que protege', async () => {
    kdb.when.select(TABLA, [fila()]);

    await request(await buildApp())
      .get(`${REGISTROS}?nit=900123456&placa=ABC123&estado=activo`).set('Authorization', await auth());

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
  it('corta el bucle de paginación con 429', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();
    // Usuario propio: el limitador cuenta por `sub` y así este caso no le gasta cuota al resto.
    const cabecera = await auth('admin', 5150);

    let ultimo = 0;
    for (let i = 0; i < 61; i++) {
      ultimo = (await request(app).get(REGISTROS).set('Authorization', cabecera)).status;
    }

    expect(ultimo).toBe(429);
  });
});
