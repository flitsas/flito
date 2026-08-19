// FLITO comparendos — gestión de un comparendo: causal y observación (HU #11557, AC1..AC9, CF-05).
//
// `PATCH /api/flito/comparendos/registros/:id/gestion` es la ÚNICA escritura del módulo sobre un
// comparendo, y el único endpoint que devuelve un registro entero sin que la suite de lectura
// (`flito-comparendos-registros.test.ts`) esté mirando. Lo que se demuestra aquí, por orden de lo
// que costaría más caro si dejara de ser verdad:
//
//   1. **Los datos de FUENTE siguen siendo inmutables** (AC7, RN-04/CF-09). Se afirma por los dos
//      lados: el cuerpo con `placa`, `monto` u `origenMerge` es un 400 —no un cuerpo del que se
//      ignoran claves— y el `set()` que llega a la base no nombra ninguna columna fuera de las dos
//      editables más el sello de auditoría.
//   2. **La respuesta sale por la lista blanca y no por un `RETURNING *`** (RN-31). El AC1 pide «200
//      con el registro actualizado», y un `UPDATE ... RETURNING *` lo cumple publicando
//      `payload_simit` y `payload_municipal` crudos. La fila del mock lleva una cédula centinela
//      dentro de los payloads: si algún día la respuesta se construye desde el UPDATE, el fallo se
//      lee solo.
//   3. **El evento de gestión lleva `sync_run_id` en NULL y el INSERT no tapa conflictos** (AC3,
//      RN-39). Rellenarlo con el `ultimo_sync_run_id` del registro «para dar contexto» pasa el AC3
//      sobre un registro nunca sincronizado y revienta con `23505` a la segunda gestión de
//      cualquier registro real; taparlo con `onConflictDoNothing` deja la fila gestionada y el
//      timeline mintiendo. Por eso la fila de la fixture SÍ tiene `ultimo_sync_run_id`.
//   4. **La regla de la causal es `existe AND (activa OR es la que ya tenía)`** (AC4 + AC6, RN-40).
//      La versión laxa —«si la fila ya tenía causal, acepto cualquier inactiva»— pasa los dos AC tal
//      como están escritos y permite mover comparendos a causales retiradas del catálogo. El caso
//      que las separa (causal inactiva C en la fila, PATCH con la inactiva D) no está en ningún AC y
//      está aquí.
//   5. **Gestionar deja los dos rastros** (AC9): `audit()` responde «quién cambió qué» y
//      `pii_access_log` «quién miró datos personales» — la respuesta lleva NIT y placa. Ninguno de
//      los dos escribe la observación, la placa ni el NIT.
//   6. **Nada de esto lo hace quien no es admin, ni nadie sin autenticar** (AC9, CF-12).
//
// Desde la HU #11562 se comprueba además que la respuesta trae al autor de la gestión RESUELTO a
// `{ id, nombre }`: el PATCH lo hereda de `obtenerRegistro`, y ese «lo hereda» es justo la clase de
// cosa que deja de ser verdad sin que nadie lo note el día que alguien construya el DTO aquí.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { COMPARENDOS_OBSERVACION_MAX } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** La bitácora se espía, no se ignora: el AC9 pide que la escritura quede registrada. */
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Mismo criterio que en la suite de lectura: se fija el CONTRATO con el helper compartido. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const espia = crearEspia(kdb);

const BASE = '/api/flito/comparendos';
const TABLA = 'flito_comparendos_registros';
const CAUSALES = 'flito_comparendos_causales';
const EVENTOS = 'flito_comparendos_eventos';

const ID = '11111111-1111-4111-8111-111111111111';
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CAUSAL_ACTIVA = '22222222-2222-4222-8222-222222222222';
const CAUSAL_INACTIVA = '33333333-3333-4333-8333-333333333333';
const OTRA_INACTIVA = '44444444-4444-4444-8444-444444444444';
const AHORA = new Date('2026-08-19T14:00:00.000Z');
const ANTES = new Date('2026-08-12T09:00:00.000Z');

/** Datos personales que la respuesta NO puede llevar y que ningún rastro puede escribir. */
const CEDULA_EN_PAYLOAD = 'cedula-del-propietario-1032456789';
const NIT = '900123456';
const PLACA = 'ABC123';
/** Texto de la observación. Reconocible a propósito: si aparece en un rastro, se ve. */
const OBSERVACION = 'Acuerdo de pago con el propietario, cuota 1 el 30 de agosto';

/**
 * Fila del consolidado tal como la traería la base **sin proyectar**, con los payloads dentro.
 *
 * `ultimoSyncRunId` viene puesto y es deliberado (punto 3 de la cabecera): es la fixture que hace
 * fallar a una implementación que copie la corrida del registro dentro del evento de gestión.
 */
const fila = (over: Record<string, unknown> = {}) => ({
  id: ID,
  numeroComparendo: '05001000000012345678',
  nitMonitoreado: NIT,
  placa: PLACA,
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
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  // Desde la HU #11562 la lectura trae también el NOMBRE del autor por un `leftJoin` a `users`, así
  // que la fila que devuelve el mock lo lleva: no es una columna de esta tabla. `null` mientras la
  // fila no está gestionada — el join no casa nada.
  gestionAutorNombre: null,
  createdAt: ANTES,
  updatedAt: AHORA,
  payloadSimit: { propietario: { documento: CEDULA_EN_PAYLOAD }, direccion: 'CL 30 # 4-12' },
  payloadMunicipal: { deudor: CEDULA_EN_PAYLOAD, telefono: '3001234567' },
  ...over,
});

const evento = (over: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  registroId: ID,
  tipo: 'primera_llegada',
  syncRunId: RUN,
  detalle: { origen: 'ambos' },
  createdAt: ANTES,
  ...over,
});

const causal = (id: string, activo: boolean) => ({ id, activo, nombre: 'Causal', orden: 0 });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

/**
 * Cabecera de un usuario propio de cada bloque.
 *
 * El limitador del PATCH cuenta 30 por minuto y USUARIO y su ventana no se reinicia entre tests: con
 * un `sub` compartido, cualquier fallo real —que vitest reintenta— empujaría al resto del archivo
 * contra el techo y los tests siguientes fallarían con un 429 que no tiene que ver con lo que se
 * rompió. Es el mismo patrón de `flito-comparendos-registros.test.ts`.
 */
const sesion = (sub: number) => async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/** Cláusulas `onConflict*` ejecutadas, por tabla: el punto 3 se afirma por ausencia. */
const conflictos: string[] = [];

/** Proyección de cada SELECT, para poder afirmar que la respuesta sale por la lista blanca. */
const proyecciones: { tabla: string; columnas: string[] }[] = [];

/**
 * Cuántas lecturas del registro se habían hecho cuando la transacción terminó.
 *
 * Es la única forma de afirmar DÓNDE ocurre la lectura que arma la respuesta: el mock ejecuta la
 * transacción contra el mismo objeto `db`, así que `tx` y `db` no se distinguen por identidad — pero
 * sí por el momento en que se usan.
 */
let lecturasAlCerrarTx = -1;

function instalarEspias(): void {
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const resultado = await cb(kdb.db);
    lecturasAlCerrarTx = proyecciones.filter((p) => p.tabla === TABLA).length;
    return resultado;
  });

  const insertBase = kdb.insert.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const chain = insertBase(tbl);
    const original = chain.onConflictDoNothing as () => unknown;
    chain.onConflictDoNothing = () => {
      conflictos.push(nombre(tbl));
      return original();
    };
    return chain;
  });

  const selectBase = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const chain = selectBase(...args);
    const columnas = args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [];
    const from = chain.from as (t: unknown) => unknown;
    chain.from = (tbl: unknown) => { proyecciones.push({ tabla: nombre(tbl), columnas }); return from(tbl); };
    return chain;
  });
}

function nombre(tbl: unknown): string {
  try { return getTableName(tbl as never); } catch { return '__expr__'; }
}

/** Escenario por defecto: el comparendo existe, con una causal activa disponible y un timeline. */
function escenario(opciones: {
  registro?: Record<string, unknown> | null;
  causales?: Record<string, unknown>[];
  eventos?: Record<string, unknown>[];
} = {}): void {
  const registro = opciones.registro === undefined ? fila() : opciones.registro;
  kdb.when
    .select(TABLA, registro === null ? [] : [registro])
    .select(CAUSALES, opciones.causales ?? [causal(CAUSAL_ACTIVA, true)])
    .select(EVENTOS, opciones.eventos ?? [evento()])
    .update(TABLA, [])
    .insert(EVENTOS, []);
}

const gestionar = async (
  cuerpo: unknown,
  cabecera: string,
  id: string = ID,
) => request(await buildApp())
  .patch(`${BASE}/registros/${id}/gestion`)
  .set('Authorization', cabecera)
  .send(cuerpo as object);

const updates = () => espia.updatesEn(TABLA);
const eventosEscritos = () => espia.insertsEn(EVENTOS).map((m) => m.datos as Record<string, unknown>);

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  instalarEspias();
  auditMock.mockClear();
  logPiiAccessMock.mockClear();
  conflictos.length = 0;
  proyecciones.length = 0;
  lecturasAlCerrarTx = -1;
});

// ─────────────────────────── AC1 · Gestión exitosa ──────────────────────────────────────────────

describe('AC1 — PATCH con causal y observación: 200, columnas escritas, sello y evento', () => {
  const auth = sesion(7201);
  const SUB = 7201;

  it('responde 200 con el registro actualizado y escribe las dos columnas editables', async () => {
    escenario();

    const r = await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    // El cuerpo es el registro entero —lo que devuelve `GET /registros/:id`—, no un eco del cuerpo:
    // la pantalla reemplaza con él la fila y el panel sin una segunda petición.
    expect(r.body.id).toBe(ID);
    expect(r.body.numeroComparendo).toBe('05001000000012345678');
    expect(Array.isArray(r.body.eventos)).toBe(true);

    const set = updates()[0].datos as Record<string, unknown>;
    expect(set.causalId).toBe(CAUSAL_ACTIVA);
    expect(set.observacion).toBe(OBSERVACION);
    // El UPDATE va acotado por el id del comparendo y no por nada más: sin esta aserción, un
    // `where` perdido escribiría la observación de uno en la tabla entera y el mock no se enteraría.
    expect(updates()[0].filtros).toContain(ID);
  });

  it('**la respuesta trae al autor RESUELTO** (`{ id, nombre }`), porque la construye la lectura (HU #11562)', async () => {
    // El PATCH no reconstruye el DTO: devuelve `obtenerRegistro(id, tx)`. Se comprueba en vez de
    // darlo por hecho porque es lo que hace que el panel del visor pueda pintar «gestionado por X»
    // sin una segunda petición — y porque una futura copia local de la proyección aquí volvería a
    // publicar el id suelto sin que la suite de lectura se enterase.
    const NOMBRE_AUTOR = 'Marcela Restrepo';
    escenario({
      registro: fila({
        gestionActualizadaEn: AHORA,
        gestionActualizadaPor: SUB,
        gestionAutorNombre: NOMBRE_AUTOR,
      }),
    });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    expect(r.body.gestionActualizadaPor).toEqual({ id: SUB, nombre: NOMBRE_AUTOR });
    // Y el nombre no se filtra a ninguno de los dos rastros: la bitácora dice qué se cambió y el
    // registro de acceso qué datos del TITULAR se vieron. Quién lo hizo ya viaja como `userId`.
    expect(JSON.stringify(auditMock.mock.calls.at(-1)?.[1])).not.toContain(NOMBRE_AUTOR);
    expect(JSON.stringify(logPiiAccessMock.mock.calls.at(-1)?.[1])).not.toContain(NOMBRE_AUTOR);
  });

  it('**`gestion_actualizada_por` es el usuario del token y `gestion_actualizada_en` la hora del servidor**', async () => {
    escenario();
    const antes = new Date();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    const set = updates()[0].datos as Record<string, unknown>;
    expect(set.gestionActualizadaPor).toBe(SUB);
    // No es una cadena que venga del cuerpo ni `now()` delegado a la base: es un `Date` construido
    // en el servidor, y se afirma dentro de la ventana de la petición. Un cliente no puede datar su
    // propia gestión.
    expect(set.gestionActualizadaEn).toBeInstanceOf(Date);
    const cuando = (set.gestionActualizadaEn as Date).getTime();
    expect(cuando).toBeGreaterThanOrEqual(antes.getTime());
    expect(cuando).toBeLessThanOrEqual(Date.now());
    // La misma marca en las dos columnas del sello: son una sola cosa (CHECK de la 0156).
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('inserta UN evento de tipo `gestion` para el registro, y nada más', async () => {
    escenario();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    expect(eventosEscritos()).toHaveLength(1);
    expect(eventosEscritos()[0]).toMatchObject({ registroId: ID, tipo: 'gestion' });
    // Ninguna otra tabla se escribe: `audit` y `pii_access_log` están mockeados, así que lo que el
    // espía ve son exactamente las escrituras del servicio.
    expect(espia.inserts.map((m) => m.tabla)).toEqual([EVENTOS]);
  });

  it('cambiar solo la observación NO toca la causal (la clave se omite, no viaja en null)', async () => {
    escenario({ registro: fila({ causalId: CAUSAL_ACTIVA }) });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    const set = updates()[0].datos as Record<string, unknown>;
    // `not.toHaveProperty` y no `toBeUndefined()`: la diferencia entre omitir la clave y mandarla en
    // `null` es la diferencia entre «no la toques» y «bórrala», y es todo el contrato del PATCH.
    expect(set).not.toHaveProperty('causalId');
    expect(Object.keys(set)).not.toContain('causalId');
    expect(set.observacion).toBe(OBSERVACION);
  });

  it('cambiar solo la causal NO toca la observación', async () => {
    escenario({ registro: fila({ observacion: 'lo que ya había' }) });

    const r = await gestionar({ causalId: CAUSAL_ACTIVA }, await auth());

    expect(r.status).toBe(200);
    const set = updates()[0].datos as Record<string, unknown>;
    expect(set).not.toHaveProperty('observacion');
    expect(set.causalId).toBe(CAUSAL_ACTIVA);
  });
});

// ─────────────────────────── AC2 · Limpiar la gestión ───────────────────────────────────────────

describe('AC2 — PATCH con las dos en null: se vacían las columnas y el sello se ACTUALIZA', () => {
  const auth = sesion(7202);

  it('responde 200 y las dos columnas quedan en NULL', async () => {
    escenario({ registro: fila({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }) });

    const r = await gestionar({ causalId: null, observacion: null }, await auth());

    expect(r.status).toBe(200);
    const set = updates()[0].datos as Record<string, unknown>;
    // Presentes y en `null`: aquí sí se mandan, porque vaciar es lo que se pidió.
    expect(set).toHaveProperty('causalId', null);
    expect(set).toHaveProperty('observacion', null);
  });

  it('**el sello de auditoría se escribe, no se borra**: limpiar es un acto y tiene autor', async () => {
    escenario({ registro: fila({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }) });

    await gestionar({ causalId: null, observacion: null }, await auth());

    const set = updates()[0].datos as Record<string, unknown>;
    // El error tentador es «si no queda gestión, borro el sello»: dejaría la fila indistinguible de
    // una que nadie tocó jamás, y con ella se perdería quién quitó la clasificación (RN-38).
    expect(set.gestionActualizadaPor).toBe(7202);
    expect(set.gestionActualizadaEn).toBeInstanceOf(Date);
  });

  it('se registra IGUALMENTE un evento de tipo gestion, marcado como retirada', async () => {
    escenario({ registro: fila({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }) });

    await gestionar({ causalId: null, observacion: null }, await auth());

    const [ev] = eventosEscritos();
    expect(ev).toMatchObject({ tipo: 'gestion', registroId: ID });
    expect(ev.detalle).toMatchObject({ motivo: 'gestion_retirada', campos: ['causal', 'observacion'] });
  });

  it('poner algo, aunque sea solo la observación, es una gestión REGISTRADA', async () => {
    escenario();

    await gestionar({ causalId: null, observacion: OBSERVACION }, await auth());

    expect(eventosEscritos()[0].detalle).toMatchObject({ motivo: 'gestion_registrada' });
  });
});

// ─────────────────────────── AC3 · Dos gestiones, dos eventos ───────────────────────────────────

describe('AC3 — dos gestiones seguidas dejan dos eventos', () => {
  const auth = sesion(7203);

  it('la segunda gestión inserta un segundo evento y ninguno lleva la corrida del registro', async () => {
    // La fila TIENE `ultimo_sync_run_id`: es lo que delata a quien lo copie al evento «para dar
    // contexto». Con `sync_run_id` relleno, la segunda gestión del mismo día chocaría con el único
    // `(registro_id, tipo, sync_run_id)` y saldría como un 23505 → 500.
    escenario({ registro: fila({ ultimoSyncRunId: RUN }) });
    const cabecera = await auth();

    const primera = await gestionar({ observacion: 'primera nota' }, cabecera);
    const segunda = await gestionar({ observacion: 'segunda nota' }, cabecera);

    expect([primera.status, segunda.status]).toEqual([200, 200]);
    const eventos = eventosEscritos();
    expect(eventos).toHaveLength(2);
    for (const ev of eventos) {
      expect(ev.tipo).toBe('gestion');
      // `null` explícito: PostgreSQL trata dos NULL como distintos, y eso es lo único que hace que
      // el índice único no vea aquí un duplicado. La corrida del registro no pinta nada en un
      // evento que no produjo ninguna corrida.
      expect(ev).toHaveProperty('syncRunId', null);
      expect(ev.syncRunId).not.toBe(RUN);
    }
  });

  it('**el INSERT del evento no lleva `onConflictDoNothing`**', async () => {
    escenario();

    await gestionar({ observacion: 'nota' }, await auth());

    // El del sync sí lo lleva, porque re-ejecutar una corrida repetiría la tupla. Aquí el conflicto
    // no puede ocurrir, y tragárselo por si acaso sería justo lo que dejaría la fila gestionada y el
    // timeline vacío el día que alguien pusiera ese índice en `NULLS NOT DISTINCT`.
    expect(conflictos).toEqual([]);
    expect(eventosEscritos()).toHaveLength(1);
  });
});

// ─────────────────────────── AC4 y AC6 · La causal ──────────────────────────────────────────────

describe('AC4 — causal inválida: 422 `causal_invalida` y no se escribe nada', () => {
  const auth = sesion(7204);

  it('una causal que no existe es 422 y la base no se toca', async () => {
    escenario({ causales: [] });

    const r = await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('causal_invalida');
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
  });

  it('una causal desactivada es 422 cuando la fila no la tenía', async () => {
    escenario({ causales: [causal(CAUSAL_INACTIVA, false)] });

    const r = await gestionar({ causalId: CAUSAL_INACTIVA }, await auth());

    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('causal_invalida');
    expect(espia.updates).toEqual([]);
  });

  it('el 422 no dice si la causal no existe o está desactivada, ni enumera el catálogo', async () => {
    escenario({ causales: [] });

    const r = await gestionar({ causalId: CAUSAL_ACTIVA }, await auth());

    expect(r.body.error).not.toContain(CAUSAL_ACTIVA);
    expect(JSON.stringify(r.body)).not.toContain(NIT);
  });
});

describe('AC6 — una causal inactiva YA asignada no se pierde (y no abre la puerta a otras)', () => {
  const auth = sesion(7206);

  it('reenviar la misma causal inactiva junto a una observación nueva se guarda: 200', async () => {
    escenario({
      registro: fila({ causalId: CAUSAL_INACTIVA }),
      causales: [causal(CAUSAL_INACTIVA, false)],
    });

    const r = await gestionar({ causalId: CAUSAL_INACTIVA, observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    const set = updates()[0].datos as Record<string, unknown>;
    expect(set.causalId).toBe(CAUSAL_INACTIVA);
    expect(set.observacion).toBe(OBSERVACION);
  });

  it('**el caso que separa la regla buena de la laxa**: de una inactiva a OTRA inactiva es 422', async () => {
    // La regla laxa —«la fila ya tenía una causal, acepto cualquier inactiva»— pasa el AC4 y el AC6
    // tal como están escritos, y permite mover comparendos a causales retiradas del catálogo. La
    // regla correcta compara contra la causal CONCRETA que la fila tiene: `existe AND (activa OR es
    // exactamente la suya)`.
    escenario({
      registro: fila({ causalId: CAUSAL_INACTIVA }),
      causales: [causal(OTRA_INACTIVA, false)],
    });

    const r = await gestionar({ causalId: OTRA_INACTIVA }, await auth());

    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('causal_invalida');
    expect(espia.updates).toEqual([]);
  });

  it('quitar la causal (null) desde una inactiva siempre se puede: 200', async () => {
    // Retirar no consulta el catálogo: no hay causal nueva que validar, y dejar sin salida a un
    // comparendo clasificado con una causal retirada sería el peor final posible de esta regla.
    escenario({ registro: fila({ causalId: CAUSAL_INACTIVA }), causales: [] });

    const r = await gestionar({ causalId: null }, await auth());

    expect(r.status).toBe(200);
    expect((updates()[0].datos as Record<string, unknown>)).toHaveProperty('causalId', null);
  });

  it('una causal BORRADA del catálogo y reenviada es 422, no un 23503 disfrazado de 500', async () => {
    // El atajo tentador es «si coincide con la que la fila dice tener, ni la consulto». Con una fila
    // que apunta a una causal ya borrada, ese atajo mandaría el UPDATE a la base y la FK respondería
    // `23503` — un 500 en la cara del usuario en vez de un 422 que se entiende.
    escenario({ registro: fila({ causalId: CAUSAL_INACTIVA }), causales: [] });

    const r = await gestionar({ causalId: CAUSAL_INACTIVA }, await auth());

    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('causal_invalida');
    expect(espia.updates).toEqual([]);
  });
});

// ─────────────────────────── AC5 · El límite de la observación ──────────────────────────────────

describe('AC5 — la observación se mide contra la constante compartida', () => {
  const auth = sesion(7205);

  it('el tope vive en `packages/shared-types` y es un número utilizable por la pantalla', () => {
    // La pantalla pinta su contador con ESTE número. Que sea un entero positivo no es una obviedad:
    // es lo que impide que alguien lo declare como `undefined` exportado y el contador diga «NaN».
    expect(Number.isInteger(COMPARENDOS_OBSERVACION_MAX)).toBe(true);
    expect(COMPARENDOS_OBSERVACION_MAX).toBeGreaterThan(0);
  });

  it('una observación de exactamente el máximo se guarda', async () => {
    escenario();
    const texto = 'x'.repeat(COMPARENDOS_OBSERVACION_MAX);

    const r = await gestionar({ observacion: texto }, await auth());

    expect(r.status).toBe(200);
    expect((updates()[0].datos as Record<string, unknown>).observacion).toBe(texto);
  });

  it('**un carácter más es 400** — el esquema usa la constante como fuente única', async () => {
    escenario();

    const r = await gestionar({ observacion: 'x'.repeat(COMPARENDOS_OBSERVACION_MAX + 1) }, await auth());

    expect(r.status).toBe(400);
    // El mensaje nombra el número, así que la pantalla y el servidor no pueden discrepar en silencio.
    expect(JSON.stringify(r.body)).toContain(String(COMPARENDOS_OBSERVACION_MAX));
    expect(espia.updates).toEqual([]);
  });

  it('una clave desconocida es 400: el esquema es estricto', async () => {
    escenario();

    // El error de dedo más fácil: el plural. Sin `.strict()` se ignoraría en silencio y la respuesta
    // 200 confirmaría en falso que se guardó algo.
    const r = await gestionar({ observaciones: 'nota' }, await auth());

    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
  });

  it('un cuerpo vacío es 400 y NO deja un evento de un cambio que no ocurrió', async () => {
    escenario();

    const r = await gestionar({}, await auth());

    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
  });

  it('una observación en blanco se guarda como NULL, no como cadena vacía', async () => {
    escenario();

    const r = await gestionar({ observacion: '   ' }, await auth());

    expect(r.status).toBe(200);
    // Dos formas de decir «no hay nada» en la misma columna obligarían a la pantalla a distinguirlas
    // para nada.
    expect((updates()[0].datos as Record<string, unknown>)).toHaveProperty('observacion', null);
  });

  it('una observación con un byte cero dentro es 400, no un 22021 desde el driver', async () => {
    escenario();

    const r = await gestionar({ observacion: `nota\u0000 con byte cero` }, await auth());

    // Un JSON puede transportarlo y una columna `text` de PostgreSQL no lo admite: sin esta
    // comprobación llegaría hasta el driver y saldría como un 500.
    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
  });

  it('un `causalId` que no es un UUID es 400 y no llega a la base', async () => {
    escenario();

    const r = await gestionar({ causalId: 'la-de-siempre' }, await auth());

    // Sin esto, la comparación contra una columna `uuid` reventaría con un 22P02 —un 500— en vez de
    // decir qué pasa.
    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
  });
});

// ─────────────────────────── AC7 · Los datos de fuente no se editan ─────────────────────────────

describe('AC7 — los datos de fuente siguen siendo inmutables (RN-04, CF-09)', () => {
  const auth = sesion(7207);

  it.each([
    ['placa', { placa: 'XYZ789' }],
    ['monto', { monto: '1.00' }],
    ['origenMerge', { origenMerge: 'simit' }],
    ['estado', { estado: 'inactivo' }],
    ['numeroComparendo', { numeroComparendo: 'OTRO' }],
    // Las dos del sello de auditoría no son «de fuente», pero tampoco las escribe el cliente: quien
    // las mandara estaría firmando la gestión a nombre de otro o retrofechándola. Hoy lo impide
    // `.strict()`; esto es el candado de regresión por si alguien relaja el esquema.
    ['gestionActualizadaPor', { gestionActualizadaPor: 999 }],
    ['gestionActualizadaEn', { gestionActualizadaEn: '2020-01-01T00:00:00.000Z' }],
  ])('un cuerpo que intenta escribir `%s` es 400 y no toca ninguna columna', async (_campo, cuerpo) => {
    escenario();

    const r = await gestionar(cuerpo, await auth());

    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
  });

  it('mezclar un campo válido con uno de fuente NO guarda el válido: es 400 entero', async () => {
    escenario();

    const r = await gestionar({ causalId: CAUSAL_ACTIVA, placa: 'XYZ789' }, await auth());

    // Guardar «lo que sí se podía» y descartar el resto sería lo peor de los dos mundos: quien lo
    // mandó creería que cambió la placa.
    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
  });

  it('**el `set()` que llega a la base nombra solo las dos editables y el sello**', async () => {
    escenario();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    // La otra mitad de la promesa: el 400 cierra la puerta de entrada, esto cierra la de salida. Un
    // `set` con una columna de fuente dentro sería RN-04 roto aunque el esquema la hubiera
    // rechazado, porque el servicio podría escribirla por su cuenta.
    expect(Object.keys(updates()[0].datos as object).sort()).toEqual([
      'causalId', 'gestionActualizadaEn', 'gestionActualizadaPor', 'observacion', 'updatedAt',
    ]);
  });
});

// ─────────────────────────── AC8 · Registro inexistente ─────────────────────────────────────────

describe('AC8 — un id que no existe es 404 y no revela nada', () => {
  const auth = sesion(7208);

  it('responde 404 sin escribir nada', async () => {
    escenario({ registro: null });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('no_encontrado');
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
  });

  it('el mensaje no menciona NIT, placa ni a qué empresa pertenecería el comparendo', async () => {
    escenario({ registro: null });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    // Hoy la propiedad se cumple por ausencia —no hay multi-tenancy y `obtenerRegistro` filtra solo
    // por id—, así que lo que se puede afirmar es que la respuesta no cuenta nada de nadie.
    const cuerpo = JSON.stringify(r.body).toLowerCase();
    expect(cuerpo).not.toContain('nit');
    expect(cuerpo).not.toContain('placa');
    expect(cuerpo).not.toContain('empresa');
  });

  it('un `:id` que no es un UUID es 400, no un 500 desde PostgreSQL', async () => {
    escenario();

    const r = await gestionar({ observacion: OBSERVACION }, await auth(), 'no-es-un-uuid');

    expect(r.status).toBe(400);
    expect(espia.updates).toEqual([]);
  });
});

// ─────────────────────────── AC9 · Permisos, caché y datos personales ───────────────────────────

describe('AC9 — permisos, `no-store` y los dos rastros', () => {
  const auth = sesion(7209);

  it('sin token responde 401 y no escribe nada', async () => {
    escenario();

    const r = await request(await buildApp())
      .patch(`${BASE}/registros/${ID}/gestion`)
      .send({ observacion: OBSERVACION });

    expect(r.status).toBe(401);
    expect(espia.updates).toEqual([]);
  });

  it.each<TestRole>(['auditor', 'transito', 'compliance'])('el rol `%s` responde 403', async (role) => {
    escenario();

    const r = await gestionar({ observacion: OBSERVACION }, await auth(role));

    expect(r.status).toBe(403);
    expect(espia.updates).toEqual([]);
  });

  it('la respuesta exitosa sale con `Cache-Control: no-store`', async () => {
    escenario();

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    // Lleva NIT y placa: no se guarda en ninguna caché intermedia ni en el disco del navegador.
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('**deja registro en `pii_access_log`** con el recurso, los campos y el id del comparendo', async () => {
    escenario();

    await gestionar({ observacion: OBSERVACION }, await auth());

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const [, opts] = logPiiAccessMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.resourceTipo).toBe('flito_comparendos_registro');
    // `read` y no una acción de escritura: la unión de `logPiiAccess` es `read | export | decrypt |
    // search` y lo que se registra es que alguien VIO el NIT y la placa que la respuesta devolvió.
    expect(opts.accion).toBe('read');
    // La observación entra en la lista desde esta HU: es el único campo del módulo que redacta una
    // persona y esta respuesta la devuelve. Declarar menos PII de la que se entrega deja un rastro
    // que no sirve para responderle a un titular.
    expect(opts.camposAccedidos).toEqual(['nit_monitoreado', 'placa', 'observacion']);
    expect(String(opts.motivo)).toContain(ID);
  });

  it('**deja registro en la bitácora** (`audit`), que no es lo mismo y no se sustituye', async () => {
    escenario();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, entrada] = auditMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(entrada).toMatchObject({
      action: 'update',
      resource: 'flito_comparendos_registro',
      resourceId: ID,
    });
  });

  it('**ni el NIT, ni la placa, ni la observación aparecen en los dos rastros**', async () => {
    escenario();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    const [, entrada] = auditMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const [, opts] = logPiiAccessMock.mock.calls[0] as [unknown, Record<string, unknown>];
    const escrito = `${JSON.stringify(entrada)} ${JSON.stringify(opts)}`;

    // La observación la redacta una persona y puede llevar dentro lo que a esa persona le pareciera
    // relevante: un nombre, un teléfono, un radicado. `audit_logs` se consulta y se exporta.
    expect(escrito).not.toContain(OBSERVACION);
    expect(escrito).not.toContain(PLACA);
    expect(escrito).not.toContain(NIT);
    // Lo que sí queda escrito es que hubo una observación y cuánto medía, que es lo accionable.
    expect(String(entrada.detail)).toContain(String(OBSERVACION.length));
  });

  it('el `detalle` del evento tampoco lleva la observación (RN-41) ni datos de fuente (RN-20)', async () => {
    escenario();

    await gestionar({ causalId: CAUSAL_ACTIVA, observacion: OBSERVACION }, await auth());

    const detalle = JSON.stringify(eventosEscritos()[0].detalle);
    expect(detalle).not.toContain(OBSERVACION);
    expect(detalle).not.toContain(PLACA);
    expect(detalle).not.toContain(NIT);
    // Lleva el «quién», que la tabla de eventos no tiene como columna y la fila solo guarda del
    // ÚLTIMO que gestionó.
    expect(eventosEscritos()[0].detalle).toMatchObject({ actorId: 7209, causalId: CAUSAL_ACTIVA });
  });
});

// ─────────────────────────── La respuesta sale por la lista blanca (RN-31) ──────────────────────

describe('la respuesta del PATCH es la MISMA lectura de siempre, no un `RETURNING *`', () => {
  const auth = sesion(7210);

  it('**los payloads crudos no salen**, aunque la fila del mock los traiga con una cédula dentro', async () => {
    escenario();

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    // El AC1 («200 con el registro actualizado») se cumple igual con un `UPDATE ... RETURNING *`, y
    // eso publicaría la respuesta cruda de un tercero sobre un tercero por el único endpoint del
    // módulo que la suite de lectura no vigila.
    expect(JSON.stringify(r.body)).not.toContain(CEDULA_EN_PAYLOAD);
    expect(r.body).not.toHaveProperty('payloadSimit');
    expect(r.body).not.toHaveProperty('payloadMunicipal');
  });

  it('la lectura que arma la respuesta enumera sus columnas y ninguna es un payload', async () => {
    escenario();

    await gestionar({ observacion: OBSERVACION }, await auth());

    // La proyección con más columnas es la de `obtenerRegistro`: la del bloqueo pide dos y la del
    // catálogo de causales, otras dos.
    const proyeccion = proyecciones
      .filter((p) => p.tabla === TABLA)
      .sort((a, b) => b.columnas.length - a.columnas.length)[0];
    expect(proyeccion.columnas.length).toBeGreaterThan(10);
    expect(proyeccion.columnas).not.toContain('payloadSimit');
    expect(proyeccion.columnas).not.toContain('payloadMunicipal');
  });

  it('**la lectura que arma la respuesta ocurre DENTRO de la transacción**', async () => {
    escenario();

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.status).toBe(200);
    // Dos lecturas del registro: el `FOR UPDATE` del bloqueo y la que construye la respuesta. Las
    // dos tienen que estar hechas cuando la transacción cierra.
    //
    // Leyendo después del COMMIT hay una ventana real —la purga por retención puede borrar la fila
    // entre las dos operaciones— y el endpoint respondería 404 con el cambio ya escrito y sin dejar
    // ni bitácora ni registro de acceso: el único camino por el que «gestionar deja los dos
    // rastros» dejaría de ser verdad. Con la lectura fuera, este contador valdría 1 y el total 2.
    const totalLecturas = proyecciones.filter((p) => p.tabla === TABLA).length;
    expect(totalLecturas).toBe(2);
    expect(lecturasAlCerrarTx).toBe(totalLecturas);
  });

  it('devuelve el timeline junto al registro, para que el panel no pida una segunda vez', async () => {
    escenario({ eventos: [evento({ tipo: 'gestion', syncRunId: null, detalle: { motivo: 'gestion_registrada' } })] });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    expect(r.body.eventos).toHaveLength(1);
    expect(r.body.eventos[0]).toMatchObject({ tipo: 'gestion', syncRunId: null });
    // El `detalle` sigue saliendo por la lista blanca de RN-35: `motivo` sí, lo demás no.
    expect(r.body.eventos[0].detalle).toEqual({ motivo: 'gestion_registrada' });
  });

  it('lo que el evento GUARDA de más no se publica: `campos`, `actorId` y `causalId` no salen', async () => {
    escenario({
      eventos: [evento({
        tipo: 'gestion',
        syncRunId: null,
        detalle: { motivo: 'gestion_registrada', campos: ['causal'], actorId: 7210, causalId: CAUSAL_ACTIVA },
      })],
    });

    const r = await gestionar({ observacion: OBSERVACION }, await auth());

    // Ampliar la lista blanca de RN-35 es una decisión de la pantalla que necesite pintar la causal
    // en el timeline, no un efecto colateral de que la columna sea JSONB.
    expect(r.body.eventos[0].detalle).toEqual({ motivo: 'gestion_registrada' });
  });
});
