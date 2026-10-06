// HU #13310 (Feature #13309, ADR-0021) — envío del comprobante de pago a FLIT 1: funciones puras
// (`flit1-adjuntos.ts`) y adaptador HTTP de tres pasos (`flit1-adjuntos.http.ts`) con `fetch` espiado.
// Datos sintéticos: hosts `*.ejemplo.test`, bucket `flito-ejemplo.s3.us-east-1.amazonaws.com`.
// TCs: docs/qa/hu-13310-tcs.md (AC1, AC2, AC4-AC6, AC9 + ajustes A-1/A-2/A-3 de la aprobación).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const puras = await import('../../src/modules/flito-sync/flit1-adjuntos.js');
const { crearFlit1AdjuntosHttp } = await import('../../src/modules/flito-sync/flit1-adjuntos.http.js');

const ARCHIVOS = 'https://flit1-archivos.ejemplo.test';
const TRAMITES = 'https://flit1-tramites.ejemplo.test/dev';
const SUBIDA = 'https://flito-ejemplo.s3.us-east-1.amazonaws.com/';
const IMP = '11111111-1111-4111-8111-111111111111';
const PDF = Buffer.from('%PDF-1.4 comprobante sintetico');
const FIELDS = {
  key: `impuestos-flito/impuesto-${IMP}.pdf`, 'Content-Type': 'application/pdf', bucket: 'flito-ejemplo',
  'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'CREDSECRETA', 'X-Amz-Date': '20261006T150000Z',
  Policy: 'POLICYSECRETA', 'X-Amz-Signature': 'SIGSECRETA',
};
const archivo = { bytes: PDF, contentType: 'application/pdf' as const, filename: `impuesto-${IMP}.pdf` };

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });
const p1Ok = (id = 'adj-777', url = SUBIDA) => json({ id, presignedUrl: { url, fields: FIELDS }, s3Details: { bucket: 'flito-ejemplo' } });
const vacio = (status: number) => new Response(null, { status });

type Paso = Response | Error;
let fetchMock: ReturnType<typeof vi.fn>;
function programar(...pasos: Paso[]) {
  const cola = [...pasos];
  fetchMock = vi.fn(async () => {
    const r = cola.shift();
    if (!r) throw new Error('fetch inesperado');
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
}
const llamada = (i: number) => fetchMock.mock.calls[i] as [string, RequestInit];
const adapter = () => crearFlit1AdjuntosHttp({ archivosBase: ARCHIVOS, tramitesBase: TRAMITES });
const logs = () => JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls]);

beforeEach(() => { for (const m of Object.values(logMock)) m.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

// ── Puras ────────────────────────────────────────────────────────────────────────────────────────
describe('AC2 — idRealDeIdFlit (TC-02a/b/d, A-3)', () => {
  it.each(['FLIT-012345', 'FLIT-022345', 'FLIT-042345'])('TC-02a: %s → 2345 (sin el prefijo FLIT-0x)', (id) => {
    expect(puras.idRealDeIdFlit(id)).toBe('2345');
  });
  it('TC-02d (A-3): ceros a la izquierda fuera — FLIT-010045 → 45, FLIT-0100042 → 42', () => {
    expect(puras.idRealDeIdFlit('FLIT-010045')).toBe('45');
    expect(puras.idRealDeIdFlit('FLIT-0100042')).toBe('42');
  });
  it.each([
    'FLIT-032345', '12345', 'FLIT-01', 'FLIT-01234A', 'flit-012345', ' FLIT-012345', 'FLIT-012345 ', 'FLIT-0100', 'FLIT-01000', '',
  ])('TC-02b: %j es inválido (null)', (id) => {
    expect(puras.idRealDeIdFlit(id)).toBeNull();
  });
  it('TC-02b: null/undefined → null', () => {
    expect(puras.idRealDeIdFlit(null)).toBeNull();
    expect(puras.idRealDeIdFlit(undefined)).toBeNull();
  });
});

describe('D-8 — baseFlit1Valida', () => {
  it('https con o sin path de stage; recorta la barra final', () => {
    expect(puras.baseFlit1Valida('https://flit1-archivos.ejemplo.test')).toBe('https://flit1-archivos.ejemplo.test');
    expect(puras.baseFlit1Valida('https://flit1-tramites.ejemplo.test/dev/')).toBe('https://flit1-tramites.ejemplo.test/dev');
  });
  it.each([undefined, '', '   ', 'http://flit1.ejemplo.test', 'https://u:p@flit1.ejemplo.test', 'https://flit1.ejemplo.test?x=1', 'https://flit1.ejemplo.test#h', 'no-es-url'])(
    '%j → null (envío apagado)', (v) => { expect(puras.baseFlit1Valida(v as string | undefined)).toBeNull(); });
});

describe('A-1 — urlSubidaFlit1Permitida (validación fija, sin variable)', () => {
  it.each([SUBIDA, 'https://flito-ejemplo.s3.amazonaws.com/', 'https://FLITO-EJEMPLO.S3.AMAZONAWS.COM/x?X-Amz-Signature=1', 'https://x.s3.amazonaws.com:443/'])('%s pasa', (u) => {
    expect(puras.urlSubidaFlit1Permitida(u)).not.toBeNull();
  });
  it.each([
    'https://evilamazonaws.com/', 'https://amazonaws.com/', 'http://flito-ejemplo.s3.amazonaws.com/',
    'https://u:p@flito-ejemplo.s3.amazonaws.com/', 'https://flito-ejemplo.s3.amazonaws.com.evil.test/',
    'https://bucket.ejemplo.test/subida', 'https://x.s3.amazonaws.com:8443/', 'no-url', 42, null,
  ])('%j NO pasa', (u) => { expect(puras.urlSubidaFlit1Permitida(u)).toBeNull(); });
});

describe('D-7 — parsearRespuestaArchivo', () => {
  it('conserva los fields en el orden recibido', () => {
    const r = puras.parsearRespuestaArchivo({ id: 'adj-1', presignedUrl: { url: SUBIDA, fields: FIELDS } })!;
    expect(r.id).toBe('adj-1');
    expect(r.fields.map(([k]) => k)).toEqual(Object.keys(FIELDS));
  });
  it.each([
    null, [], { id: '' }, { id: 1, presignedUrl: { url: SUBIDA, fields: {} } }, { id: 'a', presignedUrl: null },
    { id: 'a', presignedUrl: { url: '', fields: {} } }, { id: 'a', presignedUrl: { url: SUBIDA, fields: [] } },
    { id: 'a', presignedUrl: { url: SUBIDA, fields: { k: 1 } } }, { id: 'x'.repeat(101), presignedUrl: { url: SUBIDA, fields: {} } },
  ])('%j → null', (c) => { expect(puras.parsearRespuestaArchivo(c)).toBeNull(); });
});

describe('A-2 — clasificarStatusFlit1', () => {
  it('429 y 5xx → reintentable en cualquier paso', () => {
    for (const paso of [1, 2, 3] as const) for (const s of [429, 500, 502, 503]) expect(puras.clasificarStatusFlit1(paso, s, null)).toBe('reintentable');
  });
  it('403/404 de un host FLIT1_* (pasos 1 y 3) sin cuerpo, no JSON o con el mensaje de API Gateway → pausa', () => {
    for (const paso of [1, 3] as const) {
      for (const s of [403, 404]) {
        expect(puras.clasificarStatusFlit1(paso, s, '')).toBe('pausa');
        expect(puras.clasificarStatusFlit1(paso, s, '<html>Forbidden</html>')).toBe('pausa');
        expect(puras.clasificarStatusFlit1(paso, s, '{"message":"Missing Authentication Token"}')).toBe('pausa');
        expect(puras.clasificarStatusFlit1(paso, s, '{"message":"Forbidden"}')).toBe('pausa');
      }
    }
  });
  it('403/404 con cuerpo JSON propio, o en el paso 2 (S3), y el resto de 4xx → definitivo', () => {
    expect(puras.clasificarStatusFlit1(3, 404, '{"message":"PROPIETARIO PRUEBA 1000000000"}')).toBe('definitivo');
    expect(puras.clasificarStatusFlit1(3, 404, '{"message":"Forbidden","code":"X"}')).toBe('definitivo');
    expect(puras.clasificarStatusFlit1(2, 403, '')).toBe('definitivo');
    expect(puras.clasificarStatusFlit1(1, 404, null)).toBe('definitivo'); // cuerpo ilegible o > tope
    for (const s of [400, 401, 409, 413, 422]) expect(puras.clasificarStatusFlit1(1, s, '')).toBe('definitivo');
  });
});

// ── Adaptador HTTP ───────────────────────────────────────────────────────────────────────────────
describe('AC1 — adaptador: tres pasos', () => {
  it('TC-01a/b/c/e: P1 → P2 → P3 en orden, con los cuerpos del contrato y redirect:error + timeout en los tres', async () => {
    programar(p1Ok(), vacio(204), json({ ok: true }));
    const r = await adapter().enviarComprobante('2345', archivo, null);
    expect(r).toEqual({ tipo: 'enviado', archivoId: 'adj-777', status: 200 });
    expect(fetchMock.mock.calls.map(([u, i]) => [(i as RequestInit).method, u])).toEqual([
      ['POST', `${ARCHIVOS}/api/v1/files`], ['POST', SUBIDA], ['PUT', `${TRAMITES}/api/v1/vehicleTaxesQuery/2345`],
    ]);
    // TC-01b: filename y categoría.
    expect(JSON.parse(String(llamada(0)[1].body))).toEqual({ filename: `impuesto-${IMP}.pdf`, category: 'impuestos-flito' });
    // TC-01c: todos los fields en orden y `file` ÚLTIMA parte, con los bytes y el MIME real.
    const form = llamada(1)[1].body as FormData;
    expect([...form.keys()]).toEqual([...Object.keys(FIELDS), 'file']);
    for (const [k, v] of Object.entries(FIELDS)) expect(form.get(k)).toBe(v);
    const file = form.get('file') as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(file.type).toBe('application/pdf');
    expect(file.name).toBe(`impuesto-${IMP}.pdf`);
    // TC-01e: el id va solo en idAttachedPaymentReceipt; los otros dos, cadena vacía (no null, no ausentes).
    expect(JSON.parse(String(llamada(2)[1].body))).toStrictEqual({ idAttachmentPdfDraft: '', idAttachmentPdfPrepared: '', idAttachedPaymentReceipt: 'adj-777' });
    for (let i = 0; i < 3; i++) {
      expect(llamada(i)[1].redirect).toBe('error');
      expect(llamada(i)[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('AC5: con archivoIdSubido hace SOLO el PUT', async () => {
    programar(json({}));
    expect(await adapter().enviarComprobante('2345', archivo, 'adj-777')).toMatchObject({ tipo: 'enviado', archivoId: 'adj-777' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(llamada(0)[0]).toBe(`${TRAMITES}/api/v1/vehicleTaxesQuery/2345`);
  });

  it('timeouts por paso: 10/60/15 s', () => {
    expect(puras.TIMEOUTS_FLIT1_MS).toEqual({ 1: 10_000, 2: 60_000, 3: 15_000 });
  });
});

describe('AC4 / AC5 / AC6 — clasificación por paso', () => {
  it.each([
    ['P1 503', [vacio(503)], { tipo: 'reintentable', paso: 1, codigo: 'http_503', status: 503, archivoId: null }],
    ['P1 429', [vacio(429)], { tipo: 'reintentable', paso: 1, codigo: 'http_429', status: 429, archivoId: null }],
    ['P1 red', [new TypeError('fetch failed')], { tipo: 'reintentable', paso: 1, codigo: 'red', status: null, archivoId: null }],
    ['P2 500', [p1Ok(), vacio(500)], { tipo: 'reintentable', paso: 2, codigo: 'http_500', status: 500, archivoId: null }],
    ['P2 red', [p1Ok(), new TypeError('fetch failed')], { tipo: 'reintentable', paso: 2, codigo: 'red', status: null, archivoId: null }],
    ['P3 503', [p1Ok(), vacio(204), vacio(503)], { tipo: 'reintentable', paso: 3, codigo: 'http_503', status: 503, archivoId: 'adj-777' }],
    ['P3 429', [p1Ok(), vacio(204), vacio(429)], { tipo: 'reintentable', paso: 3, codigo: 'http_429', status: 429, archivoId: 'adj-777' }],
    ['P3 red', [p1Ok(), vacio(204), new TypeError('fetch failed')], { tipo: 'reintentable', paso: 3, codigo: 'red', status: null, archivoId: 'adj-777' }],
  ] as Array<[string, Paso[], unknown]>)('%s', async (_n, pasos, esperado) => {
    programar(...pasos);
    expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual(esperado);
  });

  it('D-7: P1 2xx malformado o > 64 KiB → reintentable respuesta_invalida, sin seguir al paso 2', async () => {
    programar(json({ id: 'adj-1' }));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toMatchObject({ tipo: 'reintentable', paso: 1, codigo: 'respuesta_invalida' });
    programar(new Response('{"id":"a","x":"' + 'x'.repeat(70 * 1024) + '"}', { status: 200 }));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toMatchObject({ tipo: 'reintentable', paso: 1, codigo: 'respuesta_invalida' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const conCuerpo = (s: number) => json({ message: 'PROPIETARIO PRUEBA 1000000000' }, s);
  it.each([400, 403, 404, 413, 422])('TC-06a: %i con cuerpo propio → definitivo con su paso (P1, P2, P3); id solo en P3', async (s) => {
    programar(conCuerpo(s));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual({ tipo: 'definitivo', paso: 1, codigo: `http_${s}`, status: s, archivoId: null });
    programar(p1Ok(), conCuerpo(s));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual({ tipo: 'definitivo', paso: 2, codigo: `http_${s}`, status: s, archivoId: null });
    programar(p1Ok(), vacio(204), conCuerpo(s));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual({ tipo: 'definitivo', paso: 3, codigo: `http_${s}`, status: s, archivoId: 'adj-777' });
    expect(logs()).not.toMatch(/PROPIETARIO|1000000000/);
  });
});

describe('Ajustes A-1 / A-2 — pausa de configuración', () => {
  it.each(['https://evilamazonaws.com/', 'http://flito-ejemplo.s3.amazonaws.com/', 'https://u:p@flito-ejemplo.s3.amazonaws.com/', 'https://bucket.ejemplo.test/subida'])(
    'A-1: presignedUrl %s → pausa url_subida_no_permitida; NO se sube nada', async (u) => {
      programar(p1Ok('adj-777', u));
      expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual({ tipo: 'pausa', paso: 2, codigo: 'url_subida_no_permitida', status: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(logs()).not.toContain(u);
    });

  it.each([
    ['P1 404 sin cuerpo', [vacio(404)], 1, 404],
    ['P1 403 Missing Authentication Token', [json({ message: 'Missing Authentication Token' }, 403)], 1, 403],
    ['P3 403 Forbidden', [p1Ok(), vacio(204), json({ message: 'Forbidden' }, 403)], 3, 403],
    ['P3 404 no JSON', [p1Ok(), vacio(204), new Response('Not Found', { status: 404 })], 3, 404],
  ] as Array<[string, Paso[], number, number]>)('A-2: %s → pausa no_disponible', async (_n, pasos, paso, status) => {
    programar(...pasos);
    expect(await adapter().enviarComprobante('2345', archivo, null)).toEqual({ tipo: 'pausa', paso, codigo: 'no_disponible', status });
  });

  it('A-2 no aplica al paso 2 (S3): 403 sin cuerpo → definitivo', async () => {
    programar(p1Ok(), vacio(403));
    expect(await adapter().enviarComprobante('2345', archivo, null)).toMatchObject({ tipo: 'definitivo', paso: 2, status: 403 });
  });
});

describe('AC9 — el adaptador no deja salir la URL firmada ni los fields', () => {
  const SECRETOS = /flito-ejemplo\.s3|SIGSECRETA|POLICYSECRETA|CREDSECRETA|impuesto-1111/;
  const firmada = `${SUBIDA}?X-Amz-Signature=SIGSECRETA`;
  it.each([
    ['éxito', [p1Ok('adj-777', firmada), vacio(204), json({})]],
    ['P2 500', [p1Ok('adj-777', firmada), vacio(500)]],
    ['P2 403', [p1Ok('adj-777', firmada), new Response('<Error><Key>x</Key></Error>', { status: 403 })]],
    ['P2 red con la URL en el mensaje', [p1Ok('adj-777', firmada), new TypeError(`fetch failed: ${firmada}`)]],
  ] as Array<[string, Paso[]]>)('%s: ni logs ni desenlace llevan URL, fields ni filename', async (_n, pasos) => {
    programar(...pasos);
    const r = await adapter().enviarComprobante('2345', archivo, null);
    expect(JSON.stringify(r)).not.toMatch(SECRETOS);
    expect(logs()).not.toMatch(SECRETOS);
    expect(logMock.info).toHaveBeenCalled(); // control: el adaptador SÍ loguea (paso, status, código)
  });
});
