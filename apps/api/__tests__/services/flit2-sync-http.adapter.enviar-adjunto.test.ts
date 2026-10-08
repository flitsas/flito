// HU #13268 (Feature #13267, ADR-0020) — `enviarAdjunto` del adaptador HTTP de FLIT 2 y del fake.
//
// El pase se sustituye (su renovación única ante 401 se prueba en `flito-sync.flit2-pase.test.ts`): aquí
// se afirma que el envío pasa POR `conPase`, que arma el multipart en cada llamada (la renovación la
// repite), qué clasifica y qué NO va al log. `fetch` es un stub; el origen es un placeholder `.test`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const entorno = vi.hoisted(() => ({ base: 'https://flit2.ejemplo.test' as string | undefined }));
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_BASE_URL') return entorno.base;
        return target[prop as string];
      },
    }),
  };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
const pase = vi.hoisted(() => ({ authorization: { unwrap: () => 'Bearer pase-de-prueba' }, scope: [], conPii: true, expiraEn: new Date(0) }));
const conPaseMock = vi.hoisted(() => vi.fn(async (fn: (p: unknown) => Promise<Response>) => fn(pase)));
vi.mock('../../src/modules/flito-sync/flit2-pase.service.js', () => ({ conPase: conPaseMock, obtenerPase: vi.fn(async () => pase) }));
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { crearFlit2SyncHttp } = await import('../../src/modules/flito-sync/flit2-sync-http.adapter.js');
const { crearFlit2SyncFake } = await import('../../src/modules/flito-sync/flit2-sync-fake.adapter.js');
const { Flit2SinAccesoError } = await import('../../src/modules/flito-sync/flit2.errors.js');

const ID = '0192b7c4-5e6a-7d10-9f21-000000000001';
const BYTES = Buffer.from('%PDF-1.7 comprobante de prueba');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const ARCHIVO = { bytes: BYTES, contentType: 'application/pdf', nombreArchivo: 'comprobante-impuesto.pdf' };
const recibido = (over: Record<string, unknown> = {}) => ({
  adjuntoId: '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f', tipo: 'liquidacion_impuesto', sha256: SHA,
  reemplazoDe: null, enMatriz: true, pagadoMarcado: true, ...over,
});
const json = (status: number, cuerpo: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/problem+json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  entorno.base = 'https://flit2.ejemplo.test';
  conPaseMock.mockClear();
  conPaseMock.mockImplementation(async (fn: (p: unknown) => Promise<Response>) => fn(pase));
  for (const m of Object.values(logMock)) m.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('HU #13268 · enviarAdjunto (HTTP)', () => {
  it('POST multipart a la ruta del contrato por conPase: tipo=liquidacion_impuesto, Content-Type de la parte file, nombre genérico, redirect error', async () => {
    fetchMock.mockResolvedValueOnce(json(201, recibido()));
    const r = await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO);
    expect(r).toMatchObject({ tipo: 'enviado', nuevo: true, recibido: { adjuntoId: recibido().adjuntoId, sha256: SHA } });
    expect(conPaseMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`https://flit2.ejemplo.test/api/v1/external/tramites/${ID}/adjuntos`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pase-de-prueba');
    const form = init.body as FormData;
    expect(form.get('tipo')).toBe('liquidacion_impuesto');
    const file = form.get('file') as File;
    expect(file.type).toBe('application/pdf');
    expect(file.name).toBe('comprobante-impuesto.pdf');
    expect(Buffer.from(await file.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('el cuerpo se arma en CADA llamada de conPase (la renovación ante 401 repite la petición con un multipart nuevo)', async () => {
    conPaseMock.mockImplementationOnce(async (fn: (p: unknown) => Promise<Response>) => {
      const primera = await fn(pase);
      expect(primera.status).toBe(401);
      return fn(pase);
    });
    fetchMock.mockResolvedValueOnce(json(401, { code: 'invalid_token' }, { 'www-authenticate': 'Bearer' }))
      .mockResolvedValueOnce(json(201, recibido()));
    const r = await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO);
    expect(r.tipo).toBe('enviado');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const b1 = (fetchMock.mock.calls[0][1] as RequestInit).body;
    const b2 = (fetchMock.mock.calls[1][1] as RequestInit).body;
    expect(b1).not.toBe(b2);
  });

  it('401 que persiste tras la renovación → reintentable invalid_token (AC5)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 'invalid_token' }));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'reintentable', codigo: 'invalid_token', status: 401 });
  });

  it('200 con el mismo sha256 → enviado nuevo:false (AC8); sha256 distinto → reintentable', async () => {
    fetchMock.mockResolvedValueOnce(json(200, recibido()));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toMatchObject({ tipo: 'enviado', nuevo: false });
    fetchMock.mockResolvedValueOnce(json(201, recibido({ sha256: 'b'.repeat(64) })));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'reintentable', codigo: 'sha256_distinto', status: 201 });
  });

  it('404 sin cuerpo → pausa no_disponible; 404 problem procedure_not_found → definitivo', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'pausa', codigo: 'no_disponible', status: 404 });
    fetchMock.mockResolvedValueOnce(json(404, { code: 'procedure_not_found', detail: 'x' }));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'definitivo', motivo: 'procedure_not_found', status: 404 });
  });

  it('409 terminal:false → estacionar; 429 con Retry-After → espera', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'not_allowed_in_state', terminal: false, estado: 'borrador' }));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'estacionar', estadoFlit2: 'borrador' });
    fetchMock.mockResolvedValueOnce(json(429, { code: 'rate_limited' }, { 'retry-after': '17' }));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'espera', segundos: 17 });
  });

  it('red caída → reintentable red; los errores del pase se propagan (el cron los trata como pausa)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed https://flit2.ejemplo.test/api/v1/external/tramites/x/adjuntos'));
    expect(await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'reintentable', codigo: 'red', status: null });
    conPaseMock.mockRejectedValueOnce(new Flit2SinAccesoError());
    await expect(crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO)).rejects.toBeInstanceOf(Flit2SinAccesoError);
  });

  it('id de FLIT 2 que no es un segmento seguro → definitivo procedure_not_found SIN llamar', async () => {
    expect(await crearFlit2SyncHttp().enviarAdjunto('..', ARCHIVO)).toEqual({ tipo: 'definitivo', motivo: 'procedure_not_found', status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC9: el log no lleva la URL, el nombre de archivo ni el detail de FLIT 2; solo idFlit2, status y codigo', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'attachment_exists', detail: 'PLACA ZZZ001 ya tiene adjunto' }));
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed https://flit2.ejemplo.test/api/v1/external/tramites/x/adjuntos'));
    await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO);
    await crearFlit2SyncHttp().enviarAdjunto(ID, ARCHIVO);
    const volcado = JSON.stringify([...logMock.warn.mock.calls, ...logMock.info.mock.calls, ...logMock.error.mock.calls]);
    expect(volcado).not.toMatch(/adjuntos|flit2\.ejemplo|comprobante-impuesto|ZZZ001|PDF/);
    expect(logMock.warn).toHaveBeenCalledWith({ idFlit2: ID, status: 409, codigo: 'attachment_exists' }, expect.any(String));
  });
});

describe('HU #13268 · enviarAdjunto (fake, simulador)', () => {
  it('por defecto 201 con sha256 real; el mismo archivo otra vez → 200 idempotente (AC8); otro archivo → reemplazoDe', async () => {
    const fake = crearFlit2SyncFake([]);
    const a = await fake.enviarAdjunto(ID, ARCHIVO);
    expect(a).toMatchObject({ tipo: 'enviado', nuevo: true, recibido: { sha256: SHA, tipo: 'liquidacion_impuesto', reemplazoDe: null } });
    const b = await fake.enviarAdjunto(ID, ARCHIVO);
    expect(b).toMatchObject({ tipo: 'enviado', nuevo: false });
    if (a.tipo !== 'enviado' || b.tipo !== 'enviado') throw new Error('esperaba enviado');
    expect(b.recibido.adjuntoId).toBe(a.recibido.adjuntoId);
    const c = await fake.enviarAdjunto(ID, { ...ARCHIVO, bytes: Buffer.from('%PDF-otro') });
    expect(c).toMatchObject({ tipo: 'enviado', nuevo: true, recibido: { reemplazoDe: a.recibido.adjuntoId } });
    expect(fake.llamadasEnvio).toHaveLength(3);
    expect(fake.llamadasEnvio[0]).toEqual({ idFlit2: ID, contentType: 'application/pdf', nombreArchivo: 'comprobante-impuesto.pdf', tamano: BYTES.length, sha256: SHA });
  });

  it('guion por trámite: consume un desenlace por llamada y luego vuelve al defecto', async () => {
    const fake = crearFlit2SyncFake([]);
    fake.programarRespuestaAdjunto(ID, [{ tipo: 'pausa', codigo: 'no_disponible', status: 404 }]);
    expect(await fake.enviarAdjunto(ID, ARCHIVO)).toEqual({ tipo: 'pausa', codigo: 'no_disponible', status: 404 });
    expect((await fake.enviarAdjunto(ID, ARCHIVO)).tipo).toBe('enviado');
  });
});
