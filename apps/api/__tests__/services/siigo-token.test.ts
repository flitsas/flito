// HU #11248 — autenticación y renovación del token de Siigo (Feature #11239).
//
// El objeto `env` se mockea porque `config/env.ts` valida con zod en el import: sin eso no se puede
// ejercer un Partner-Id inválido ni la ausencia de configuración.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const obtenerCredencialActivaMock = vi.fn();
vi.mock('../../src/modules/siigo/credenciales.service.js', () => ({
  obtenerCredencialActiva: obtenerCredencialActivaMock,
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { obtenerToken, invalidarTodos, SiigoAuthError } =
  await import('../../src/modules/siigo/siigo.token.js');
const { resolverConfig, configDisponible, SiigoConfigError } =
  await import('../../src/modules/siigo/siigo.config.js');
const { Redacted } = await import('../../src/shared/utils/crypto.js');

const ACCESS_KEY = 'clave-de-acceso-siigo';
const fetchMock = vi.fn();

function respuestaOk(body: unknown, status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  invalidarTodos();
  fetchMock.mockReset();
  obtenerCredencialActivaMock.mockReset();
  obtenerCredencialActivaMock.mockResolvedValue({
    id: 1, ambiente: 'pruebas', username: 'usuario@flitsas.com',
    accessKey: new Redacted(ACCESS_KEY),
  });
  envMock.SIIGO_PARTNER_ID = 'FlitoIntegracion';
  envMock.SIIGO_BASE_URL = 'https://api.siigo.test';
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AC1 — primera petición del día', () => {
  it('autentica una sola vez y devuelve el token', async () => {
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-123' }));

    const token = await obtenerToken('pruebas');

    expect(token).toBe('tok-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.siigo.test/auth');
    expect(init.method).toBe('POST');
  });

  it('envía usuario y access_key desenvuelto en el cuerpo', async () => {
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-123' }));
    await obtenerToken('pruebas');

    const cuerpo = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(cuerpo.username).toBe('usuario@flitsas.com');
    expect(cuerpo.access_key).toBe(ACCESS_KEY);
  });

  it('la autenticación también lleva Partner-Id', async () => {
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-123' }));
    await obtenerToken('pruebas');
    expect(fetchMock.mock.calls[0]![1].headers['Partner-Id']).toBe('FlitoIntegracion');
  });
});

describe('AC2 — el token vigente se reutiliza', () => {
  it('varias peticiones seguidas comparten token sin volver a autenticar', async () => {
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-abc' }));

    const a = await obtenerToken('pruebas');
    const b = await obtenerToken('pruebas');
    const c = await obtenerToken('pruebas');

    expect([a, b, c]).toEqual(['tok-abc', 'tok-abc', 'tok-abc']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('N renovaciones concurrentes disparan UNA sola autenticación', async () => {
    let resolver: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((res) => { resolver = res; }));

    const todas = Promise.all([
      obtenerToken('pruebas'), obtenerToken('pruebas'),
      obtenerToken('pruebas'), obtenerToken('pruebas'),
    ]);
    resolver(respuestaOk({ access_token: 'tok-unico' }));

    expect(await todas).toEqual(['tok-unico', 'tok-unico', 'tok-unico', 'tok-unico']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ambientes distintos NO comparten token', async () => {
    fetchMock
      .mockResolvedValueOnce(respuestaOk({ access_token: 'tok-pruebas' }))
      .mockResolvedValueOnce(respuestaOk({ access_token: 'tok-produccion' }));

    expect(await obtenerToken('pruebas')).toBe('tok-pruebas');
    expect(await obtenerToken('produccion')).toBe('tok-produccion');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC3 — renovación antes del vencimiento', () => {
  it('renueva de forma proactiva cuando el token entra en el margen', async () => {
    vi.useFakeTimers();
    // expires_in en segundos: 1 hora.
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-1', expires_in: 3600 }));
    await obtenerToken('pruebas');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A los 50 minutos aún es válido (margen de 5 min sobre 60).
    vi.advanceTimersByTime(50 * 60_000);
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-2', expires_in: 3600 }));
    expect(await obtenerToken('pruebas')).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A los 56 ya entró en el margen: renueva ANTES de que expire.
    vi.advanceTimersByTime(6 * 60_000);
    expect(await obtenerToken('pruebas')).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sin expires_in asume la vigencia documentada de 24 horas', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-24h' }));
    await obtenerToken('pruebas');

    // A las 23 horas sigue sirviendo el mismo token.
    vi.advanceTimersByTime(23 * 60 * 60_000);
    expect(await obtenerToken('pruebas')).toBe('tok-24h');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('con una vigencia muy corta el margen no deja el token vencido de nacimiento', async () => {
    vi.useFakeTimers();
    // 60 s de vigencia: si el margen fuera fijo de 5 min, renovaría en cada llamada.
    fetchMock.mockResolvedValue(respuestaOk({ access_token: 'tok-corto', expires_in: 60 }));
    await obtenerToken('pruebas');

    vi.advanceTimersByTime(10_000);
    expect(await obtenerToken('pruebas')).toBe('tok-corto');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forzarRenovacion descarta el token cacheado aunque siga vigente', async () => {
    fetchMock.mockResolvedValueOnce(respuestaOk({ access_token: 'tok-viejo' }));
    await obtenerToken('pruebas');

    fetchMock.mockResolvedValueOnce(respuestaOk({ access_token: 'tok-nuevo' }));
    expect(await obtenerToken('pruebas', { forzarRenovacion: true })).toBe('tok-nuevo');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('AC7 — credenciales inválidas', () => {
  it('un 401 en la autenticación da un mensaje accionable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    await expect(obtenerToken('pruebas')).rejects.toThrow(/rechazó las credenciales/);
  });

  it('el error de autenticación no contiene la clave de acceso', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    const err = await obtenerToken('pruebas').catch((e: Error) => e);
    expect(err).toBeInstanceOf(SiigoAuthError);
    expect((err as Error).message).not.toContain(ACCESS_KEY);
    expect(JSON.stringify(err)).not.toContain(ACCESS_KEY);
  });

  it('un 500 del servicio de autenticación se distingue de credenciales rechazadas', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    const err = await obtenerToken('pruebas').catch((e: SiigoAuthError) => e);
    expect((err as SiigoAuthError).status).toBe(500);
    expect((err as Error).message).toMatch(/respondió 500/);
  });

  it('una respuesta sin access_token no se cachea como válida', async () => {
    fetchMock.mockResolvedValue(respuestaOk({ token_type: 'Bearer' }));
    await expect(obtenerToken('pruebas')).rejects.toThrow(/no trae access_token/);
  });

  it('un fallo de red se reporta como error de autenticación, no como excepción cruda', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(obtenerToken('pruebas')).rejects.toThrow(/No se pudo contactar/);
  });

  it('un fallo al resolver la credencial se propaga sin enmascarar', async () => {
    obtenerCredencialActivaMock.mockRejectedValue(new Error('No hay credenciales activas'));
    await expect(obtenerToken('pruebas')).rejects.toThrow(/No hay credenciales activas/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tras un fallo el token no queda cacheado: el siguiente intento reintenta', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response);
    await expect(obtenerToken('pruebas')).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(respuestaOk({ access_token: 'tok-ok' }));
    expect(await obtenerToken('pruebas')).toBe('tok-ok');
  });
});

describe('AC4 — configuración del Partner-Id', () => {
  it('resuelve la configuración con un Partner-Id válido', () => {
    const c = resolverConfig();
    expect(c.partnerId).toBe('FlitoIntegracion');
    expect(c.ambiente).toBe('pruebas');
  });

  it('quita la barra final de la URL base para no producir rutas con doble barra', () => {
    envMock.SIIGO_BASE_URL = 'https://api.siigo.test/';
    expect(resolverConfig().baseUrl).toBe('https://api.siigo.test');
  });

  it('sin Partner-Id no se opera', () => {
    envMock.SIIGO_PARTNER_ID = '';
    expect(() => resolverConfig()).toThrow(SiigoConfigError);
    expect(() => resolverConfig()).toThrow(/SIIGO_PARTNER_ID no está configurado/);
  });

  it('rechaza un Partner-Id con espacios', () => {
    envMock.SIIGO_PARTNER_ID = 'Flito Integracion';
    expect(() => resolverConfig()).toThrow(/alfanuméricos/);
  });

  it('rechaza un Partner-Id con caracteres especiales', () => {
    envMock.SIIGO_PARTNER_ID = 'flito-integracion';
    expect(() => resolverConfig()).toThrow(/alfanuméricos/);
  });

  it('rechaza un Partner-Id más corto de 3 caracteres', () => {
    envMock.SIIGO_PARTNER_ID = 'ab';
    expect(() => resolverConfig()).toThrow(/alfanuméricos/);
  });

  it('rechaza un Partner-Id más largo de 100 caracteres', () => {
    envMock.SIIGO_PARTNER_ID = 'a'.repeat(101);
    expect(() => resolverConfig()).toThrow(/alfanuméricos/);
  });

  it('configDisponible informa sin lanzar', () => {
    expect(configDisponible()).toBe(true);
    envMock.SIIGO_PARTNER_ID = '';
    expect(configDisponible()).toBe(false);
  });
});
