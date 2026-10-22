// FLITO sync — pase de FLIT 2 y «Probar conexión» (HU #13063, Feature #13057).
//
// Andamiaje de `flito-sync.flit2-acceso.test.ts`: Drizzle mockeado por NOMBRE DE TABLA (`keyed-db`)
// con espías sobre `set()`/`values()`, y el cifrado REAL con la `FLIT2_ENC_KEY` de `setup.ts` (la fila
// que devuelve la base se cifra aquí mismo). `fetch` es un `vi.fn` global: ningún caso sale a la red.
// Reloj falso (solo `Date`) y `TZ=UTC` fijado abajo: los asertos de caducidad no dependen del huso.
//
// Mapa AC → casos: AC1 conectado · AC2 sin PII · AC3 rechazado y pausa sin bucle · AC4 bloqueado 15
// min · AC5 pide esperar · AC6 no responde · AC7 sin acceso / sin URL · AC8 la prueba pide pase nuevo
// · AC9 reutiliza el pase y renueva una vez ante 401 · AC10 reemplazar levanta la pausa y descarta.

process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const BASE_FLIT2 = 'https://flit2.ejemplo.test';
const entorno: { baseUrl: string | undefined } = { baseUrl: BASE_FLIT2 };

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_BASE_URL') return entorno.baseUrl;
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
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { obtenerPase, conPase, invalidarPase } = await import('../../src/modules/flito-sync/flit2-pase.service.js');
const { guardarAcceso } = await import('../../src/modules/flito-sync/flit2-acceso.service.js');
const { Flit2RechazadoError, Flit2BloqueadoError, Flit2NoConfiguradoError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');
const { encryptFlit2Secret } = await import('../../src/shared/utils/crypto.js');

const RUTA = '/api/flito/sync/flit2/acceso/probar';
const URL_TOKEN = `${BASE_FLIT2}/api/v1/external/auth/token`;
const TABLA = 'flito_sync_flit2_acceso';
const AHORA = new Date('2026-09-29T15:30:00Z');
const CLIENT_ID = 'flito-sync';
const SECRETO = 'contrasena-ficticia-de-prueba-flit-dos';
const TOKEN_A = 'jwt-de-prueba-primero';
const TOKEN_B = 'jwt-de-prueba-segundo';
const SCOPE_PII = ['external.tramites.read', 'external.tramites.pii.read'];
const SCOPE_SIN_PII = ['external.tramites.read'];
const AAD_NONCE = '5b0f3c2e-7a41-4d6b-9e28-1c3f5a7b9d02';

/** Fila vigente tal como la lee `leerSecretoVigente` (con el cipher real de `SECRETO`). */
function filaVigente(over: Record<string, unknown> = {}) {
  const b = encryptFlit2Secret(SECRETO, { table: TABLA, column: 'secret_cipher', empresaNit: 'flit2', aadNonce: AAD_NONCE });
  return {
    id: 3, clientId: CLIENT_ID, secretCipher: b.cipher, secretIv: b.iv, secretAuthTag: b.authTag,
    keyVersion: b.keyVersion, aadNonce: AAD_NONCE, activo: true,
    rechazadoEn: null, rechazoMotivo: null, bloqueadoHasta: null, bloqueoMotivo: null,
    ...over,
  };
}

const fetchMock = vi.fn();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const tokenOk = (accessToken = TOKEN_A, scope = SCOPE_PII, expiresIn = 1800) =>
  json(200, { accessToken, tokenType: 'Bearer', expiresIn, scope });
const problema = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://flit2/errors/${code}`, title: code, status, detail: 'detalle interno de FLIT 2 que no debe salir' }), {
    status, headers: { 'Content-Type': 'application/problem+json', ...headers },
  });

const sets: Record<string, unknown>[] = [];
const values: Record<string, unknown>[] = [];
function espiarEscrituras(): void {
  const updateImpl = kdb.update.getMockImplementation()!;
  kdb.update.mockImplementation((tbl: unknown) => {
    const chain = updateImpl(tbl) as Record<string, unknown>;
    const set = chain.set as (v: unknown) => unknown;
    chain.set = (v: Record<string, unknown>) => { sets.push(v); return set(v); };
    return chain;
  });
  const insertImpl = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const chain = insertImpl(tbl) as Record<string, unknown>;
    const vals = chain.values as (v: unknown) => unknown;
    chain.values = (v: Record<string, unknown>) => { values.push(v); return vals(v); };
    return chain;
  });
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flit2.routes.js');
  app.use('/api/flito/sync/flit2', router);
  return app;
}

// El limitador de la prueba cuenta por usuario (5/min): cada petición usa un `sub` distinto salvo
// en el caso que lo mide.
let siguienteSub = 500;
const auth = async (role: TestRole = 'admin', sub = siguienteSub++) =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

async function probar() {
  return request(await buildApp()).post(RUTA).set('Authorization', await auth());
}

/** Marcas escritas en la fila (solo las `set` que tocan rechazo o pausa). */
const marcas = () => sets.filter((s) => 'rechazadoEn' in s || 'bloqueadoHasta' in s);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: AHORA });
  kdb.reset();
  espiarEscrituras();
  sets.length = 0;
  values.length = 0;
  auditMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  entorno.baseUrl = BASE_FLIT2;
  invalidarPase();
  kdb.when.select(TABLA, [filaVigente()]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AC1 · conectado', () => {
  it('200 con pii.read → `conectado`, con el scope y sin el pase ni la contraseña en la respuesta', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    const r = await probar();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'conectado', mensaje: 'conectado con FLIT 2', bloqueadoHasta: null, scope: SCOPE_PII });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_A);
    expect(JSON.stringify(r.body)).not.toContain(SECRETO);
  });

  it('pide el token a `FLIT2_BASE_URL` con el usuario de servicio y la contraseña descifrada, con timeout', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    await probar();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe(URL_TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ clientId: CLIENT_ID, clientSecret: SECRETO });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('audita solo el desenlace: ni pase ni contraseña', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    await probar();

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(entrada).toMatchObject({ resource: 'flit2_acceso', resourceId: '3', detail: 'flit2.acceso.probar: resultado=conectado' });
    expect(JSON.stringify(entrada)).not.toContain(TOKEN_A);
    expect(JSON.stringify(entrada)).not.toContain(SECRETO);
  });

  it('el pase viaja como `Redacted`: serializado no muestra el token', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    const pase = await obtenerPase();

    expect(pase.authorization.unwrap()).toBe(`Bearer ${TOKEN_A}`);
    expect(JSON.stringify(pase)).not.toContain(TOKEN_A);
    expect(String(pase.authorization)).toBe('[REDACTED]');
    expect(pase.conPii).toBe(true);
  });
});

describe('AC2 · conectado sin PII', () => {
  it('200 sin pii.read → `conectado_sin_pii` con el aviso de SOAT e impuestos en espera', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A, SCOPE_SIN_PII));

    const r = await probar();

    expect(r.body).toEqual({
      resultado: 'conectado_sin_pii',
      mensaje: 'conectado, pero sin permiso de datos personales: SOAT e impuestos de FLIT 2 quedarán en espera',
      bloqueadoHasta: null,
      scope: SCOPE_SIN_PII,
    });
  });

  it('el pase de un proceso automático lo marca `conPii: false`', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A, SCOPE_SIN_PII));
    expect((await obtenerPase()).conPii).toBe(false);
  });
});

describe('AC3 · rechazado, y pausa sin bucle', () => {
  it('401 invalid_client → `rechazado` y marca durable `invalid_client` en la fila vigente', async () => {
    fetchMock.mockResolvedValueOnce(problema(401, 'invalid_client'));

    const r = await probar();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'rechazado', mensaje: 'usuario o contraseña rechazados por FLIT 2', bloqueadoHasta: null, scope: [] });
    expect(marcas()).toEqual([expect.objectContaining({ rechazadoEn: AHORA, rechazoMotivo: 'invalid_client' })]);
  });

  it('403 secret_rotation_required → `cambio_clave` y marca `secret_rotation_required`', async () => {
    fetchMock.mockResolvedValueOnce(problema(403, 'secret_rotation_required'));

    const r = await probar();

    expect(r.body).toMatchObject({ resultado: 'cambio_clave', mensaje: 'FLIT 2 exige cambiar la contraseña de este acceso' });
    expect(marcas()).toEqual([expect.objectContaining({ rechazoMotivo: 'secret_rotation_required' })]);
  });

  it('el cuerpo RFC 7807 de FLIT 2 no se reenvía', async () => {
    fetchMock.mockResolvedValueOnce(problema(401, 'invalid_client'));
    const r = await probar();
    expect(JSON.stringify(r.body)).not.toContain('detalle interno');
  });

  it('con la fila rechazada, `obtenerPase` y `conPase` fallan al instante SIN llamar a FLIT 2', async () => {
    kdb.when.select(TABLA, [filaVigente({ rechazadoEn: AHORA, rechazoMotivo: 'invalid_client' })]);
    const fn = vi.fn();

    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2RechazadoError);
    await expect(conPase(fn)).rejects.toBeInstanceOf(Flit2RechazadoError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('un 401 en un proceso automático marca la fila y el siguiente intento ya no llama (sin bucle)', async () => {
    fetchMock.mockResolvedValueOnce(problema(401, 'invalid_client'));
    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2RechazadoError);
    expect(marcas()).toHaveLength(1);

    // La marca es durable: la siguiente lectura de la fila ya la trae.
    kdb.when.select(TABLA, [filaVigente({ rechazadoEn: AHORA, rechazoMotivo: 'invalid_client' })]);
    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2RechazadoError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('decisión del PO: probar con la fila rechazada SÍ llama y, con un 200, limpia las marcas', async () => {
    kdb.when.select(TABLA, [filaVigente({ rechazadoEn: AHORA, rechazoMotivo: 'invalid_client' })]);
    fetchMock.mockResolvedValueOnce(tokenOk());

    const r = await probar();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.body.resultado).toBe('conectado');
    expect(marcas()).toEqual([{ rechazadoEn: null, rechazoMotivo: null, bloqueadoHasta: null, bloqueoMotivo: null, updatedAt: AHORA }]);
  });
});

describe('AC4 · bloqueado 15 min', () => {
  const EN_15_MIN = new Date(AHORA.getTime() + 15 * 60_000);

  it('423 → `bloqueado` y `bloqueado_hasta` = ahora + 15 min con motivo `client_locked`', async () => {
    fetchMock.mockResolvedValueOnce(problema(423, 'client_locked'));

    const r = await probar();

    expect(r.body).toEqual({
      resultado: 'bloqueado',
      mensaje: 'FLIT 2 bloqueó temporalmente el acceso; se libera solo en 15 minutos',
      bloqueadoHasta: EN_15_MIN.toISOString(),
      scope: [],
    });
    expect(marcas()).toEqual([expect.objectContaining({ bloqueadoHasta: EN_15_MIN, bloqueoMotivo: 'client_locked' })]);
  });

  it('con `bloqueado_hasta` futuro por 423, probar NO llama y responde `bloqueado`', async () => {
    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: EN_15_MIN, bloqueoMotivo: 'client_locked' })]);

    const r = await probar();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ resultado: 'bloqueado', bloqueadoHasta: EN_15_MIN.toISOString() });
  });

  it('con `bloqueado_hasta` futuro, `obtenerPase` falla al instante sin llamar', async () => {
    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: EN_15_MIN, bloqueoMotivo: 'client_locked' })]);

    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2BloqueadoError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pasado `bloqueado_hasta`, se vuelve a llamar', async () => {
    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: new Date(AHORA.getTime() - 1000), bloqueoMotivo: 'client_locked' })]);
    fetchMock.mockResolvedValueOnce(tokenOk());

    await expect(obtenerPase()).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HU #13092 AC5 · la pausa del 423 dura lo que diga Retry-After (tope 900 s)', () => {
  it.each([
    ['120', 120],
    ['900', 900],
    ['3600', 900],
  ])('423 con Retry-After %s → pausa de %i s en la fila, y durante la pausa `obtenerPase` no llama', async (cabecera, segundos) => {
    fetchMock.mockResolvedValueOnce(problema(423, 'client_locked', { 'Retry-After': cabecera }));

    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2BloqueadoError);

    const hasta = new Date(AHORA.getTime() + segundos * 1000);
    expect(marcas()).toEqual([expect.objectContaining({ bloqueadoHasta: hasta, bloqueoMotivo: 'client_locked' })]);
    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: hasta, bloqueoMotivo: 'client_locked' })]);
    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2BloqueadoError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([['ilegible'], ['0'], ['-5']])('423 con Retry-After %j que no sirve → 15 min', async (cabecera) => {
    fetchMock.mockResolvedValueOnce(problema(423, 'client_locked', { 'Retry-After': cabecera }));

    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2BloqueadoError);

    expect(marcas()).toEqual([expect.objectContaining({ bloqueadoHasta: new Date(AHORA.getTime() + 15 * 60_000) })]);
  });

  it('423 con el cuerpo RFC 7807 de FLIT 2 (`code`) → el `bloqueado_hasta` sale del Retry-After, no del cuerpo', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'client_locked', status: 423, retryAfter: 9999 }), {
      status: 423, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '300' },
    }));

    const e = await obtenerPase().catch((x: unknown) => x);

    expect(e).toBeInstanceOf(Flit2BloqueadoError);
    expect((e as InstanceType<typeof Flit2BloqueadoError>).hasta).toEqual(new Date(AHORA.getTime() + 300_000));
  });
});

describe('AC5 · pide esperar', () => {
  it('429 con Retry-After → `espera` y `bloqueado_hasta` según la cabecera, motivo `rate_limited`', async () => {
    fetchMock.mockResolvedValueOnce(problema(429, 'rate_limited', { 'Retry-After': '120' }));

    const r = await probar();

    const hasta = new Date(AHORA.getTime() + 120_000);
    expect(r.body).toEqual({
      resultado: 'espera',
      mensaje: 'FLIT 2 pidió esperar; intenta de nuevo en un minuto',
      bloqueadoHasta: hasta.toISOString(),
      scope: [],
    });
    expect(marcas()).toEqual([expect.objectContaining({ bloqueadoHasta: hasta, bloqueoMotivo: 'rate_limited' })]);
  });

  it('429 sin Retry-After → espera de 60 s', async () => {
    fetchMock.mockResolvedValueOnce(problema(429, 'rate_limited'));

    const r = await probar();

    expect(r.body.bloqueadoHasta).toBe(new Date(AHORA.getTime() + 60_000).toISOString());
  });

  it('con `bloqueado_hasta` futuro por 429, probar NO llama y responde `espera`', async () => {
    const hasta = new Date(AHORA.getTime() + 30_000);
    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: hasta, bloqueoMotivo: 'rate_limited' })]);

    const r = await probar();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ resultado: 'espera', bloqueadoHasta: hasta.toISOString() });
  });
});

describe('AC6 · no responde, sin error crudo', () => {
  it.each([
    ['timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['red caída', () => Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED flit2.ejemplo.test'))],
    ['5xx', () => Promise.resolve(problema(502, 'bad_gateway'))],
    ['200 ilegible', () => Promise.resolve(new Response('<html>proxy</html>', { status: 200 }))],
  ])('%s → `no_responde`, sin marca y sin el error crudo', async (_caso, respuesta) => {
    fetchMock.mockImplementationOnce(respuesta);

    const r = await probar();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resultado: 'no_responde', mensaje: 'FLIT 2 no responde', bloqueadoHasta: null, scope: [] });
    expect(marcas()).toEqual([]);
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|timeout|detalle interno|proxy/);
  });
});

describe('AC7 · sin acceso o sin URL, sin llamar a FLIT 2', () => {
  it('sin acceso guardado → `sin_acceso`', async () => {
    kdb.when.select(TABLA, []);

    const r = await probar();

    expect(r.body).toEqual({ resultado: 'sin_acceso', mensaje: 'primero hay que guardar un acceso', bloqueadoHasta: null, scope: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin `FLIT2_BASE_URL` → `no_configurado`, sin leer la fila ni llamar', async () => {
    entorno.baseUrl = undefined;

    const r = await probar();

    expect(r.body).toEqual({ resultado: 'no_configurado', mensaje: 'FLIT 2 no está configurado en este ambiente', bloqueadoHasta: null, scope: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('sin URL, `obtenerPase` lanza `Flit2NoConfiguradoError`', async () => {
    entorno.baseUrl = undefined;
    await expect(obtenerPase()).rejects.toBeInstanceOf(Flit2NoConfiguradoError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AC8 · la prueba pide siempre un pase nuevo', () => {
  it('con un pase vigente en caché, probar pide otro, y ese queda como el vigente', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A)).mockResolvedValueOnce(tokenOk(TOKEN_B));

    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_A}`);
    await probar();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // El proceso automático reutiliza el de la prueba, sin tercera llamada.
    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_B}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC9 · reutiliza el pase y renueva una sola vez ante 401', () => {
  it('reutiliza el pase mientras falten más de 60 s y lo renueva cuando faltan menos', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A)).mockResolvedValueOnce(tokenOk(TOKEN_B));

    await obtenerPase();
    vi.setSystemTime(new Date(AHORA.getTime() + (1800 - 61) * 1000)); // 28 min 59 s
    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_A}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(AHORA.getTime() + (1800 - 59) * 1000));
    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_B}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('varias peticiones a la vez → una sola petición de token', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A));

    const pases = await Promise.all([obtenerPase(), obtenerPase(), obtenerPase()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(pases.map((p) => p.authorization.unwrap()))).toEqual(new Set([`Bearer ${TOKEN_A}`]));
  });

  it('`conPase`: ante un 401 del recurso invalida, renueva y reintenta UNA vez con el pase nuevo', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A)).mockResolvedValueOnce(tokenOk(TOKEN_B));
    const vistos: string[] = [];
    const fn = vi.fn(async (p: { authorization: { unwrap(): string } }) => {
      vistos.push(p.authorization.unwrap());
      return new Response('{}', { status: vistos.length === 1 ? 401 : 200 });
    });

    const r = await conPase(fn);

    expect(r.status).toBe(200);
    expect(vistos).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('`conPase`: si vuelve el 401, no hay segundo reintento: entrega esa respuesta', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A)).mockResolvedValueOnce(tokenOk(TOKEN_B));
    const fn = vi.fn(async () => new Response('{}', { status: 401 }));

    const r = await conPase(fn);

    expect(r.status).toBe(401);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC10 · reemplazar el acceso levanta la pausa y descarta el pase', () => {
  it('guardar un acceso descarta el pase en memoria: el siguiente proceso pide uno nuevo', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A)).mockResolvedValueOnce(tokenOk(TOKEN_B));
    await obtenerPase();
    kdb.when.insert(TABLA, [{ id: 3 }]);

    await guardarAcceso(CLIENT_ID, SECRETO, 7);

    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_B}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si la transacción falla, el pase del acceso que seguía vigente NO se descarta', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(TOKEN_A));
    await obtenerPase();
    kdb.transaction.mockRejectedValueOnce(new Error('se cayó la base'));

    await expect(guardarAcceso(CLIENT_ID, SECRETO, 7)).rejects.toThrow('se cayó la base');

    expect((await obtenerPase()).authorization.unwrap()).toBe(`Bearer ${TOKEN_A}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('la fila nueva nace sin marcas: la pausa del acceso anterior no la hereda', async () => {
    kdb.when.insert(TABLA, [{ id: 4 }]);

    await guardarAcceso(CLIENT_ID, SECRETO, 7);

    expect(values).toHaveLength(1);
    for (const marca of ['rechazadoEn', 'rechazoMotivo', 'bloqueadoHasta', 'bloqueoMotivo']) {
      expect(values[0]![marca] ?? null).toBeNull();
    }
  });
});

describe('permisos y limitador de «Probar conexión»', () => {
  it('sin Authorization → 401, sin llamar a FLIT 2', async () => {
    const r = await request(await buildApp()).post(RUTA);
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])('rol %s sin «guardar el acceso» → 403, sin llamar', async (rol) => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth(rol));
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('5 pruebas por minuto y usuario: la sexta → 429 sin llamar a FLIT 2', async () => {
    fetchMock.mockImplementation(async () => tokenOk());
    const app = await buildApp();
    const token = await auth('admin', 9001);

    for (let i = 0; i < 5; i++) expect((await request(app).post(RUTA).set('Authorization', token)).status).toBe(200);
    const sexta = await request(app).post(RUTA).set('Authorization', token);

    expect(sexta.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('Bug #13198 · el error dice si FLIT 2 acaba de responder o si es la marca guardada', () => {
  it('423 recibido → `respondioFlit2 = true`; durante la pausa (sin llamar) → `false`', async () => {
    fetchMock.mockResolvedValueOnce(problema(423, 'client_locked', { 'Retry-After': '300' }));
    const recibido = await obtenerPase().catch((x: unknown) => x);
    expect(recibido).toBeInstanceOf(Flit2BloqueadoError);
    expect((recibido as InstanceType<typeof Flit2BloqueadoError>).respondioFlit2).toBe(true);

    kdb.when.select(TABLA, [filaVigente({ bloqueadoHasta: new Date(AHORA.getTime() + 300_000), bloqueoMotivo: 'client_locked' })]);
    const guardado = await obtenerPase().catch((x: unknown) => x);
    expect(guardado).toBeInstanceOf(Flit2BloqueadoError);
    expect((guardado as InstanceType<typeof Flit2BloqueadoError>).respondioFlit2).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 recibido → `respondioFlit2 = true`; con la marca de rechazo guardada → `false`', async () => {
    fetchMock.mockResolvedValueOnce(problema(401, 'invalid_client'));
    const recibido = await obtenerPase().catch((x: unknown) => x);
    expect(recibido).toBeInstanceOf(Flit2RechazadoError);
    expect((recibido as InstanceType<typeof Flit2RechazadoError>).respondioFlit2).toBe(true);

    kdb.when.select(TABLA, [filaVigente({ rechazadoEn: AHORA, rechazoMotivo: 'invalid_client' })]);
    const guardado = await obtenerPase().catch((x: unknown) => x);
    expect(guardado).toBeInstanceOf(Flit2RechazadoError);
    expect((guardado as InstanceType<typeof Flit2RechazadoError>).respondioFlit2).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
