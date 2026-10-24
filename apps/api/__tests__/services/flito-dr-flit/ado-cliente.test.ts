// HU #13804 — cliente de FLIT - SOPORTE: adaptador real con `fetch` mockeado (create OK, 203, no-JSON,
// timeout real, TF401289 → un reintento sin tag, 4xx/5xx/429, red) y sin fuga del PAT; y el simulado.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const {
  ClienteSoporteAdoReal, ClienteSoporteAdoSimulado, AdoNoDisponibleError, AdoRechazoError, urlCrearBug, PRIMER_NUMERO_SIMULADO,
  urlSubirAdjunto, URL_ADJUNTO_SIMULADO,
} = await import('../../../src/modules/flito-dr-flit/dr-flit-ado.client.js');

const PAT = 'pat-ultra-secreto-123';
const CFG = { orgUrl: 'https://dev.azure.com/flitsas', proyecto: 'FLIT - SOPORTE', pat: PAT, tipo: 'Bug', timeoutMs: 5000 };
const OPS = [
  { op: 'add' as const, path: '/fields/System.Title', value: '[ DR. FLIT FLITO ] x' },
  { op: 'add' as const, path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: '<p>correo ana@ejemplo.com</p>' },
  { op: 'add' as const, path: '/fields/System.Tags', value: 'FLITO; FLITO-PRUEBAS' },
];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number) => new Response('<html>Sign in to Azure DevOps</html>', { status, headers: { 'Content-Type': 'text/html' } });

function stub(...respuestas: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const f = vi.fn(async (_url: unknown, init: RequestInit) => {
    const r = respuestas.shift();
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(init);
    return r!;
  });
  vi.stubGlobal('fetch', f);
  return f;
}

/** El error no lleva PAT, URL, cuerpo ni cause. */
function sinFuga(e: unknown) {
  const visto = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''} ${String((e as { cause?: unknown }).cause ?? '')}`;
  expect(visto).not.toContain(PAT);
  expect(visto).not.toContain(Buffer.from(`:${PAT}`).toString('base64'));
  expect(visto).not.toContain('dev.azure.com');
  expect(visto).not.toContain('ana@ejemplo.com');
  expect((e as { cause?: unknown }).cause).toBeUndefined();
}

async function fallo(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('se esperaba un error');
}

afterEach(() => vi.unstubAllGlobals());

describe('ClienteSoporteAdoReal', () => {
  it('create OK: URL, cabeceras, redirect y timeout; solo lee `id`', async () => {
    const f = stub(json(200, { id: 13_950, url: 'https://dev.azure.com/x/_apis/wit/workItems/13950', _links: {} }));
    const r = await new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS });
    expect(r).toEqual({ numero: 13_950, tagOmitido: false });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://dev.azure.com/flitsas/FLIT%20-%20SOPORTE/_apis/wit/workitems/$Bug?api-version=7.1');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from(`:${PAT}`).toString('base64')}`);
    expect(h['Content-Type']).toBe('application/json-patch+json');
    expect(JSON.parse(String(init.body))).toEqual(OPS);
  });

  it('urlCrearBug con barra final en la organización no duplica la barra', () => {
    expect(String(urlCrearBug({ ...CFG, orgUrl: 'https://flitsas.visualstudio.com/' })))
      .toBe('https://flitsas.visualstudio.com/FLIT%20-%20SOPORTE/_apis/wit/workitems/$Bug?api-version=7.1');
  });

  it.each([
    ['203 (página de inicio de sesión)', () => html(203)],
    ['200 no-JSON', () => html(200)],
    ['200 JSON sin id', () => json(200, { value: [] })],
    ['401', () => json(401, { message: `token ${PAT} inválido` })],
    ['403', () => json(403, {})],
  ])('%s → AdoRechazoError ado-auth, sin fuga', async (_n, r) => {
    stub(r());
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect(e).toBeInstanceOf(AdoRechazoError);
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-auth');
    sinFuga(e);
  });

  it.each([
    [500, 'ado-5xx'], [503, 'ado-5xx'], [429, 'ado-429'],
  ] as const)('%i → AdoNoDisponibleError %s', async (status, clase) => {
    stub(json(status, { message: 'interno con ana@ejemplo.com' }));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect(e).toBeInstanceOf(AdoNoDisponibleError);
    expect((e as InstanceType<typeof AdoNoDisponibleError>).clase).toBe(clase);
    sinFuga(e);
  });

  it('400 sin TF401289 → ado-4xx, una sola llamada', async () => {
    const f = stub(json(400, { message: 'TF51535: campo inválido' }));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-4xx');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('timeout REAL (AbortSignal.timeout) → AdoNoDisponibleError timeout, sin fuga', async () => {
    stub((init) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    }));
    const e = await fallo(new ClienteSoporteAdoReal({ ...CFG, timeoutMs: 30 }).crearBug({ operaciones: OPS }));
    expect(e).toBeInstanceOf(AdoNoDisponibleError);
    expect((e as InstanceType<typeof AdoNoDisponibleError>).clase).toBe('timeout');
    expect(e.message).toBe('ADO no respondió a tiempo');
    sinFuga(e);
  });

  it('error de red / redirect rechazado → red', async () => {
    stub(new TypeError(`fetch failed https://dev.azure.com/flitsas ${PAT}`));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect((e as InstanceType<typeof AdoNoDisponibleError>).clase).toBe('red');
    sinFuga(e);
  });

  it('TF401289 → UN segundo create sin System.Tags; tagOmitido=true', async () => {
    const f = stub(
      json(400, { message: 'TF401289: The current user does not have permissions to create tags.' }),
      json(200, { id: 13_951 }),
    );
    const r = await new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS });
    expect(r).toEqual({ numero: 13_951, tagOmitido: true });
    expect(f).toHaveBeenCalledTimes(2);
    const segunda = JSON.parse(String(f.mock.calls[1]![1].body)) as Array<{ path: string }>;
    expect(segunda.map((o) => o.path)).toEqual(['/fields/System.Title', '/fields/Microsoft.VSTS.TCM.ReproSteps']);
  });

  // HU #13804 — en DEV, ADO devuelve TF401289 con HTTP 403 (no 400): antes se clasificaba como
  // ado-auth antes de mirar el cuerpo y el respaldo sin tags nunca corría (502 al radicar).
  it('HU #13804: 403 con TF401289 → UN segundo create sin System.Tags; tagOmitido=true', async () => {
    const f = stub(
      json(403, { message: 'TF401289: The current user does not have permissions to create tags.' }),
      json(200, { id: 13_952 }),
    );
    const r = await new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS });
    expect(r).toEqual({ numero: 13_952, tagOmitido: true });
    expect(f).toHaveBeenCalledTimes(2);
    const segunda = JSON.parse(String(f.mock.calls[1]![1].body)) as Array<{ path: string }>;
    expect(segunda.map((o) => o.path)).toEqual(['/fields/System.Title', '/fields/Microsoft.VSTS.TCM.ReproSteps']);
    expect(segunda.some((o) => o.path === '/fields/System.Tags')).toBe(false);
  });

  it('HU #13804: 403 sin TF401289 → ado-auth, sin segundo create', async () => {
    const f = stub(json(403, { message: 'TF400813: The user is not authorized to access this resource.' }));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect(e).toBeInstanceOf(AdoRechazoError);
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-auth');
    expect(f).toHaveBeenCalledTimes(1);
    sinFuga(e);
  });

  it('HU #13804: 403 TF401289 en el primero y en el segundo → ado-4xx tras exactamente dos llamadas', async () => {
    const f = stub(json(403, { message: 'TF401289' }), json(403, { message: 'TF401289' }));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-4xx');
    expect(f).toHaveBeenCalledTimes(2);
    sinFuga(e);
  });

  it('TF401289 dos veces → ado-4xx tras exactamente dos llamadas', async () => {
    const f = stub(json(400, { message: 'TF401289' }), json(400, { message: 'TF401289' }));
    const e = await fallo(new ClienteSoporteAdoReal(CFG).crearBug({ operaciones: OPS }));
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-4xx');
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('ClienteSoporteAdoSimulado', () => {
  it('sin red, números consecutivos desde 900000; sin título o detalle → ado-4xx', async () => {
    const f = stub();
    const c = new ClienteSoporteAdoSimulado('Microsoft.VSTS.TCM.ReproSteps');
    expect(await c.crearBug({ operaciones: OPS })).toEqual({ numero: PRIMER_NUMERO_SIMULADO, tagOmitido: false });
    expect((await c.crearBug({ operaciones: OPS })).numero).toBe(PRIMER_NUMERO_SIMULADO + 1);
    const e = await fallo(c.crearBug({ operaciones: OPS.slice(1) }));
    expect(e).toBeInstanceOf(AdoRechazoError);
    expect(f).not.toHaveBeenCalled();
  });
});

// ── HU #13805 — subida de adjuntos (RN-DRF-C5) ──────────────────────────────────────────────────
describe('subirAdjunto — adaptador real', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const URL_ADO = 'https://dev.azure.com/flitsas/_apis/wit/attachments/abc-123?fileName=adjunto-1.png';

  it('POST a /_apis/wit/attachments con fileName genérico, api-version 7.1 y octet-stream; devuelve solo la url', async () => {
    const f = stub(json(201, { id: 'abc-123', url: URL_ADO }));
    const r = await new ClienteSoporteAdoReal(CFG).subirAdjunto('adjunto-1.png', 'image/png', PNG);
    expect(r).toEqual({ url: URL_ADO });
    const [url, init] = f.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe('https://dev.azure.com/flitsas/FLIT%20-%20SOPORTE/_apis/wit/attachments?fileName=adjunto-1.png&api-version=7.1');
    expect(String(url)).toBe(String(urlSubirAdjunto(CFG, 'adjunto-1.png')));
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect(init.redirect).toBe('error');
    expect(Buffer.from(init.body as Uint8Array).equals(PNG)).toBe(true);
  });

  it('un nombre que no es genérico no sale (ado-4xx sin llamar a fetch)', async () => {
    const f = stub();
    const e = await fallo(new ClienteSoporteAdoReal(CFG).subirAdjunto('captura de Ana.png', 'image/png', PNG));
    expect((e as InstanceType<typeof AdoRechazoError>).clase).toBe('ado-4xx');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [() => html(203), AdoRechazoError, 'ado-auth'],
    [() => json(401, {}), AdoRechazoError, 'ado-auth'],
    [() => json(200, { id: 'x' }), AdoRechazoError, 'ado-auth'],
    [() => json(200, { url: 'http://inseguro/x' }), AdoRechazoError, 'ado-auth'],
    [() => json(413, { message: 'too big' }), AdoRechazoError, 'ado-4xx'],
    [() => json(429, {}), AdoNoDisponibleError, 'ado-429'],
    [() => json(503, {}), AdoNoDisponibleError, 'ado-5xx'],
    [() => new TypeError('fetch failed'), AdoNoDisponibleError, 'red'],
  ] as const)('respuesta %# → %o (%s), sin fuga del PAT ni de la URL', async (r, clase, codigo) => {
    stub(r());
    const e = await fallo(new ClienteSoporteAdoReal(CFG).subirAdjunto('adjunto-2.pdf', 'application/pdf', PNG));
    expect(e).toBeInstanceOf(clase);
    expect((e as { clase: string }).clase).toBe(codigo);
    sinFuga(e);
  });
});

describe('subirAdjunto — simulado', () => {
  it('sin red, url falsa en dominio .invalid; vacío o nombre no genérico → ado-4xx', async () => {
    const f = stub();
    const c = new ClienteSoporteAdoSimulado('Microsoft.VSTS.TCM.ReproSteps');
    expect(await c.subirAdjunto('adjunto-1.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff])))
      .toEqual({ url: `${URL_ADJUNTO_SIMULADO}1` });
    expect((await c.subirAdjunto('adjunto-2.pdf', 'application/pdf', Buffer.from('%PDF-'))).url).toBe(`${URL_ADJUNTO_SIMULADO}2`);
    expect(URL_ADJUNTO_SIMULADO).toMatch(/^https:\/\/[^/]+\.invalid\//);
    await expect(c.subirAdjunto('adjunto-3.pdf', 'application/pdf', Buffer.alloc(0))).rejects.toBeInstanceOf(AdoRechazoError);
    await expect(c.subirAdjunto('mi-cedula.pdf', 'application/pdf', Buffer.from('%PDF-'))).rejects.toBeInstanceOf(AdoRechazoError);
    expect(f).not.toHaveBeenCalled();
  });
});
