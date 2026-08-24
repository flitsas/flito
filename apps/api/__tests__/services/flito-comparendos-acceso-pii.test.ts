// FLITO comparendos — registro de acceso a datos personales (HU #11511, AC3).
//
// Ley 1581 art. 17: el titular puede preguntar quién consultó sus datos y para qué. Hasta esta HU,
// leer comparendos o corridas —que llevan NITs, y un NIT de persona natural es un documento de
// identidad— no dejaba ni una línea en `pii_access_log`.
//
// Lo que se demuestra:
//
//   1. **Leer dispara el registro de acceso**, con quién, qué recurso y qué campos.
//   2. **El motivo no filtra el dato que protege**: un filtro por NIT o por placa va enmascarado.
//      Escribir el NIT dentro del rastro de quién lo miró sería publicar el dato en el registro que
//      existe para protegerlo.
//   3. **Un 404 no registra acceso**: nadie miró los datos de nadie, y registrarlo llenaría el log
//      de accesos que no ocurrieron.
//   4. **El contrato que la HU #11502 va a usar** en `GET /registros` existe y está probado aquí,
//      con `RECURSO_REGISTROS` y los campos del registro consolidado.
//   5. **Bug #11646 — el criterio entero, no solo el rastro**: las tres rutas que se habían quedado
//      fuera (`GET /nits` y las dos de `/sync/runs`) dejan registro, salen con `no-store` y gastan
//      cuota. Se prueban juntas a propósito: rastro sin `no-store` es saber quién miró una respuesta
//      que igualmente quedó guardada en el disco del navegador.
//   6. **Bug #11671 — dónde pasa la línea**: las dos escrituras de `/nits` salen con `no-store`, y
//      solo el `PATCH` deja registro de acceso. Lo que decide no es el verbo HTTP sino si la
//      respuesta entrega datos personales que el cliente NO aportó.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/**
 * `logPiiAccess` se mockea en vez de mirar el INSERT sobre `pii_access_log`.
 *
 * Es el contrato que hay que fijar: lo que el módulo tiene que garantizar es QUÉ le pasa al helper
 * compartido —recurso, acción, campos, motivo—, no cómo ese helper escribe su fila. Que la fila se
 * escriba (y que sea append-only por trigger) es asunto de `shared/pii-audit.ts`.
 */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const {
  CAMPOS_PII_NIT,
  CAMPOS_PII_PAYLOAD,
  CAMPOS_PII_REGISTRO,
  CAMPOS_PII_SYNC_RUN,
  RECURSO_NIT,
  RECURSO_REGISTROS,
  RECURSO_SYNC_RUN,
  registrarAccesoComparendos,
} = await import('../../src/modules/flito-comparendos/flito-comparendos.pii.js');

const BASE = '/api/flito/comparendos';
const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NIT_ID = '11111111-1111-1111-1111-111111111111';
const AHORA = new Date('2026-08-20T12:00:00Z');

/** Fila de `flito_comparendos_nits` tal como la devuelve el SELECT del catálogo. */
const filaNit = (over: Record<string, unknown> = {}) => ({
  id: NIT_ID, nit: '900123456', alias: 'Transportes ACME', activo: true,
  createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7, ...over,
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (sub = 7) => `Bearer ${await testToken({ sub, username: 'ops@flit.io', role: 'admin' })}`;

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

/** Petición fingida, para ejercer el contrato sin pasar por un endpoint. */
const reqFalso = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

beforeEach(() => {
  kdb.reset();
  logPiiAccessMock.mockClear();
});

// ─────────────────────────── El contrato para la HU #11502 ──────────────────────────────────────

describe('registrarAccesoComparendos — el contrato (AC3)', () => {
  it('traduce un listado de registros a un acceso `search` con sus campos y su conteo', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filas: 42,
    });

    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: 'flito_comparendos_registro',
      accion: 'search',
      camposAccedidos: ['nit_monitoreado', 'placa'],
    });
    expect(ultimoAcceso().motivo).toContain('filas=42');
  });

  it('**los filtros personales van enmascarados en el motivo**', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filtros: { nit: '900123456', placa: 'ABC123', estado: 'activo' },
    });

    const motivo = String(ultimoAcceso().motivo);
    // El NIT y la placa no pueden aparecer en claro: sería escribir el dato protegido dentro del
    // rastro que existe para protegerlo.
    expect(motivo).not.toContain('900123456');
    expect(motivo).not.toContain('ABC123');
    // Pero la CLAVE sí: saber que alguien buscó «por placa» es justo lo que hace útil el registro.
    expect(motivo).toContain('nit=');
    expect(motivo).toContain('placa=');
    expect(motivo).toContain('estado=activo');
  });

  it('no vuelca arrays ni objetos en el motivo: deja constancia de que el filtro se usó', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'export',
      campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_PAYLOAD],
      filtros: { nits: ['900123456', '800999888'] },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('900123456');
    expect(motivo).toContain('nits=');
    // Y los payloads se listan aparte de las columnas del canónico: es lo que permite responder
    // «¿alguien ha mirado los payloads?» sin leer el código de cada endpoint.
    expect(ultimoAcceso().camposAccedidos)
      .toEqual(['nit_monitoreado', 'placa', 'payload_simit', 'payload_municipal']);
  });

  it('el motivo nunca desborda el `varchar(200)` de la columna', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filtros: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`campo${i}`, `valor-${i}`])),
    });

    // Pasarse sería un 22001 de PostgreSQL: el rastro se perdería justo en la lectura más ruidosa.
    expect(String(ultimoAcceso().motivo).length).toBeLessThanOrEqual(200);
  });

  it('el UUID viaja en el motivo porque `resource_id` es `integer` y no le cabe', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'read',
      campos: [...CAMPOS_PII_REGISTRO],
      referencia: RUN_ID,
    });

    // Inventarse un número sería peor que no poner nada: apuntaría a otro recurso.
    expect(ultimoAcceso().resourceId).toBeNull();
    expect(String(ultimoAcceso().motivo)).toContain(RUN_ID);
  });
});

// ─────────────────────────── Las lecturas que existen hoy ───────────────────────────────────────

describe('GET /sync/runs — la lectura deja rastro (AC3)', () => {
  it('el listado registra un acceso `search` con cuántas corridas se entregaron', async () => {
    kdb.when.select('flito_comparendos_sync_runs', [
      { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
        iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
    ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_SYNC_RUN,
      accion: 'search',
      camposAccedidos: [...CAMPOS_PII_SYNC_RUN],
    });
    expect(String(ultimoAcceso().motivo)).toContain('filas=1');
  });

  it('el detalle registra un acceso `read` con el id de la corrida', async () => {
    kdb.when
      .select('flito_comparendos_sync_runs', [
        { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
          iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
      ])
      .select('flito_comparendos_sync_steps', [
        { nit: '900123456', fuente: 'simit', ok: true, httpStatus: 200, errorCode: null,
          mensaje: null, itemsLeidos: 3, duracionMs: 120 },
      ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(ultimoAcceso()).toMatchObject({ resourceTipo: RECURSO_SYNC_RUN, accion: 'read' });
    expect(String(ultimoAcceso().motivo)).toContain(RUN_ID);
    // El NIT del paso viaja en la respuesta, así que el acceso lo declara entre sus campos.
    expect(ultimoAcceso().camposAccedidos).toContain('nit');
  });

  it('**una corrida que no existe NO registra acceso**', async () => {
    kdb.when.select('flito_comparendos_sync_runs', []);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('sin autenticar tampoco: el guard corre antes que la lectura', async () => {
    const r = await request(await buildApp()).get(`${BASE}/sync/runs`);

    expect(r.status).toBe(401);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Bug #11646 · las tres rutas que se quedaron fuera ──────────────────
//
// El criterio del módulo —rastro + `no-store` + cuota en toda respuesta con NIT dentro— no había
// llegado a `GET /nits` ni a las dos de `/sync/runs`. Lo que se fija aquí es el criterio, no tres
// casos sueltos: si mañana alguien quita cualquiera de las dos mitades, estos tests lo dicen.

describe('GET /nits — el catálogo de a quién se vigila también deja rastro (Bug #11646)', () => {
  it('registra un acceso `search` sobre el recurso del catálogo, con cuántos NITs entregó', async () => {
    kdb.when.select('flito_comparendos_nits', [filaNit(), filaNit({ id: RUN_ID, nit: '800999888', alias: null })]);

    const r = await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    // Era la única respuesta del módulo con NITs dentro que no dejaba ni una línea: se podía listar
    // el catálogo entero sin que constara quién lo consultó (Ley 1581 art. 17).
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_NIT,
      accion: 'search',
      camposAccedidos: [...CAMPOS_PII_NIT],
    });
    // El literal se fija aquí y no solo por la constante: es el MISMO con el que `audit()` anota las
    // altas del catálogo, y es lo que permite cruzar «quién metió este NIT en la lista» con «quién
    // leyó la lista». Cambiarlo rompe ese cruce en silencio.
    expect(RECURSO_NIT).toBe('flito_comparendos_nit');
    // Sin filtros ni `:id` que anotar, el tamaño ES la lectura: distingue el catálogo entero de una
    // consulta menor.
    expect(String(ultimoAcceso().motivo)).toContain('filas=2');
  });

  it('el alias va declarado entre los campos: lo escribe una persona y puede ser un nombre', async () => {
    kdb.when.select('flito_comparendos_nits', [filaNit()]);

    await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth());

    expect(ultimoAcceso().camposAccedidos).toContain('alias');
    // Se nombran las COLUMNAS de la tabla, no las claves del DTO: el log tiene que poder cruzarse
    // con `flito_comparendos_nits`.
    expect(ultimoAcceso().camposAccedidos).toEqual(['nit', 'alias']);
  });

  it('el rastro no filtra lo que protege: ningún NIT del catálogo aparece en el motivo', async () => {
    kdb.when.select('flito_comparendos_nits', [filaNit()]);

    await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth());

    // Primero que HAY rastro: sin esta línea, quitar la llamada al registro dejaría pasar la
    // aserción de abajo por ausencia de motivo en vez de por enmascarado.
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(String(ultimoAcceso().motivo)).not.toContain('900123456');
  });

  it('sin autenticar no hay lectura ni rastro: el guard corre antes', async () => {
    const r = await request(await buildApp()).get(`${BASE}/nits`);

    expect(r.status).toBe(401);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('las tres respuestas con NIT salen con `Cache-Control: no-store` (Bug #11646)', () => {
  // El rastro dice quién miró; no impide que la respuesta se quede escrita en la caché de disco del
  // navegador y siga ahí tras cerrar sesión. Son las dos mitades del mismo criterio, y el módulo ya
  // ponía las dos en `/registros` y en el export.
  it('GET /nits', async () => {
    kdb.when.select('flito_comparendos_nits', [filaNit()]);

    const r = await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('GET /sync/runs — hasta 100 corridas, cada una con su `scope_nits`', async () => {
    kdb.when.select('flito_comparendos_sync_runs', [
      { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
        iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
    ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('GET /sync/runs/:id — el NIT de cada paso', async () => {
    kdb.when
      .select('flito_comparendos_sync_runs', [
        { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
          iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
      ])
      .select('flito_comparendos_sync_steps', [
        { nit: '900123456', fuente: 'simit', ok: true, httpStatus: 200, errorCode: null,
          mensaje: null, itemsLeidos: 3, duracionMs: 120 },
      ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

// ─────────────────────────── Bug #11671 · las dos escrituras del catálogo ──────────────────────
//
// `POST /nits` y `PATCH /nits/:id` devuelven `nit` y `alias` en el cuerpo del 201 y del 200, y
// salían sin `no-store` — contradiciendo la cabecera del propio módulo. El riesgo de la caché es
// bajo (RFC 9111: un POST o un PATCH no se guardan por heurística) y aun así se cierra, porque lo
// que hace daño a largo plazo es el supuesto falso escrito al lado del código: el siguiente que lea
// la cabecera creerá que el criterio ya está puesto en todas partes.
//
// Y las dos NO se resuelven igual en la otra mitad, que es lo que estos tests fijan por escrito:
//
//   · El `POST` no registra acceso. Los dos campos personales del 201 son los que quien pide acaba
//     de teclear, y `crearNit` rechaza el duplicado con un 409 en vez de devolver la fila ajena, así
//     que el alta no le revela a nadie una identidad que no tuviera delante.
//   · El `PATCH` sí. Ahí el cliente manda un UUID opaco y recibe el `nit` de la fila, que no tecleó;
//     es el mismo caso que `PATCH /registros/:id/gestion`, que ya registraba desde la HU #11557. El
//     criterio del módulo es «rastro para toda respuesta que ENTREGUE datos personales que el
//     cliente no aportó», no «rastro para las lecturas y no para las escrituras».

describe('las dos escrituras de /nits salen con `no-store` (Bug #11671)', () => {
  it('POST /nits — el 201 devuelve el NIT recién creado', async () => {
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', [filaNit()]);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456', alias: 'Transportes ACME' });

    expect(r.status).toBe(201);
    expect(r.body.nit).toBe('900123456');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('PATCH /nits/:id — el 200 devuelve la fila entera, NIT incluido', async () => {
    kdb.when.update('flito_comparendos_nits', [filaNit({ alias: 'Otro alias' })]);

    const r = await request(await buildApp()).patch(`${BASE}/nits/${NIT_ID}`)
      .set('Authorization', await auth())
      .send({ alias: 'Otro alias' });

    expect(r.status).toBe(200);
    expect(r.body.nit).toBe('900123456');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('el registro de acceso distingue quién APORTÓ el dato (Bug #11671)', () => {
  it('**`POST /nits` NO registra acceso: el dato entra, no se consulta**', async () => {
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', [filaNit()]);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456', alias: 'Transportes ACME' });

    expect(r.status).toBe(201);
    // `pii_access_log` responde «quién CONSULTÓ mis datos» (Ley 1581 art. 17). El 201 no le revela a
    // quien lo pidió ninguna identidad que no acabara de teclear él mismo —y el duplicado se corta
    // con un 409 antes de insertar, así que tampoco le devuelve el alias que puso otro—. Anotar
    // aquí un acceso llenaría el log de escrituras hasta que dejara de leerse como un registro de
    // lecturas. El rastro de esta ruta es `audit_logs`, no este.
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('**`PATCH /nits/:id` SÍ registra acceso: devuelve un NIT que el cliente no mandó**', async () => {
    kdb.when.update('flito_comparendos_nits', [filaNit({ alias: 'Otro alias' })]);

    const r = await request(await buildApp()).patch(`${BASE}/nits/${NIT_ID}`)
      .set('Authorization', await auth())
      // Lo que viaja en el cuerpo es un alias. El `nit` no: sale en la respuesta, y quien pidió el
      // cambio pudo no haberlo visto nunca — el `:id` es un UUID opaco.
      .send({ alias: 'Otro alias' });

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const opts = ultimoAcceso();
    expect(opts.resourceTipo).toBe(RECURSO_NIT);
    // `read` y no una acción de escritura: el «quién cambió qué» lo cuenta `audit()`, y lo que esta
    // tabla anota es que alguien VIO el NIT y el alias que la respuesta le entregó. Es la misma
    // resolución que `PATCH /registros/:id/gestion`.
    expect(opts.accion).toBe('read');
    expect(opts.camposAccedidos).toEqual([...CAMPOS_PII_NIT]);
    // Un recurso concreto: el UUID va dentro del motivo porque `resource_id` es `integer`.
    expect(String(opts.motivo)).toContain(NIT_ID);
    expect(String(opts.motivo)).toContain('filas=1');
    // Y el NIT no se escribe en el rastro que existe para protegerlo.
    expect(String(opts.motivo)).not.toContain('900123456');
  });

  it('un `PATCH` a un NIT inexistente no registra acceso: nadie miró los datos de nadie', async () => {
    kdb.when.update('flito_comparendos_nits', []);

    const r = await request(await buildApp()).patch(`${BASE}/nits/${NIT_ID}`)
      .set('Authorization', await auth())
      .send({ alias: 'Otro alias' });

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('las tres rutas gastan cuota propia (Bug #11646)', () => {
  // No se agota el límite a golpe de 60 peticiones —sería un test lento y frágil—: basta con que la
  // cabecera estándar del limitador esté, porque solo la pone `express-rate-limit` cuando la ruta
  // pasa por uno. Antes del arreglo el único freno era el `apiLimiter` general de `/api`, que no
  // está montado en este router de prueba: si alguien quita el limitador, aquí no hay cabecera.
  it.each([
    ['/nits', 'flito_comparendos_nits'],
    ['/sync/runs', 'flito_comparendos_sync_runs'],
  ])('%s responde con la cuota del limitador', async (ruta, tabla) => {
    kdb.when.select(tabla, []);

    const r = await request(await buildApp()).get(`${BASE}${ruta}`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.headers['ratelimit-limit']).toBeDefined();
  });

  it('/sync/runs/:id responde con la cuota del limitador', async () => {
    kdb.when
      .select('flito_comparendos_sync_runs', [
        { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
          iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
      ])
      .select('flito_comparendos_sync_steps', []);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.headers['ratelimit-limit']).toBeDefined();
  });
});
