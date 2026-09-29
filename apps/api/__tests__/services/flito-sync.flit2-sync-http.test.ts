// HU #13091 (Feature #13059) — adaptador HTTP del feed de FLIT 2, mapeos puros y adaptador fake.
//
// El pase se sustituye (su RN-04 —renovar una vez ante 401— se prueba en `flito-sync.flit2-pase.test.ts`);
// aquí se afirma que la lectura pasa POR `conPase`, qué URL arma (cursor XOR since), cómo traduce los
// sobres rotos y que un ítem que no cumple el contrato se cuenta sin tumbar la página. `fetch` es un
// stub: ningún host real (el repo es público), el origen es un placeholder `.test`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const entorno = vi.hoisted(() => ({ base: 'https://flit2.ejemplo.test' as string | undefined, adapter: 'http' }));
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_BASE_URL') return entorno.base;
        if (prop === 'FLIT2_SYNC_ADAPTER') return entorno.adapter;
        return target[prop as string];
      },
    }),
  };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
const pase = vi.hoisted(() => ({ authorization: { unwrap: () => 'Bearer pase-de-prueba' }, scope: [], conPii: true, expiraEn: new Date(0) }));
const conPaseMock = vi.hoisted(() => vi.fn(async (fn: (p: unknown) => Promise<Response>) => fn(pase)));
const obtenerPaseMock = vi.hoisted(() => vi.fn(async () => pase));
vi.mock('../../src/modules/flito-sync/flit2-pase.service.js', () => ({ conPase: conPaseMock, obtenerPase: obtenerPaseMock }));
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { aItemFlit2, crearFlit2SyncHttp, urlDePagina } = await import('../../src/modules/flito-sync/flit2-sync-http.adapter.js');
const { crearFlit2SyncFake } = await import('../../src/modules/flito-sync/flit2-sync-fake.adapter.js');
const { estadoDesdeFlit2, familiaATipoTramite, rawSinPii, tipoPropiedadPorConteo } = await import('../../src/modules/flito-sync/flit2-mapeo.js');
const { Flit2NoConfiguradoError, Flit2NoRespondeError, Flit2RespuestaError, Flit2SinAccesoError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');

const U1 = '0192b7c4-5e6a-7d10-9f21-000000000001';
const item = (over: Record<string, unknown> = {}) => ({
  id: U1, radicado: 'FT1-0001234', syncVersion: 10, eliminado: false, estado: 'asignado',
  tramite: { codigo: 'MATRICULA_NUEVA', nombre: 'Matrícula inicial', familia: 'MATRICULAS' },
  fechaCreacion: null, fechaAprobacion: null,
  vehiculo: {
    vin: '9FKTEST0000000001', placa: 'ZZZ001', marca: 'MARCA', linea: 'LINEA', carroceria: 'SUV', cilindraje: 2000,
    cilindrajeTexto: null, numeroMotor: 'MTR1', numeroSerie: 'SER1', tipoServicio: { codigo: 'PARTICULAR', nombre: 'Particular' },
  },
  organismo: { codigoTransito: '76520000', codigoSecretaria: '76520', ciudad: 'PALMIRA', nombre: 'SECRETARIA' },
  compradores: [{ ordinal: 1, porcentajeParticipacion: null, rolActor: 'comprador', tipoPersona: 'natural', tipoDocumento: 'CC',
    numeroDocumento: '1000000000', nombreCompleto: 'PERSONA EJEMPLO', direccion: 'CARRERA 4', ciudad: 'PALMIRA', celular: '3100000000', correo: 'p@ejemplo.test' }],
  factura: { adjuntoId: '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f' },
  companiaGestora: { nit: '901000000' },
  ...over,
});

const respuesta = (status: number, cuerpo: unknown) => new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), { status });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  entorno.base = 'https://flit2.ejemplo.test';
  entorno.adapter = 'http';
  conPaseMock.mockClear(); obtenerPaseMock.mockClear();
  for (const m of Object.values(logMock)) m.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('HU #13091 · adaptador HTTP', () => {
  it('since sin cursor, y cursor sin since (nunca los dos), con pageSize', () => {
    const conSince = urlDePagina('https://flit2.ejemplo.test', { since: new Date('2026-09-29T15:00:00Z') }, 500);
    expect(conSince.pathname).toBe('/api/v1/external/tramites/sync');
    expect(conSince.searchParams.get('since')).toBe('2026-09-29T15:00:00.000Z');
    expect(conSince.searchParams.has('cursor')).toBe(false);
    const conCursor = urlDePagina('https://flit2.ejemplo.test', { cursor: 'eyJ2IjoxfQ==' }, 500);
    expect(conCursor.searchParams.get('cursor')).toBe('eyJ2IjoxfQ==');
    expect(conCursor.searchParams.has('since')).toBe(false);
    expect(conCursor.searchParams.get('pageSize')).toBe('500');
  });

  it('pide la página vía conPase con el pase en Authorization y sin seguir redirecciones', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { items: [item()], nextCursor: 'c1', hasMore: false }));
    const p = await crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500);
    expect(conPaseMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('cursor=c0');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pase-de-prueba');
    expect(init.redirect).toBe('error');
    expect(p).toMatchObject({ nextCursor: 'c1', hasMore: false, invalidos: 0 });
    expect(p.items[0]).toMatchObject({ idFlit2: U1, radicado: 'FT1-0001234', syncVersion: 10, familia: 'MATRICULAS', companiaNit: '901000000' });
  });

  it('un ítem que no cumple el contrato se cuenta en invalidos y el resto de la página sigue', async () => {
    fetchMock.mockResolvedValue(respuesta(200, {
      items: [item(), { id: 'no-uuid', radicado: 'X', syncVersion: 1 }, item({ syncVersion: 1.5 }), item({ radicado: '' })],
      nextCursor: 'c1', hasMore: true,
    }));
    const p = await crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500);
    expect(p.items).toHaveLength(1);
    expect(p.invalidos).toBe(3);
  });

  it.each([
    ['400 invalid_cursor', respuesta(400, { type: 'https://x/errors/invalid_cursor', detail: 'CUERPO-SECRETO' }), 400, 'invalid_cursor'],
    ['429 sin cuerpo', respuesta(429, ''), 429, null],
    ['200 no JSON', respuesta(200, '<html>'), 200, null],
    ['200 sin nextCursor', respuesta(200, { items: [], hasMore: false }), 200, null],
  ])('%s → Flit2RespuestaError (502) con estado y código; el cuerpo no se loguea', async (_n, res, status, codigo) => {
    fetchMock.mockResolvedValue(res);
    const e = await crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Flit2RespuestaError);
    expect((e as InstanceType<typeof Flit2RespuestaError>).status).toBe(502);
    expect((e as InstanceType<typeof Flit2RespuestaError>).statusFlit2).toBe(status);
    expect((e as InstanceType<typeof Flit2RespuestaError>).codigoFlit2).toBe(codigo);
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain('CUERPO-SECRETO');
  });

  it('red caída → no_responde, sin la URL (lleva el cursor) en el log', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed https://flit2.ejemplo.test/?cursor=c0'));
    await expect(crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500)).rejects.toBeInstanceOf(Flit2NoRespondeError);
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain('cursor=');
  });

  it('los errores del pase (sin acceso…) se propagan tal cual', async () => {
    conPaseMock.mockRejectedValueOnce(new Flit2SinAccesoError());
    await expect(crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500)).rejects.toBeInstanceOf(Flit2SinAccesoError);
  });

  it('sin FLIT2_BASE_URL → no_configurado al usarse, sin llamar a nadie', async () => {
    entorno.base = undefined;
    await expect(crearFlit2SyncHttp().verificarAcceso()).rejects.toBeInstanceOf(Flit2NoConfiguradoError);
    await expect(crearFlit2SyncHttp().leerPagina({ cursor: 'c0' }, 500)).rejects.toBeInstanceOf(Flit2NoConfiguradoError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(obtenerPaseMock).not.toHaveBeenCalled();
  });
});

describe('HU #13091 · aItemFlit2 (normalización del ítem)', () => {
  it('vehículo: cilindraje int → texto; tipoServicio = nombre; VIN null/vacío/demasiado largo → sin vehículo', () => {
    expect(aItemFlit2(item())?.vehiculo).toMatchObject({ vin: '9FKTEST0000000001', cilindraje: '2000', tipoServicio: 'Particular' });
    expect(aItemFlit2(item({ vehiculo: { ...item().vehiculo, cilindraje: null, cilindrajeTexto: '1.6L' } }))?.vehiculo?.cilindraje).toBe('1.6L');
    expect(aItemFlit2(item({ vehiculo: null }))?.vehiculo).toBeNull();
    expect(aItemFlit2(item({ vehiculo: { ...item().vehiculo, vin: null } }))?.vehiculo).toBeNull();
    expect(aItemFlit2(item({ vehiculo: { ...item().vehiculo, vin: '  ' } }))?.vehiculo).toBeNull();
    expect(aItemFlit2(item({ vehiculo: { ...item().vehiculo, vin: '9FKTEST00000000000001' } }))?.vehiculo).toBeNull();
  });

  it('tombstone con payload mínimo es válido', () => {
    const t = aItemFlit2({ id: U1, radicado: 'FT1-0001234', syncVersion: 11, eliminado: true, estado: 'anulado', vehiculo: null, organismo: null, factura: null, compradores: [] });
    expect(t).toMatchObject({ eliminado: true, vehiculo: null, organismo: null, compradores: [] });
  });

  it('raw sin PII: compradores por lista blanca', () => {
    const raw = JSON.stringify(aItemFlit2(item())?.raw);
    for (const v of ['1000000000', 'PERSONA EJEMPLO', 'CARRERA 4', '3100000000', 'p@ejemplo.test']) expect(raw).not.toContain(v);
  });
});

describe('HU #13091 · mapeos puros', () => {
  it('estadoDesdeFlit2: comunes, revocado, retrocesos, desconocidos y otra grafía', () => {
    expect(estadoDesdeFlit2('aprobado')).toEqual({ estado: 'aprobado', flitEstado: 'Aprobado', desconocido: false });
    expect(estadoDesdeFlit2('revocado')).toEqual({ estado: 'anulado', flitEstado: 'Revocado', desconocido: false });
    expect(estadoDesdeFlit2('preasignacion')).toEqual({ estado: null, flitEstado: 'Preasignacion', desconocido: false });
    expect(estadoDesdeFlit2('APROBADO')).toEqual({ estado: null, flitEstado: 'APROBADO', desconocido: true });
    expect(estadoDesdeFlit2('toString')).toMatchObject({ estado: null, desconocido: true });
    expect(estadoDesdeFlit2(null)).toEqual({ estado: null, flitEstado: 'Desconocido', desconocido: true });
    expect(estadoDesdeFlit2('x'.repeat(80)).flitEstado).toHaveLength(60);
  });

  it('familiaATipoTramite exacto; tipoPropiedadPorConteo', () => {
    expect([familiaATipoTramite('MATRICULAS'), familiaATipoTramite('TRASPASO'), familiaATipoTramite('OTROS')]).toEqual(['Matricula', 'Traspaso', 'Otros']);
    expect([familiaATipoTramite('matriculas'), familiaATipoTramite(null)]).toEqual([null, null]);
    expect([tipoPropiedadPorConteo(0), tipoPropiedadPorConteo(1), tipoPropiedadPorConteo(3)]).toEqual([null, 'unico_propietario', 'multiple_propietario']);
  });

  it('rawSinPii: una clave nueva de comprador no entra (lista blanca, no negra)', () => {
    const r = rawSinPii({ id: U1, compradores: [{ ordinal: 1, rolActor: 'comprador', cedulaNueva: '123' }] });
    expect(r.compradores).toEqual([{ ordinal: 1, porcentajeParticipacion: null, rolActor: 'comprador', tipoPersona: null, tipoDocumento: null }]);
  });
});

describe('HU #13091 · adaptador fake', () => {
  it('sirve dos páginas ficticias por defecto y registra las llamadas', async () => {
    const fake = crearFlit2SyncFake();
    const p1 = await fake.leerPagina({ since: new Date('2026-09-29T15:00:00Z') }, 500);
    const p2 = await fake.leerPagina({ cursor: p1.nextCursor }, 500);
    expect(p1.hasMore).toBe(true);
    expect(p2.hasMore).toBe(false);
    expect(p1.items.length + p2.items.length).toBe(5);
    expect(fake.llamadas).toEqual([{ since: '2026-09-29T15:00:00.000Z', pageSize: 500 }, { cursor: 'fake-c1', pageSize: 500 }]);
    const p3 = await fake.leerPagina({ cursor: p2.nextCursor }, 500);
    expect(p3).toEqual({ items: [], invalidos: 0, nextCursor: 'fake-c2', hasMore: false });
  });
});
