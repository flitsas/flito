// HU #13095 — factura de FLIT 2 para el paso «extracción» de impuestos. `descargarFacturaDeImpuesto`
// con `fuente = 'flit2'` pide la URL firmada al puerto de FLIT 2, la valida contra
// `FLIT2_ADJUNTOS_HOSTS` (fail-closed), la descarga sin `Authorization` y con `redirect: 'error'`, corta
// por stream al pasar el tope de FLIT 1 y pide OTRA URL una sola vez si la descarga falla. FLIT 1 no
// cambia (AC5). Ningún host real: todo es `.test`/`.invalid`. El logger es un espía: ningún log ni
// mensaje de error lleva la URL, la ruta, `expiraEn` ni `nombreArchivo`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const entorno = vi.hoisted(() => ({ hosts: ['almacen.ejemplo.test'] as string[] }));
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_ADJUNTOS_HOSTS') return entorno.hosts;
        return target[prop as string];
      },
    }),
  };
});
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
const selectMock = vi.hoisted(() => vi.fn());
const obtenerUrlFactura = vi.hoisted(() => vi.fn());
const obtenerUrlAdjunto = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-sync/flit.adapter.js', () => ({ getFlitAdapter: () => ({ obtenerUrlFactura }) }));
vi.mock('../../src/modules/flito-sync/flit2-sync.adapter.js', () => ({ getFlit2SyncAdapter: () => ({ obtenerUrlAdjunto }) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn() }));

const { descargarFacturaDeImpuesto, urlFirmadaPermitida, FacturaNoDisponibleError, TOPE_FACTURA_BYTES } =
  await import('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js');
const { Flit2NoRespondeError, Flit2RespuestaError, Flit2SinAccesoError } =
  await import('../../src/modules/flito-sync/flit2.errors.js');

const IMP = '00000000-0000-0000-0000-00000000000a';
const ID2 = '0192b7c4-5e6a-7d10-9f21-000000000001';
const ADJ = '0192b7c4-9a1b-7c2d-8e3f-4a5b6c7d8e9f';
const FIRMADA = 'https://almacen.ejemplo.test/f/factura.pdf?X-Amz-Signature=secreta-13095';
const FIRMADA_2 = 'https://almacen.ejemplo.test/f/factura.pdf?X-Amz-Signature=segunda-13095';
const adjunto = (url = FIRMADA) => ({ url, contentType: 'application/pdf', nombreArchivo: 'FV-777.pdf', expiraEn: '2026-09-29T15:10:00Z' });
const PDF = Buffer.from('%PDF-1.7 inventado');

function filas(v: unknown[]) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    from: () => c, innerJoin: () => c, where: () => c, limit: () => c,
    then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(v).then(res, rej),
  });
  return c;
}
// El mock no filtra columnas: `fuente`/`idFlit2` van explícitos en la fila (memoria: el `chain` inventa columnas).
const tramiteFlit2 = (facturaId: string | null = ADJ) => selectMock.mockReturnValue(filas([{ facturaId, fuente: 'flit2', idFlit2: ID2 }]));
const fetchMock = vi.fn();
const todoElLog = () => JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls));
const SECRETOS = /secreta-13095|segunda-13095|almacen\.ejemplo|FV-777|2026-09-29T15:10|X-Amz|adjuntos\//;

async function motivo(p: Promise<unknown>): Promise<string> {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(FacturaNoDisponibleError);
  expect(String(e.message)).not.toMatch(SECRETOS);
  return (e as InstanceType<typeof FacturaNoDisponibleError>).motivo;
}

/** Cuerpo por stream de `total` bytes en trozos de 1 MB, sin content-length; cuenta lo entregado. */
function cuerpoGrande(total: number) {
  const trozo = new Uint8Array(1024 * 1024);
  const estado = { entregado: 0, cancelado: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (estado.entregado >= total) { ctrl.close(); return; }
      estado.entregado += trozo.byteLength;
      ctrl.enqueue(trozo);
    },
    cancel() { estado.cancelado = true; },
  });
  return { resp: new Response(stream, { status: 200 }), estado };
}

beforeEach(() => {
  entorno.hosts = ['almacen.ejemplo.test'];
  for (const m of [selectMock, obtenerUrlFactura, obtenerUrlAdjunto, fetchMock, ...Object.values(logMock)]) m.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  obtenerUrlAdjunto.mockResolvedValue(adjunto());
  fetchMock.mockImplementation(async () => new Response(new Uint8Array(PDF), { status: 200 }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('HU #13095 · AC2 — descarga de FLIT 2', () => {
  it('pide la URL con el adjuntoId GUARDADO, descarga sin Authorization y con redirect error, y tipa por bytes', async () => {
    tramiteFlit2();
    const r = await descargarFacturaDeImpuesto(IMP);
    expect(r.bytes.equals(PDF)).toBe(true);
    expect(r.contentType).toBe('application/pdf');
    expect(obtenerUrlAdjunto).toHaveBeenCalledExactlyOnceWith(ID2, ADJ);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FIRMADA);
    expect(init.redirect).toBe('error');
    expect(init.headers).toBeUndefined();
    expect(JSON.stringify(init)).not.toMatch(/Authorization/i);
    expect(obtenerUrlFactura).not.toHaveBeenCalled();
    expect(todoElLog()).not.toMatch(SECRETOS);
  });

  it('content-length por encima del tope → tope, sin reintento', async () => {
    tramiteFlit2();
    fetchMock.mockResolvedValue(new Response(new Uint8Array(PDF), { status: 200, headers: { 'content-length': String(TOPE_FACTURA_BYTES + 1) } }));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('tope');
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(1);
  });

  it('sin content-length y 20 MB por stream → tope, cortando la lectura antes de consumir los 20 MB', async () => {
    tramiteFlit2();
    const { resp, estado } = cuerpoGrande(20 * 1024 * 1024);
    fetchMock.mockResolvedValue(resp);
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('tope');
    expect(estado.cancelado).toBe(true);
    expect(estado.entregado).toBeLessThan(20 * 1024 * 1024);
    expect(estado.entregado).toBeLessThanOrEqual(TOPE_FACTURA_BYTES + 2 * 1024 * 1024);
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(1);
  });

  it('justo en el tope por stream → se acepta', async () => {
    tramiteFlit2();
    const { resp } = cuerpoGrande(TOPE_FACTURA_BYTES);
    fetchMock.mockResolvedValue(resp);
    const r = await descargarFacturaDeImpuesto(IMP);
    expect(r.bytes.length).toBe(TOPE_FACTURA_BYTES);
  });

  it('1.ª descarga falla (403 de URL vencida) → pide OTRA URL una sola vez y descarga con ella', async () => {
    tramiteFlit2();
    obtenerUrlAdjunto.mockResolvedValueOnce(adjunto(FIRMADA)).mockResolvedValueOnce(adjunto(FIRMADA_2));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(PDF), { status: 200 }));
    const r = await descargarFacturaDeImpuesto(IMP);
    expect(r.bytes.equals(PDF)).toBe(true);
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([FIRMADA, FIRMADA_2]);
    expect(todoElLog()).not.toMatch(SECRETOS);
  });

  it('dos descargas fallidas → http_xxx, con 2 URLs pedidas como máximo', async () => {
    tramiteFlit2();
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('http_503');
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dos fallos de red → descarga, sin el mensaje del fetch (lleva la URL) en logs', async () => {
    tramiteFlit2();
    fetchMock.mockImplementation(async () => { throw new TypeError(`fetch failed ${FIRMADA}`); });
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('descarga');
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(2);
    expect(todoElLog()).not.toMatch(SECRETOS);
  });
});

describe('HU #13095 · AC3 — 404 y errores del endpoint de la URL (D6)', () => {
  it('404 → null → url_nula, igual que FLIT 1, sin descargar', async () => {
    tramiteFlit2();
    obtenerUrlAdjunto.mockResolvedValue(null);
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('url_nula');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('429 → http_429 con UNA sola llamada, y se loguea reintentarEnS', async () => {
    tramiteFlit2();
    obtenerUrlAdjunto.mockRejectedValue(new Flit2RespuestaError(429, 'rate_limited', 30));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('http_429');
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(1);
    expect(todoElLog()).toMatch(/"reintentarEnS":30/);
  });

  it('401 que persiste → http_401; 500 → http_500', async () => {
    tramiteFlit2();
    obtenerUrlAdjunto.mockRejectedValueOnce(new Flit2RespuestaError(401, null));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('http_401');
    obtenerUrlAdjunto.mockRejectedValueOnce(new Flit2RespuestaError(500, null));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('http_500');
  });

  it('timeout del endpoint → descarga; pase inutilizable → flit2_acceso', async () => {
    tramiteFlit2();
    obtenerUrlAdjunto.mockRejectedValueOnce(new Flit2NoRespondeError());
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('descarga');
    obtenerUrlAdjunto.mockRejectedValueOnce(new Flit2SinAccesoError());
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('flit2_acceso');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un error que no es de FLIT 2 se relanza tal cual', async () => {
    tramiteFlit2();
    const raro = new RangeError('otro');
    obtenerUrlAdjunto.mockRejectedValue(raro);
    await expect(descargarFacturaDeImpuesto(IMP)).rejects.toBe(raro);
  });
});

describe('HU #13095 · D7 — allowlist de la URL firmada (SSRF)', () => {
  it.each([
    ['lista vacía', [] as string[], FIRMADA],
    ['http', ['almacen.ejemplo.test'], 'http://almacen.ejemplo.test/f.pdf'],
    ['host distinto', ['almacen.ejemplo.test'], 'https://otro.ejemplo.test/f.pdf'],
    ['sufijo del host', ['almacen.ejemplo.test'], 'https://almacen.ejemplo.test.evil.invalid/f.pdf'],
    ['subdominio', ['almacen.ejemplo.test'], 'https://x.almacen.ejemplo.test/f.pdf'],
    ['credenciales', ['almacen.ejemplo.test'], 'https://u:p@almacen.ejemplo.test/f.pdf'],
    ['solo usuario', ['almacen.ejemplo.test'], 'https://u@almacen.ejemplo.test/f.pdf'],
    ['puerto no listado', ['almacen.ejemplo.test'], 'https://almacen.ejemplo.test:8443/f.pdf'],
    ['no es URL', ['almacen.ejemplo.test'], 'no-es-url'],
  ])('%s → rechaza', (_n, hosts, url) => {
    expect(urlFirmadaPermitida(url, hosts)).toBe(false);
  });

  it.each([
    ['exacto', ['almacen.ejemplo.test'], FIRMADA],
    ['mayúsculas', ['almacen.ejemplo.test'], 'https://ALMACEN.Ejemplo.test/f.pdf'],
    ['443 explícito', ['almacen.ejemplo.test'], 'https://almacen.ejemplo.test:443/f.pdf'],
    ['puerto listado', ['almacen.ejemplo.test:8443'], 'https://almacen.ejemplo.test:8443/f.pdf'],
    ['segundo de la lista', ['otro.test', 'almacen.ejemplo.test'], FIRMADA],
  ])('%s → acepta', (_n, hosts, url) => {
    expect(urlFirmadaPermitida(url, hosts)).toBe(true);
  });

  it.each([
    ['lista vacía (fail-closed)', [] as string[], FIRMADA],
    ['http', ['almacen.ejemplo.test'], 'http://almacen.ejemplo.test/f.pdf'],
    ['host distinto', ['almacen.ejemplo.test'], 'https://otro.ejemplo.test/f.pdf'],
    ['credenciales', ['almacen.ejemplo.test'], 'https://u:p@almacen.ejemplo.test/f.pdf'],
  ])('en la descarga: %s → host, SIN fetch al almacenamiento y SIN segunda URL', async (_n, hosts, url) => {
    entorno.hosts = hosts;
    tramiteFlit2();
    obtenerUrlAdjunto.mockResolvedValue(adjunto(url));
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('host');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(obtenerUrlAdjunto).toHaveBeenCalledTimes(1);
    expect(todoElLog()).not.toMatch(/otro\.ejemplo|u:p@|almacen\.ejemplo/);
  });
});

describe('HU #13095 · AC4 / AC5 — sin factura y FLIT 1 intacto', () => {
  it('AC4: trámite de FLIT 2 sin factura → sin_factura, sin pedir URL (igual que FLIT 1)', async () => {
    tramiteFlit2(null);
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('sin_factura');
    expect(obtenerUrlAdjunto).not.toHaveBeenCalled();
  });

  it('AC5: fuente flit sigue por getFlitAdapter().obtenerUrlFactura, nunca por obtenerUrlAdjunto ni la allowlist', async () => {
    entorno.hosts = []; // FLIT 1 no pasa por la allowlist: con la lista vacía sigue descargando
    selectMock.mockReturnValue(filas([{ facturaId: 'FV-1', fuente: 'flit', idFlit2: null }]));
    obtenerUrlFactura.mockResolvedValue('https://flit.example.invalid/factura.pdf?X-Amz-Signature=f1');
    const r = await descargarFacturaDeImpuesto(IMP);
    expect(r.bytes.equals(PDF)).toBe(true);
    expect(obtenerUrlFactura).toHaveBeenCalledExactlyOnceWith('FV-1');
    expect(obtenerUrlAdjunto).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBeUndefined(); // FLIT 1: mismo fetch de siempre
  });

  it('AC5: FLIT 1 con URL nula sigue siendo url_nula y sin reintento', async () => {
    selectMock.mockReturnValue(filas([{ facturaId: 'FV-1', fuente: 'flit', idFlit2: null }]));
    obtenerUrlFactura.mockResolvedValue(null);
    expect(await motivo(descargarFacturaDeImpuesto(IMP))).toBe('url_nula');
    expect(obtenerUrlFactura).toHaveBeenCalledTimes(1);
  });
});
